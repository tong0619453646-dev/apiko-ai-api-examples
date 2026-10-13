// npm install openai
import OpenAI from "openai";

// APIKO AI API (https://apiko.app/) is OpenAI-compatible: only the base URL and key change.
const client = new OpenAI({ baseURL: "https://api.apiko.app/v1", apiKey: process.env.APIKO_API_KEY });

for (const model of ["gpt-6-astra", "claude-sonnet-5-5", "gemini-3.5-flash"]) {
  const reply = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "In one sentence, what is an API gateway?" }],
  });
  console.log(`${model}: ${reply.choices[0].message.content}`);
}
