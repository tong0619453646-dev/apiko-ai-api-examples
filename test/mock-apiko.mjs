// A local stand-in for api.apiko.app and apiko.app used by the tests. It
// records every request so tests can assert the exact shapes the server sends.
// Nothing here talks to production.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const here = new URL('./fixtures/', import.meta.url);
const MODELS = JSON.parse(readFileSync(new URL('models.json', here), 'utf8'));
const PUBLIC = JSON.parse(readFileSync(new URL('public-models.json', here), 'utf8'));

export const TEST_KEY = 'sk-test0000000000000000000000000000000000000000000000';

/** A model that only supports sync calls, to exercise the sync path. */
const SYNC_ONLY = {
  id: 'mock-sync-image',
  object: 'model',
  category: 'image',
  supported_endpoint_types: ['openai'],
  parameters: {
    category: 'image',
    endpoints: ['POST /v1/images/generations', 'GET /v1/tasks/{id}'],
    operations: ['generation'],
    supported_modes: ['sync'],
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', const: 'mock-sync-image' },
        prompt: { type: 'string', minLength: 1 },
        response_format: { type: 'string', enum: ['url', 'b64_json'] },
      },
    },
  },
};
const SYNC_ONLY_PUBLIC = { id: 'mock-sync-image', displayName: 'Mock Sync', provider: 'mock', capabilities: ['image'], status: 'operational', pricing: { perCall: 0.02, tiers: [], currency: 'USD' } };

export async function startMock(options = {}) {
  const state = {
    requests: [],
    tasks: new Map(),
    /** Polls needed before a task completes. */
    pollsToComplete: options.pollsToComplete ?? 2,
    subscription: options.subscription ?? { object: 'billing_subscription', has_payment_method: true, soft_limit_usd: 100000000, hard_limit_usd: 100000000, system_hard_limit_usd: 100000000, access_until: 0 },
    usage: options.usage ?? { object: 'list', total_usage: 1194.6244 },
    /** path -> { status, body } or 'drop' to destroy the socket. */
    failNext: new Map(),
    taskSeq: 0,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      const record = { method: req.method, path: url.pathname, search: url.search, headers: req.headers, raw };
      try {
        record.json = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString('utf8')) : undefined;
      } catch {
        record.json = undefined;
      }
      state.requests.push(record);

      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const failure = state.failNext.get(`${req.method} ${url.pathname}`);
      if (failure) {
        state.failNext.delete(`${req.method} ${url.pathname}`);
        if (failure === 'drop') return req.socket.destroy();
        return send(failure.status, failure.body);
      }

      // Public catalog: no auth.
      if (req.method === 'GET' && url.pathname === '/api/public/models') {
        return send(200, { ...PUBLIC, data: { models: [...PUBLIC.data.models, SYNC_ONLY_PUBLIC], total: PUBLIC.data.total + 1 } });
      }
      // A "public" image host for upload-by-URL.
      if (req.method === 'GET' && url.pathname === '/public/cat.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from(ONE_PX_PNG_B64, 'base64'));
      }

      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        return send(401, { error: { message: 'Invalid token (request id: mock)', type: 'authentication_error' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return send(200, { ...MODELS, data: [...MODELS.data, SYNC_ONLY] });
      }
      if (req.method === 'GET' && url.pathname === '/v1/dashboard/billing/subscription') return send(200, state.subscription);
      if (req.method === 'GET' && url.pathname === '/v1/dashboard/billing/usage') return send(200, state.usage);

      if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits')) {
        const body = record.json ?? {};
        if (body.async === true) {
          const id = `task_mock${++state.taskSeq}`;
          state.tasks.set(id, { polls: 0, kind: 'image' });
          return send(200, { id, object: 'image.task', status: 'queued', created: 1790000000 });
        }
        return send(200, { created: 1790000000, data: [{ url: 'https://api.apiko.app/v1/tasks/sync/artifacts/image-0/content?access=x' }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/videos') {
        const id = `task_mock${++state.taskSeq}`;
        state.tasks.set(id, { polls: 0, kind: 'video' });
        return send(200, { id, object: 'video', model: record.json?.model, status: 'queued', progress: 0 });
      }
      const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const task = state.tasks.get(id);
        if (!task) return send(404, { error: { message: 'Task not found', type: 'invalid_request_error' } });
        task.polls += 1;
        if (task.fail) return send(200, { id, task_id: id, status: 'failed', progress: '100%', fail_reason: task.fail, data: [] });
        if (task.polls < state.pollsToComplete) return send(200, { id, task_id: id, status: 'in_progress', progress: '40%', created_at: 1790000000, finished_at: 0, fail_reason: '' });
        return send(200, {
          id,
          task_id: id,
          status: 'completed',
          progress: '100%',
          created_at: 1790000000,
          finished_at: 1790000060,
          fail_reason: '',
          data: [{ url: `https://api.apiko.app/v1/tasks/${id}/artifacts/${task.kind === 'video' ? 'video' : 'image-0'}/content?access=x` }],
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/uploads/images') {
        return send(200, {
          object: 'image.upload',
          url: 'https://img.apiko.app/uploads/2026-10-23/abcd/ref.png',
          content_type: req.headers['content-type'],
          bytes: raw.length,
          expires_at: '2026-10-26T00:00:00.000Z',
        });
      }
      return send(404, { error: { message: `mock: no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** Requests excluding catalog reads. */
    calls: (filter) => state.requests.filter((r) => (filter ? filter(r) : true)),
  };
}

export const ONE_PX_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
