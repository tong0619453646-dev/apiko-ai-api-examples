#!/bin/sh
# APIKO AI API (https://apiko.app/): OpenAI-compatible chat completions over plain HTTP.
curl https://api.apiko.app/v1/chat/completions \
  -H "Authorization: Bearer $APIKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "Hello!"}]}'
