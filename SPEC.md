# APIKO MCP — interface contract (v0, 2026-10-23)

Shared contract between the MCP server (this repo) and the `/mcp` landing page
(apiko-web branch `feat/mcp-page`). Change both sides together.

## Scope of v0

- Clients: Claude Code (CLI + desktop app) and Codex (CLI + desktop app). Both
  desktop apps read the same config as their CLI.
- Transport: local **stdio** server. Remote HTTP / OAuth come later; keep tool
  logic transport-agnostic so a remote endpoint can mount the same tools.
- Auth: the user's own APIKO API key in env `APIKO_API_KEY`. Optional
  `APIKO_BASE_URL` (default `https://api.apiko.app`).
- Only calls existing public endpoints. No new-api changes.
- Package name (not published yet): `@apiko/mcp`, bin `apiko-mcp`.

## Setup commands shown to users

Claude Code (CLI; desktop app picks up user-scope servers):

    claude mcp add apiko --scope user -e APIKO_API_KEY=sk-... -- npx -y @apiko/mcp

Codex (CLI; desktop app shares ~/.codex/config.toml):

    codex mcp add apiko --env APIKO_API_KEY=sk-... -- npx -y @apiko/mcp

    # or ~/.codex/config.toml
    [mcp_servers.apiko]
    command = "npx"
    args = ["-y", "@apiko/mcp"]
    env = { APIKO_API_KEY = "sk-..." }

Before npm publishing, replace `npx -y @apiko/mcp` with
`node /absolute/path/to/apiko-mcp/dist/index.js`.

## Tools

| Tool | Charges? | Backed by |
|---|---|---|
| `search_models` | no | `GET /v1/models?expand=parameters` (key-scoped) joined with `GET https://apiko.app/api/public/models?billing=all` (prices) |
| `get_model` | no | same; returns `parameters.input_schema`, endpoints, modes, price tiers |
| `estimate_cost` | no | public price tiers; returns `estimated` / `needs_input` / `unknown`, never guesses |
| `generate_image` | **yes** | `POST /v1/images/generations` or `/v1/images/edits` (async when supported) |
| `generate_video` | **yes** | `POST /v1/videos` |
| `get_task` | no | `GET /v1/tasks/{id}` with optional wait (≤ 45 s) |
| `check_balance` | no | `GET /v1/dashboard/billing/subscription` + `/usage` |
| `upload_image` | no | `POST /v1/uploads/images`; accepts a local file path (stdio can read disk) |

Lookups, quotes, task checks, balance and uploads are free; generation is billed
at API prices to the key's balance; failed tasks are refunded by the gateway.
