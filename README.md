# gpu-queue

**One queue, with priorities, for every program that shares one small GPU.**

You have one graphics card with 8 GB of memory and several programs that want it: a vision model in Ollama that reads photos, a chat model behind a web page, ComfyUI drawing pictures, an upscaler, a background job embedding documents. Each one fits on the card alone, but no two of them fit together. When two start at once, one of them fails with "out of memory", or the card is left in a broken state until a restart.

gpu-queue sits between those programs and the card. Every piece of GPU work waits its turn in one queue. Before the card passes from one program to another, the program that held it is told to free its memory. You decide who goes first.

- **No more out-of-memory clashes.** Two models that don't fit together never run together.
- **Priorities.** A web page where someone is waiting goes before a batch job, and a batch job goes before bulk background work.
- **Nothing waits forever.** A job that waits 10 minutes moves up one level, so background work still gets the card between busy periods.
- **Programs that work in steps keep their turn.** A program that reads a photo, thinks on the CPU, then reads the next keeps first claim on the card for a short grace period after each step, so lower-priority work doesn't slip into every gap.
- **Fewer model reloads.** Loading a model costs 10–30 seconds, so the model already on the card is preferred for a while when others of the same priority wait.
- **A status page** that shows what holds the card, who is waiting and for how long, and how long each program usually waits. From it you can pause the queue, cancel a waiting job, or change a priority.
- **No changes to your apps.** Point their Ollama or ComfyUI address at the queue. Anything else (an upscaler, whisper, a training script) runs through a one-line wrapper.
- **No dependencies.** Plain Node.js 20 or newer, about 850 lines with the status page.

It was built for a home server with one GTX 1080: a book-scanning app, an image generator, a Wikipedia question page and a bulk PubMed embedder all share that one card.

## What it is not

It is not an inference server. Ollama and ComfyUI still load and run the models; gpu-queue only decides when. It doesn't split one card between programs (that is what NVIDIA MIG does on data-centre cards), and it doesn't spread work over several machines.

vLLM is a fast inference server for language models, but it doesn't queue other programs, and it doesn't run on older cards like the GTX 10 series.

## How it works

```
 your apps ──►  gpu-queue proxy (127.0.0.1:3890)  ──►  Ollama   (11434)
                    │                              ──►  ComfyUI  (8188)
 gpu-lease cmd ─────┘  (holds the card while the command runs)
                    │
                    └──  status page (127.0.0.1:3891)
```

Every request that needs the card becomes a job. A job belongs to a group: one Ollama model (`ollama:qwen3-vl:8b`), ComfyUI (`comfy`), or one leased command (`lease:upscaler`).

- **Jobs of the same group run side by side** (up to a limit per backend), because they share the model that is already loaded.
- **Jobs of different groups never overlap.** When the card goes to another group, gpu-queue waits for the running jobs to finish and frees the memory. Ollama's models are unloaded (`keep_alive: 0`) and ComfyUI is told to free its memory (`POST /free`). Then it waits until the card's memory is almost empty (read from `nvidia-smi`) before starting the next job.
- **Order:** priority first, then the group already on the card (for up to `batchSeconds`), then arrival time.
- **Grace period:** when the card goes idle, the group that just used it keeps first claim for `graceSeconds` against lower-priority work.
- **No preemption.** A running job is never stopped. A higher-priority job waits for the running ones to finish, but nothing new of a lower priority starts before it.

Requests that don't load a model go straight through: listing models, unloading one, or a model forced onto the CPU with `num_gpu: 0`.

### Ollama

Change the app's Ollama address from `http://127.0.0.1:11434` to:

```
http://127.0.0.1:3890/ollama/<app-name>
```

`<app-name>` is how the app appears on the status page and which priority it gets. Streaming answers stream as before. If the caller gives up while waiting, its job leaves the queue; if it gives up while running, the request to Ollama is closed, which stops the generation.

### ComfyUI

Change the app's ComfyUI address to:

```
http://127.0.0.1:3890/comfy/<app-name>
```

