# pip install openai
import os
from openai import OpenAI

# APIKO AI API (https://apiko.app/) is OpenAI-compatible: only the base URL and key change.
client = OpenAI(base_url="https://api.apiko.app/v1", api_key=os.environ["APIKO_API_KEY"])

for model in ["gpt-6-astra", "claude-sonnet-5-5", "gemini-3.5-flash"]:
    reply = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "In one sentence, what is an API gateway?"}],
    )
    print(f"{model}: {reply.choices[0].message.content}")
