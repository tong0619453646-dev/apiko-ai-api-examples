# APIKO MCP server

Use [APIKO](https://apiko.app) image and video models from Claude Code and Codex.
The server runs locally over stdio with your own APIKO API key: the agent can
look up models and request fields, quote a list price, generate images and
videos, follow tasks, check what the key has spent, and upload reference
images.

Generation is billed to your APIKO balance at API prices. The server tells the
agent to quote first and wait for your approval before every paid call.

## Requirements

- Node.js 18.17 or newer
- An APIKO API key from <https://apiko.app/dashboard/apikeys>

## Install

The server is published on npm as [`apiko-mcp`](https://www.npmjs.com/package/apiko-mcp)
and runs with `npx -y apiko-mcp`. To run it from source instead:

```bash
git clone <this repo> apiko-mcp
cd apiko-mcp
npm install
npm run build        # writes dist/index.js
```

and replace `npx -y apiko-mcp` below with
`node /absolute/path/to/apiko-mcp/dist/index.js`.

### Claude Code (CLI and desktop app)

```bash
claude mcp add apiko --scope user -e APIKO_API_KEY=sk-... -- npx -y apiko-mcp
```

`--scope user` stores the server in `~/.claude.json`, which the Claude Code
desktop app (Code tab) also loads. Run `/mcp` in Claude Code to check that
`apiko` is connected.

### Codex (CLI, IDE extension, desktop app)

```bash
codex mcp add apiko --env APIKO_API_KEY=sk-... -- npx -y apiko-mcp
```

or add this to `~/.codex/config.toml`, which the Codex CLI, the IDE extension
and the ChatGPT desktop app share:

```toml
[mcp_servers.apiko]
command = "npx"
args = ["-y", "apiko-mcp"]
env = { APIKO_API_KEY = "sk-..." }
```

If a desktop app reports that `node` or `npx` cannot be found, use the full
path from `which node`.

### Try it without spending anything

Add `APIKO_MCP_READ_ONLY=1` to the server's env (`-e APIKO_MCP_READ_ONLY=1` or
`--env APIKO_MCP_READ_ONLY=1`). The generate and upload tools are then hidden;
model lookup, quotes, task checks and the key's usage still work.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `APIKO_API_KEY` | required | Your APIKO key. Never paste it into a chat. |
| `APIKO_MCP_READ_ONLY` | off | `1` hides `generate_image`, `generate_video` and `upload_image`. |
| `APIKO_BASE_URL` | `https://api.apiko.app` | API base URL. |
| `APIKO_SITE_URL` | `https://apiko.app` | Where the public price catalog is read from. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | unset | Used only when set. Node's built-in fetch ignores them, so the server switches to a proxy-aware client when they are present. |

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `search_models` | free | Lists the models your key can use, with category, list price and modes. Filter by `query` and `category`. |
| `get_model` | free | One model's `input_schema` (fields, enums, defaults), endpoints, modes and price tiers. |
| `estimate_cost` | free | Validates an input against the schema and quotes the list price without submitting. |
| `generate_image` | **paid** | Generates, or edits when `input.images` has reference URLs. Runs async when the model supports it and waits up to `wait_seconds` (default 30). |
| `generate_video` | **paid** | Submits a video task (`POST /v1/videos`) and returns its `task_id`. |
| `get_task` | free | Status, progress, result URLs and failure reason of a task; can wait up to 45 s. |
| `check_balance` | free | What this key has spent and its own spending limit, if any. |
| `upload_image` | free | Uploads a local JPEG/PNG/WebP (or copies a public image URL) and returns a public `img.apiko.app` URL for reference fields. |

Typical flow: `search_models` → `get_model` → `upload_image` (if you have local
references) → `estimate_cost` → you approve → `generate_image` /
`generate_video` → `get_task`.

### Cost estimates

`estimate_cost` (and the generate tools' `cost` field) returns one of:

- `estimated`: a number, when the price follows directly from the input:
  per-image tiers chosen by `resolution` (or by an explicit `WxH` size for
  `gpt-image-2`), flat per-image prices, and per-second video prices by
  `resolution` × `duration`, including reference videos once you pass
  `reference_video_seconds`.
- `needs_input`: something the price depends on is missing, usually the total
  length of reference videos. You also get the range and the amount held from
  your balance at submission (`hold_usd`), which is refunded down to the real
  charge when the task settles.
- `token_billed`: billed by tokens (GPT Image 2.5 Flare / Sunburst, text
  models). An `indicative_usd` figure may be shown, but it is not a quote.
- `unknown`: no published price or no reliable rule; never treat it as free.

All figures are list prices in USD from the public catalog at apiko.app. The
gateway's charge at settlement is final. Failed tasks are refunded
automatically.

`max_cost_usd` on the generate tools refuses the call when the estimate, or its
guaranteed upper bound, is above the cap, or when no reliable figure exists.

### Billing notes

- Each `generate_*` call creates a paid task. Calling it again to check
  progress would pay twice; use `get_task`.
- `client_request_id` stops a repeated call from being submitted twice while
  the same server process is running. If a submission times out, the server
  does not retry it: check <https://apiko.app/dashboard/usage> first.
- Result links are signed and kept for 24 hours. Uploaded references are public
  to anyone with the link and are deleted after 72 hours.
- `check_balance` reads the key, not the account. Keys created on apiko.app
  have no limit of their own and draw on the account balance, which only the
  dashboard shows (<https://apiko.app/dashboard/billing>).
- Text models appear in `search_models`, but you call them through the
  OpenAI-compatible API at `https://api.apiko.app/v1`, not through this server.

## Timeouts

Codex gives each MCP tool call 60 seconds by default, so no tool here waits
longer than 45 seconds; long tasks are followed with `get_task`. The rare
sync-only image model can take longer: raise `tool_timeout_sec` under
`[mcp_servers.apiko]` if you use one.

## Development

```bash
npm install
npm test            # builds, then runs the tests against a local mock API
```

`src/tools.ts` holds the tool logic and `src/server.ts` builds an `McpServer`
from it, independent of the transport; `src/index.ts` is the stdio entry point.
The tests never call the production API.