`POST /prompt` is answered at once with a `prompt_id`, as ComfyUI does, so callers with a short timeout on that call keep working. The prompt is handed to ComfyUI when its turn comes (with the same `prompt_id`, so `/history/<id>` and `/view` work as before). Until then `/history/<id>` returns `{}`, the same as for a prompt still pending in ComfyUI. If it can never run, `/history/<id>` returns an `execution_error` entry with the reason. `POST /queue {"delete": [...]}` also removes prompts still waiting in gpu-queue. The progress websocket goes straight through.

The card is held until ComfyUI no longer lists the prompt in its queue.

### Anything else: `gpu-lease`

```sh
gpu-lease -c upscaler -p background -- realesrgan-ncnn-vulkan -i in.jpg -o out.jpg
```

The command starts once the card is free. While it runs it holds the card alone: everything else waits, and the card was emptied before it started. When the command ends, or is killed, the card is given back, because the lease is the open connection itself. If the queue cannot be reached, the command runs anyway with a warning (`--strict` makes that an error).

From another language, the same thing is one HTTP call. `POST /lease?client=<name>&priority=<level>` answers `queued <id>`, then `granted <id>` when the card is yours. Keep the connection open while you work, then close it.

### Priorities

There are three levels: `interactive`, `normal` and `background`. A client's priority comes from, in order:

1. the `X-GPU-Priority` header on a request,
2. the status page (saved across restarts),
3. `clients` in `config.json`,
4. `normal`.

## Install

```sh
git clone https://github.com/amih/gpu-queue
cd gpu-queue
cp config.example.json config.json   # edit the clients
node server.js
npm test                             # tests run against a fake Ollama and ComfyUI
```

Environment:

| Variable | Default | |
|---|---|---|
| `GPUQ_PROXY_PORT` | `3890` | the port apps call |
| `PORT` | `3891` | the status page |
| `GPUQ_HOST` | `127.0.0.1` | both listen here only |
| `GPUQ_CONFIG` | `./config.json` | |
| `GPUQ_STATE_DIR` | `./data` | priorities and pause set on the status page |
| `GPU_QUEUE_URL` | `http://127.0.0.1:3890` | for `gpu-lease` |

`config.json`:

| Key | Default | |
|---|---|---|
| `ollama.url`, `comfy.url` | local defaults | where the real servers are |
| `ollama.concurrency` | `4` | requests of one model at once; match `OLLAMA_NUM_PARALLEL` |
| `comfy.concurrency` | `1` | prompts handed to ComfyUI at once |
| `ageStepSeconds` | `[0, 600, 600]` | seconds of waiting before `normal` and `background` jobs move up one level |
| `batchSeconds` | `300` | how long the loaded model is preferred while others wait |
| `graceSeconds` | `30` | after a job ends, its group keeps first claim this long against lower priorities |
| `emptyMiB` | `1200` | the card counts as empty below this much used memory, not counting the memory of the program taking over |
| `procMatch` | `{"ollama":"ollama","comfy":"comfy"}` | how to recognise each backend's processes in `nvidia-smi` |
| `clients` | | `{ "name": { "priority": "...", "note": "..." } }` |

### As a service

```ini
# /etc/systemd/system/gpu-queue.service
[Unit]
Description=gpu-queue
After=network.target ollama.service

[Service]
WorkingDirectory=/opt/gpu-queue
ExecStart=/usr/bin/node server.js
Environment=GPUQ_STATE_DIR=/var/lib/gpu-queue
StateDirectory=gpu-queue
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

The status page has no login of its own. It listens on 127.0.0.1, and if you publish it, put it behind your web server's login (for example nginx `auth_basic`). Its POST endpoints accept JSON only, so a plain form on another site cannot press its buttons.

## Things to know

- **Apps that skip the queue are not stopped.** gpu-queue only controls the requests that go through it. Point every app that uses the card at it, or run it through `gpu-lease`.
- **Timeouts.** Waiting for the card counts against an app's own request timeout. An app with a 2-minute timeout may give up while a 4-minute image is drawn. Give those apps a longer timeout, or a higher priority.
- **One card.** It assumes one GPU.
- **If gpu-queue stops,** apps that call it get "connection refused". Run it with `Restart=always`.

## License

MIT
