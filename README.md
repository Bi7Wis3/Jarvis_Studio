# Jarvis Studio

A local web app for building hardware projects by talking to an AI assistant. There are no menus: a 3D viewport,
a prompt bar and a microphone. Design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node 22, Python 3 and ffmpeg
- Claude Code installed and logged in on this machine (Jarvis runs through it; the project holds no API key)

## Setup and run

```bash
npm install
npm run setup:voice   # Piper voice (speech out)
npm run setup:stt     # faster-whisper model (speech in)
npm run dev
```

Open http://localhost:4719. Type, or hold **Talk** and speak. Esc stops Jarvis.
Without the voice or speech setup the app still works: it falls back to the browser's voice and hides the Talk button.

## Ports (all bound to 127.0.0.1)

| Port | What |
|---|---|
| 4719 | Web app (Vite), proxies `/api`, `/ws` and `/mcp` to the server |
| 4720 | Server: project store, tools, Jarvis, MCP |
| 4721 | Piper text-to-speech |
| 4722 | Whisper speech-to-text |

## Driving it from another AI client

Every app action is an MCP tool, served over Streamable HTTP at `http://127.0.0.1:4720/mcp`. With Claude Code:

```bash
claude mcp add --transport http jarvis-studio http://127.0.0.1:4720/mcp
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_MODEL` | `sonnet` | Claude model used for Jarvis in Fast mode |
| `JARVIS_EFFORT` | `medium` | Thinking effort in Fast mode (`low` is faster, `high` designs more carefully) |
| `JARVIS_QUALITY` | `fast` | Start in `best` mode (Opus, high effort); also switchable in the status chip |
| `JARVIS_STT_MODEL` | `base.en` | Whisper model |
| `JARVIS_PROJECTS_DIR` | `./projects` | Where projects and exports are saved |

## Checks

```bash
npm run typecheck
npm test
```
