# APIKO AI API: quickstart examples

[APIKO AI API](https://apiko.app/) is one OpenAI-compatible endpoint for text, image and video models from OpenAI, Anthropic, Google, DeepSeek and more. Create one key, point any OpenAI SDK at `https://api.apiko.app/v1`, and switch models by changing the model id.

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

Any model id listed on https://apiko.app/models works, for example `gpt-6-astra`, `claude-sonnet-5-5`, `gemini-3.5-flash` or `deepseek-v4-flash`.

## LangChain and LlamaIndex

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="claude-sonnet-5-5", base_url="https://api.apiko.app/v1", api_key=os.environ["APIKO_API_KEY"])
```

```python
from llama_index.llms.openai_like import OpenAILike
llm = OpenAILike(model="gemini-3.5-flash", api_base="https://api.apiko.app/v1", api_key=os.environ["APIKO_API_KEY"], is_chat_model=True)
```
