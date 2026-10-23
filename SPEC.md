# APIKO MCP — interface contract (v0, 2026-10-23)

Shared contract between the MCP server (this repo) and the `/mcp` landing page
(apiko-web branch `feat/mcp-page`). Change both sides together.

## Scope of v0

- Clients: Claude Code (CLI + desktop app) and Codex (CLI, IDE extension and
  the ChatGPT desktop app's Codex). Each desktop surface reads the same config
  as its CLI (see "Desktop apps" below).
- Transport: local **stdio** server. Remote HTTP / OAuth come later; tool logic
  lives in `src/tools.ts` and `createApikoServer()` (`src/server.ts`) so a remote
  endpoint can mount the same tools.
- Auth: the user's own APIKO API key in env `APIKO_API_KEY`.
- Only calls existing public endpoints. No new-api changes.
- Package name (not published yet): `@apiko/mcp`, bin `apiko-mcp`, Node >= 18.17.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `APIKO_API_KEY` | (required) | The user's key from apiko.app/dashboard/apikeys |
| `APIKO_MCP_READ_ONLY` | off | `1` hides `generate_image`, `generate_video` and `upload_image` (nothing billable, nothing published) |
| `APIKO_BASE_URL` | `https://api.apiko.app` | Data plane |
| `APIKO_SITE_URL` | `https://apiko.app` | Site serving the public price catalog (advanced/testing) |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | unset | Honoured only when set (undici `EnvHttpProxyAgent`); unset = direct |

## Setup commands shown to users

Claude Code (CLI; the desktop app's Code tab loads user-scope servers from
`~/.claude.json` too):

    claude mcp add apiko --scope user -e APIKO_API_KEY=sk-... -- npx -y @apiko/mcp

Codex (CLI; the ChatGPT desktop app and the IDE extension share
`~/.codex/config.toml`):

    codex mcp add apiko --env APIKO_API_KEY=sk-... -- npx -y @apiko/mcp

    # or ~/.codex/config.toml
    [mcp_servers.apiko]
    command = "npx"
    args = ["-y", "@apiko/mcp"]
    env = { APIKO_API_KEY = "sk-..." }

Before npm publishing, replace `npx -y @apiko/mcp` with
`node /absolute/path/to/apiko-mcp/dist/index.js`. Both command forms were run
on 2026-10-23 (Claude Code 2.1.309 with `--scope project` in a temp dir, codex-cli
0.160.0 with a temp `CODEX_HOME`) and produced the expected config entries.

### Desktop apps (checked against official docs, 2026-10-23)

- Claude Code desktop: "The Desktop app loads MCP servers from
  `claude_desktop_config.json` into local Code tab sessions, alongside servers
  from `~/.claude.json` and `.mcp.json`." (code.claude.com/docs/en/desktop).
  `--scope user` writes `~/.claude.json`. The standalone Claude chat app's
  `claude_desktop_config.json` is a different file the CLI does not read.
  GUI launches get `PATH` from the shell profile; if `npx` is not found, use the
  absolute path of `npx`/`node`.
- Codex: "The ChatGPT desktop app, Codex CLI, and IDE extension share this
  configuration." (learn.chatgpt.com/docs/extend/mcp, redirected from
  developers.openai.com/codex/mcp). Codex's default MCP `tool_timeout_sec` is 60 s,
  so no tool waits longer than 45 s.

## Tools

| Tool | Charges? | Hidden by READ_ONLY | Backed by |
|---|---|---|---|
| `search_models` | no | no | `GET /v1/models?expand=parameters` (key-scoped) joined with `GET https://apiko.app/api/public/models?billing=all` (prices) |
| `get_model` | no | no | same; returns `input_schema`, endpoints, modes, raw pricing |
| `estimate_cost` | no | no | public prices; status `estimated` / `needs_input` / `token_billed` / `unknown`, never guesses |
| `generate_image` | **yes** | yes | `POST /v1/images/generations`, or `/v1/images/edits` when `input.images` is set; `async: true` when the model supports it, else sync |
| `generate_video` | **yes** | yes | `POST /v1/videos` |
| `get_task` | no | no | `GET /v1/tasks/{id}`, optional wait (default 30 s, max 45 s) |
| `check_balance` | no | no | `GET /v1/dashboard/billing/subscription` + `/usage` — **key** spend and key limit, not the account balance (see below) |
| `upload_image` | no (free, rate-limited) | yes | `POST /v1/uploads/images` (raw body); accepts a local `path` or a public `url`; result public for 72 h |

Arguments common to both generate tools: `model`, `input` (fields from
`input_schema`), optional `prompt` shortcut, `client_request_id` (same-process
duplicate protection), `max_cost_usd` (refuses when the estimate or its upper
bound is higher or cannot be computed), `wait_seconds`. `generate_video` also
takes `reference_video_seconds` (for the cost check only, never sent).

Lookups, quotes, task checks, balance and uploads are free; generation is billed
at API prices to the APIKO account balance; failed tasks are refunded by the gateway.

### What `check_balance` can and cannot show

new-api answers both endpoints from the calling **token** (DisplayTokenStatEnabled,
on by default and in production). APIKO dashboard keys are created with
`unlimited_quota: true`, for which the subscription endpoint returns the
sentinel `100000000`. So for most users `check_balance` shows how much this key
has spent and that it has no limit of its own; the account balance is not
readable with an API key and stays on apiko.app/dashboard/billing. The landing
page must not promise "see your balance from the agent".
