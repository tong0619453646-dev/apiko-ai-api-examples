# APIKO: quickstart examples

[APIKO](https://apiko.app/) is one OpenAI-compatible endpoint for text, image and video models from OpenAI, Anthropic, Google, DeepSeek and more. Create one key, point any OpenAI SDK at `https://api.apiko.app/v1`, and switch models by changing the model id.

- Website: https://apiko.app/
- Model marketplace with live prices and availability: https://apiko.app/models
- Docs: https://apiko.app/docs

## Setup

1. Create an API key at https://apiko.app/ (pay as you go, credit packs from $5, no subscription).
2. Export it: `export APIKO_API_KEY=sk-...`

## Examples

- `chat.py`: Python, official `openai` package
- `chat.mjs`: Node.js, official `openai` package
- `chat.sh`: plain HTTP with curl

Any model id listed on https://apiko.app/models works, for example `gpt-6-astra`, `claude-sonnet-5-5`, `gemini-3.5-flash` or `deepseek-v4-pro`.

## MCP server for Claude Code and Codex

[`mcp/`](mcp/) is the APIKO MCP server (npm package `apiko-mcp`). It lets Claude Code and Codex find image and video models, quote the cost, generate, and follow the task, all from the chat. Setup and tools: [mcp/README.md](mcp/README.md) and https://apiko.app/mcp.

```bash
claude mcp add apiko --scope user -e APIKO_API_KEY=sk-... -- npx -y apiko-mcp
codex mcp add apiko --env APIKO_API_KEY=sk-... -- npx -y apiko-mcp
```

## Claude Code skill for images and video

[`skills/apiko-media/`](skills/apiko-media/SKILL.md) teaches Claude Code (and other agents that read `SKILL.md`) to generate images and videos through APIKO: async submit and poll, cost checks before paid jobs, and the billing rules that surprise people, such as Wan reference clips being billed with the output.

```bash
mkdir -p ~/.claude/skills && cp -r skills/apiko-media ~/.claude/skills/
```

## LangChain and LlamaIndex

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="claude-sonnet-5-5", base_url="https://api.apiko.app/v1", api_key=os.environ["APIKO_API_KEY"])
```

```python
from llama_index.llms.openai_like import OpenAILike
llm = OpenAILike(model="gemini-3.5-flash", api_base="https://api.apiko.app/v1", api_key=os.environ["APIKO_API_KEY"], is_chat_model=True)
```
