#!/usr/bin/env node
// stdio entry point: `apiko-mcp`. Logs go to stderr; stdout carries MCP only.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { proxyConfigured } from './http.js';
import { createApikoServer } from './server.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const config = loadConfig();
  const server = createApikoServer({ config });
  await server.connect(new StdioServerTransport());
  const notes = [
    `apiko-mcp ${VERSION} on stdio`,
    `base ${config.baseUrl}`,
    config.apiKey ? 'key set' : 'APIKO_API_KEY missing',
    config.readOnly ? 'read-only' : 'generation enabled',
    proxyConfigured() ? 'via proxy' : 'direct',
  ];
  process.stderr.write(`${notes.join(' | ')}\n`);
}

main().catch((error) => {
  process.stderr.write(`apiko-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
