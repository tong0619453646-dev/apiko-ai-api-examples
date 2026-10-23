// Builds an MCP server with the APIKO tools. Transport-agnostic: index.ts
// connects it to stdio; a remote HTTP endpoint can call createApikoServer per
// session with its own config (for example a per-user API key).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApikoClient } from './client.js';
import { Catalog } from './catalog.js';
import type { ApikoConfig } from './config.js';
import type { FetchLike } from './http.js';
import { buildTools, type ToolDefinition } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_INSTRUCTIONS = `APIKO (apiko.app) generates images and videos with many vendors' models on the user's own API key and balance.
Workflow: search_models -> get_model (read input_schema) -> upload_image for local reference images -> estimate_cost with the exact input -> tell the user the model, key settings and estimated cost, then stop and wait for explicit approval -> generate_image / generate_video once -> get_task until completed -> give the user the result URLs (kept 24 hours).
Rules: never guess model ids or fields; send only input_schema fields. generate_* tools spend real money: an available balance, an earlier approval for a different input, or a vague "try it" is not approval. If estimate_cost returns needs_input, token_billed or unknown, say that the exact price is not known. Never call a generate tool again to check progress; use get_task with the task_id. Failed tasks are refunded automatically. Never ask the user to paste an API key into the chat.`;

export interface CreateServerOptions {
  config: ApikoConfig;
  fetchImpl?: FetchLike;
  /** Test hooks for polling. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createApikoTools(options: CreateServerOptions): ToolDefinition[] {
  const client = new ApikoClient(options.config, options.fetchImpl);
  const catalog = new Catalog(client, options.now);
  const tools = buildTools({ client, catalog, config: options.config, sleep: options.sleep, now: options.now });
  return options.config.readOnly ? tools.filter((tool) => !tool.writes) : tools;
}

export function createApikoServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: 'apiko', title: 'APIKO', version: VERSION, websiteUrl: 'https://apiko.app' },
    { instructions: SERVER_INSTRUCTIONS }
  );
  for (const tool of createApikoTools(options)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      (async (args: Record<string, unknown>) => tool.handler(args ?? {})) as never
    );
  }
  return server;
}
