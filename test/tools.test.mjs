// End-to-end tests over a real MCP client/server pair (in-memory transport)
// against the local mock in mock-apiko.mjs. No production calls.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApikoServer } from '../dist/server.js';
import { VERSION, USER_AGENT } from '../dist/version.js';
import { loadConfig } from '../dist/config.js';
import { proxyConfigured } from '../dist/http.js';
import { startMock, TEST_KEY, ONE_PX_PNG_B64 } from './mock-apiko.mjs';

let mock;
let clock;

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.pollsToComplete = 2;
  clock = { t: 1_000_000 };
});

/** fetch that maps a fake public host onto the mock, so URL uploads can be tested. */
function mappedFetch(input, init) {
  const url = String(input).replace('https://public.example.com', mock.origin);
  return fetch(url, init);
}

async function connect({ readOnly = false, apiKey = TEST_KEY } = {}) {
  const server = createApikoServer({
    config: { apiKey, baseUrl: mock.origin, siteUrl: mock.origin, readOnly },
    fetchImpl: mappedFetch,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
  };
  return { client, call, close: () => client.close() };
}

const billable = (r) => r.method === 'POST' && r.path !== '/v1/uploads/images';

// ── surface ─────────────────────────────────────────────────────────────────

test('version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('lists all tools with annotations; read-only mode hides generate and upload', async () => {
  const full = await connect();
  const { tools } = await full.client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['check_balance', 'estimate_cost', 'generate_image', 'generate_video', 'get_model', 'get_task', 'search_models', 'upload_image']);
  for (const name of ['search_models', 'get_model', 'estimate_cost', 'get_task', 'check_balance']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  for (const name of ['generate_image', 'generate_video']) {
    assert.equal(byName[name].annotations.readOnlyHint, false);
    assert.match(byName[name].description, /^BILLABLE/);
    assert.match(byName[name].description, /approval/);
  }
  const info = full.client.getInstructions();
  assert.match(info, /wait for explicit approval/);
  await full.close();

  const ro = await connect({ readOnly: true });
  const names = (await ro.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['check_balance', 'estimate_cost', 'get_model', 'get_task', 'search_models']);
  await ro.close();
});

test('env config: defaults, read-only flag, proxy detection', () => {
  const cfg = loadConfig({ APIKO_API_KEY: ' k ', APIKO_MCP_READ_ONLY: '1' });
  assert.equal(cfg.apiKey, 'k');
  assert.equal(cfg.baseUrl, 'https://api.apiko.app');
  assert.equal(cfg.siteUrl, 'https://apiko.app');
  assert.equal(cfg.readOnly, true);
  assert.equal(loadConfig({ APIKO_BASE_URL: 'http://x/' }).baseUrl, 'http://x');
  assert.equal(loadConfig({}).readOnly, false);
  assert.equal(proxyConfigured({}), false);
  assert.equal(proxyConfigured({ https_proxy: 'http://127.0.0.1:1082' }), true);
});

// ── lookups ─────────────────────────────────────────────────────────────────

test('search_models filters and sends a real User-Agent; key only to the data plane', async () => {
  const s = await connect();
  const r = await s.call('search_models', { category: 'video', query: 'seedance' });
  assert.equal(r.isError, false);
  assert.deepEqual(r.body.models.map((m) => m.id), ['seedance-2.0', 'seedance-2.5']);
  assert.equal(r.body.models[0].generate_tool, 'generate_video');
  for (const req of mock.state.requests) assert.equal(req.headers['user-agent'], USER_AGENT);
  const catalogReq = mock.state.requests.find((q) => q.path === '/api/public/models');
  assert.equal(catalogReq.search, '?billing=all');
  assert.equal(catalogReq.headers.authorization, undefined);
  const modelsReq = mock.state.requests.find((q) => q.path === '/v1/models');
  assert.equal(modelsReq.search, '?expand=parameters');
  await s.close();
});

test('get_model returns schema and pricing; unknown ids suggest alternatives', async () => {
  const s = await connect();
  const r = await s.call('get_model', { model: 'nano-banana-2.1' });
  assert.equal(r.body.input_schema.properties.resolution.default, '1k');
  assert.deepEqual(r.body.supported_modes, ['sync', 'async']);
  assert.equal(r.body.pricing.tiers.length, 3);
  const bad = await s.call('get_model', { model: 'seedance-25' });
  assert.equal(bad.isError, true);
  assert.ok(bad.body.did_you_mean.includes('seedance-2.5'));
  await s.close();
});

test('a wrong key is reported with a fix hint', async () => {
  const s = await connect({ apiKey: 'sk-wrong' });
  const r = await s.call('search_models', {});
  assert.equal(r.isError, true);
  assert.match(r.body.error, /401/);
  await s.close();
});

// ── estimate_cost ───────────────────────────────────────────────────────────

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('estimate_cost: per-call image tiers', async () => {
  const s = await connect();
  let r = await s.call('estimate_cost', { model: 'nano-banana-2.1', input: { prompt: 'x', resolution: '2k' } });
  assert.equal(r.body.input_valid, true);
  assert.equal(r.body.estimate.status, 'estimated');
  near(r.body.estimate.estimated_usd, 0.0154412);
  assert.match(r.body.price_label, /List price/);

  r = await s.call('estimate_cost', { model: 'nano-banana-2', input: { prompt: 'x' } });
  near(r.body.estimate.estimated_usd, 0.0144118); // default 1k from the schema

  r = await s.call('estimate_cost', { model: 'doubao-seedream-5-0-pro', input: { prompt: 'x', size: '16:9' } });
  near(r.body.estimate.estimated_usd, 0.0330882);

  // gpt-image-2: explicit table pixels bill at their own tier, resolution ignored.
  r = await s.call('estimate_cost', { model: 'gpt-image-2', input: { prompt: 'x', size: '1536x2720', resolution: '1k' } });
  near(r.body.estimate.estimated_usd, 0.0176471);
  r = await s.call('estimate_cost', { model: 'gpt-image-2', input: { prompt: 'x', size: '3840x2160' } });
  near(r.body.estimate.estimated_usd, 0.0188235);
  r = await s.call('estimate_cost', { model: 'gpt-image-2', input: { prompt: 'x', size: '656x1536' } });
  assert.equal(r.body.estimate.status, 'unknown');
  assert.match(r.body.estimate.problems[0], /not one of the documented table sizes/);
  await s.close();
});

test('estimate_cost: token-billed gpt-image-2.5 gives no firm number', async () => {
  const s = await connect();
  const r = await s.call('estimate_cost', { model: 'gpt-image-2.5-flare', input: { prompt: 'x', quality: 'high', resolution: '1k' } });
  assert.equal(r.body.estimate.status, 'token_billed');
  assert.equal(r.body.estimate.estimated_usd, null);
  near(r.body.estimate.indicative_usd, 0.010353 * 4);
  const text = await s.call('estimate_cost', { model: 'claude-opus-5-5' });
  assert.equal(text.body.estimate.status, 'token_billed');
  assert.equal(text.body.input_valid, null);
  await s.close();
});

test('estimate_cost: video per second, with reference-video rules', async () => {
  const s = await connect();
  let r = await s.call('estimate_cost', { model: 'seedance-2.5', input: { prompt: 'x', resolution: '1080p', duration: 10 } });
  near(r.body.estimate.estimated_usd, 10 * 0.494991);

  // Seedance with reference video: separate rate, reference counted >= output.
  const sd = { prompt: 'x', duration: 5, reference_videos: ['https://e.com/a.mp4'] };
  r = await s.call('estimate_cost', { model: 'seedance-2.5', input: sd });
  assert.equal(r.body.estimate.status, 'needs_input');
  assert.match(r.body.estimate.missing[0], /reference_video_seconds/);
  near(r.body.estimate.hold_usd, 35 * 0.127008);
  near(r.body.estimate.range_usd.min, 10 * 0.127008);
  near(r.body.estimate.range_usd.max, 35 * 0.127008);
  r = await s.call('estimate_cost', { model: 'seedance-2.5', input: sd, reference_video_seconds: 12 });
  near(r.body.estimate.estimated_usd, 17 * 0.127008);
  r = await s.call('estimate_cost', { model: 'seedance-2.5', input: sd, reference_video_seconds: 3 });
  near(r.body.estimate.estimated_usd, 10 * 0.127008); // counted as at least the 5 s output
  r = await s.call('estimate_cost', { model: 'seedance-2.5', input: sd, reference_video_seconds: 31 });
  assert.match(r.body.estimate.problems[0], /at most 30/);

  // Wan: same rate, hold 15 s per distinct video.
  const wan = { prompt: 'x', reference_videos: ['https://e.com/a.mp4', 'https://e.com/b.mp4'] };
  r = await s.call('estimate_cost', { model: 'wan3.0-reference-video', input: wan });
  near(r.body.estimate.hold_usd, 35 * 0.075);
  near(r.body.estimate.range_usd.min, 7 * 0.075);
  near(r.body.estimate.range_usd.max, 20 * 0.075);
  r = await s.call('estimate_cost', { model: 'wan3.0-reference-video', input: wan, reference_video_seconds: 8 });
  near(r.body.estimate.estimated_usd, 13 * 0.075);

  // Kling: same rate, flat 30 s hold.
  r = await s.call('estimate_cost', {
    model: 'kling-4.0',
    input: { prompt: 'x', resolution: '1080p', duration: 10, reference_videos: ['https://e.com/a.mp4'] },
    reference_video_seconds: 20,
  });
  near(r.body.estimate.estimated_usd, 30 * 0.0705);
  near(r.body.estimate.hold_usd, 40 * 0.0705);
  await s.close();
});

test('estimate_cost: schema problems are reported locally', async () => {
  const s = await connect();
  const r = await s.call('estimate_cost', { model: 'nano-banana-2.1', input: { prompt: 'x', resolutoin: '2k', size: '7:5' } });
  assert.equal(r.body.input_valid, false);
  assert.ok(r.body.problems.some((p) => /unknown field "resolutoin"/.test(p) && /allowed fields: .*resolution/.test(p)));
  assert.ok(r.body.problems.some((p) => /"size" must be one of/.test(p)));
  const i2v = await s.call('estimate_cost', { model: 'wan3.0-image-to-video', input: { prompt: 'x', first_image_url: 'http://insecure.example/a.png' } });
  assert.equal(i2v.body.input_valid, false);
  assert.ok(i2v.body.problems.some((p) => /https/.test(p)));
  await s.close();
});

// ── generate_image ──────────────────────────────────────────────────────────

test('generate_image: text-to-image goes async to /v1/images/generations and waits for the result', async () => {
  const s = await connect();
  const r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'a cat', resolution: '2k' } });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const posts = mock.calls(billable);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/v1/images/generations');
  assert.deepEqual(posts[0].json, { prompt: 'a cat', resolution: '2k', model: 'nano-banana-2.1', async: true });
  assert.equal(posts[0].headers['content-type'], 'application/json');
  assert.equal(posts[0].headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.result_urls.length, 1);
  near(r.body.cost.estimated_usd, 0.0154412);
  assert.ok(!JSON.stringify(r.body).includes(TEST_KEY));
  await s.close();
});

test('generate_image: reference images switch to /v1/images/edits; prompt shortcut works', async () => {
  const s = await connect();
  const r = await s.call('generate_image', { model: 'gpt-image-2', prompt: 'make it blue', input: { images: ['https://img.apiko.app/uploads/a.png'] }, wait_seconds: 0 });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const [post] = mock.calls(billable);
  assert.equal(post.path, '/v1/images/edits');
  assert.deepEqual(post.json, { images: ['https://img.apiko.app/uploads/a.png'], prompt: 'make it blue', model: 'gpt-image-2', async: true });
  assert.equal(r.body.status, 'queued');
  assert.match(r.body.next_step, /get_task/);
  await s.close();
});

test('generate_image: invalid input, b64_json and model mismatch never reach the gateway', async () => {
  const s = await connect();
  let r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'x', quality: 'hd' } });
  assert.equal(r.isError, true);
  assert.match(r.body.error, /nothing was sent/);
  r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'x', response_format: 'b64_json' } });
  assert.equal(r.isError, true);
  r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'x', model: 'nano-banana-2' } });
  assert.equal(r.isError, true);
  r = await s.call('generate_image', { model: 'seedance-2.5', input: { prompt: 'x' } });
  assert.match(r.body.error, /use generate_video/);
  r = await s.call('generate_image', { model: 'nano-banana-2.1', prompt: 'a', input: { prompt: 'b' } });
  assert.equal(r.isError, true);
  assert.equal(mock.calls(billable).length, 0);
  await s.close();
});

test('generate_image: max_cost_usd refuses over-budget and unquotable requests', async () => {
  const s = await connect();
  let r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'x', resolution: '4k' }, max_cost_usd: 0.01 });
  assert.equal(r.isError, true);
  assert.match(r.body.error, /exceeds max_cost_usd/);
  r = await s.call('generate_image', { model: 'gpt-image-2.5-flare', input: { prompt: 'x' }, max_cost_usd: 5 });
  assert.equal(r.isError, true);
  assert.match(r.body.error, /cannot be checked/);
  assert.equal(mock.calls(billable).length, 0);
  r = await s.call('generate_image', { model: 'nano-banana-2.1', input: { prompt: 'x' }, max_cost_usd: 0.02, wait_seconds: 0 });
  assert.equal(r.isError, false);
  assert.equal(mock.calls(billable).length, 1);
  await s.close();
});

test('generate_image: client_request_id prevents a second charge in the same process', async () => {
  const s = await connect();
  const args = { model: 'nano-banana-2.1', input: { prompt: 'x' }, client_request_id: 'req-cat-0001', wait_seconds: 0 };
  const first = await s.call('generate_image', args);
  const second = await s.call('generate_image', args);
  assert.equal(second.body.deduplicated, true);
  assert.equal(second.body.task_id, first.body.task_id);
  const changed = await s.call('generate_image', { ...args, input: { prompt: 'y' } });
  assert.equal(changed.isError, true);
  assert.equal(mock.calls(billable).length, 1);
  await s.close();
});

test('generate_image: sync-only models are called without async and return URLs', async () => {
  const s = await connect();
  const r = await s.call('generate_image', { model: 'mock-sync-image', input: { prompt: 'x' } });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const [post] = mock.calls(billable);
  assert.deepEqual(post.json, { prompt: 'x', model: 'mock-sync-image' });
  assert.equal(r.body.mode, 'sync');
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.result_urls.length, 1);
  await s.close();
});

test('generate_image: a dropped connection is reported as possibly billed, and the id is not resubmitted', async () => {
  const s = await connect();
  mock.state.failNext.set('POST /v1/images/generations', 'drop');
  const args = { model: 'nano-banana-2.1', input: { prompt: 'x' }, client_request_id: 'req-drop-0001' };
  const r = await s.call('generate_image', args);
  assert.equal(r.isError, true);
  assert.match(r.body.error, /may have been accepted and billed/);
  const again = await s.call('generate_image', args);
  assert.equal(again.isError, true);
  assert.match(again.body.error, /outcome is unknown/);
  assert.equal(mock.calls(billable).length, 1);
  await s.close();
});

test('generate_image: gateway errors pass through with a hint; the id stays reusable', async () => {
  const s = await connect();
  mock.state.failNext.set('POST /v1/images/generations', { status: 403, body: { error: { message: 'insufficient quota (request id: m)', type: 'permission_error', code: 'insufficient_user_quota' } } });
  const args = { model: 'nano-banana-2.1', input: { prompt: 'x' }, client_request_id: 'req-quota-001', wait_seconds: 0 };
  const r = await s.call('generate_image', args);
  assert.equal(r.isError, true);
  assert.match(r.body.error, /HTTP 403/);
  assert.match(r.body.hint, /top up/);
  const retry = await s.call('generate_image', args);
  assert.equal(retry.isError, false);
  await s.close();
});

// ── generate_video ──────────────────────────────────────────────────────────

test('generate_video posts the validated body to /v1/videos and returns the task', async () => {
  const s = await connect();
  const input = { prompt: 'a paper boat', duration: 6, resolution: '480p', aspect_ratio: '9:16', generate_audio: false };
  const r = await s.call('generate_video', { model: 'seedance-2.5', input });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const [post] = mock.calls(billable);
  assert.equal(post.path, '/v1/videos');
  assert.deepEqual(post.json, { ...input, model: 'seedance-2.5' });
  assert.equal(r.body.status, 'queued');
  assert.equal(r.body.mode, 'async');
  near(r.body.cost.estimated_usd, 6 * 0.113993);
  // reference_video_seconds is for the estimate only and is never sent.
  const ref = await s.call('generate_video', {
    model: 'kling-4.0',
    input: { prompt: 'x', reference_videos: ['https://e.com/v.mp4'] },
    reference_video_seconds: 10,
    max_cost_usd: 1,
  });
  assert.equal(ref.isError, false, JSON.stringify(ref.body));
  assert.equal(mock.calls(billable)[1].json.reference_video_seconds, undefined);
  // Wrong tool for the model.
  const wrong = await s.call('generate_video', { model: 'nano-banana-2.1', input: { prompt: 'x' } });
  assert.match(wrong.body.error, /use generate_image/);
  assert.equal(mock.calls(billable).length, 2);
  await s.close();
});

test('generate_video: an upper bound from the hold satisfies max_cost_usd without reference seconds', async () => {
  const s = await connect();
  const base = { model: 'wan3.0-reference-video', input: { prompt: 'x', reference_videos: ['https://e.com/v.mp4'] } };
  const over = await s.call('generate_video', { ...base, max_cost_usd: 1 }); // hold (5+15) x 0.075 = 1.5
  assert.equal(over.isError, true);
  const under = await s.call('generate_video', { ...base, max_cost_usd: 2 });
  assert.equal(under.isError, false);
  assert.equal(mock.calls(billable).length, 1);
  await s.close();
});

// ── get_task ────────────────────────────────────────────────────────────────

test('get_task polls until completed within the wait; 404 and failures are explained', async () => {
  const s = await connect();
  const submit = await s.call('generate_video', { model: 'wan3.0-text-to-video', input: { prompt: 'x' } });
  mock.state.pollsToComplete = 3;
  const before = clock.t;
  const r = await s.call('get_task', { task_id: submit.body.task_id, wait_seconds: 45 });
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.done, true);
  assert.match(r.body.result_urls[0], /artifacts\/video/);
  assert.ok(clock.t - before <= 45_000);

  const quick = await s.call('generate_video', { model: 'wan3.0-text-to-video', input: { prompt: 'y' } });
  mock.state.pollsToComplete = 100;
  const t0 = clock.t;
  const pending = await s.call('get_task', { task_id: quick.body.task_id, wait_seconds: 10 });
  assert.equal(pending.body.done, false);
  assert.equal(pending.body.status, 'in_progress');
  assert.ok(clock.t - t0 <= 10_000);

  mock.state.tasks.get(quick.body.task_id).fail = 'the image service is busy or temporarily unavailable; please retry later';
  const failed = await s.call('get_task', { task_id: quick.body.task_id, wait_seconds: 0 });
  assert.equal(failed.body.status, 'failed');
  assert.match(failed.body.fail_reason, /busy/);

  const missing = await s.call('get_task', { task_id: 'task_nope', wait_seconds: 0 });
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /not found/);
  await s.close();
});

// ── check_balance ───────────────────────────────────────────────────────────

test('check_balance: unlimited key and limited key', async () => {
  const s = await connect();
  let r = await s.call('check_balance');
  assert.equal(r.body.key_spent_usd, 11.946244);
  assert.match(r.body.key_limit, /none/);
  assert.equal(r.body.key_remaining_usd, undefined);
  mock.state.subscription = { ...mock.state.subscription, hard_limit_usd: 10, access_until: 1893456000 };
  mock.state.usage = { object: 'list', total_usage: 250 };
  r = await s.call('check_balance');
  assert.equal(r.body.key_limit, 10);
  assert.equal(r.body.key_spent_usd, 2.5);
  assert.equal(r.body.key_remaining_usd, 7.5);
  assert.equal(r.body.key_expires_at, '2030-01-01T00:00:00.000Z');
  await s.close();
});

// ── upload_image ────────────────────────────────────────────────────────────

test('upload_image: local file, public URL, and refusals', async () => {
  const s = await connect();
  const dir = mkdtempSync(join(tmpdir(), 'apiko-mcp-test-'));
  const png = join(dir, 'dot.png');
  writeFileSync(png, Buffer.from(ONE_PX_PNG_B64, 'base64'));
  let r = await s.call('upload_image', { path: png });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/img\.apiko\.app\//);
  let up = mock.calls((q) => q.path === '/v1/uploads/images').at(-1);
  assert.equal(up.headers['content-type'], 'image/png');
  assert.equal(up.raw.toString('base64'), ONE_PX_PNG_B64);

  r = await s.call('upload_image', { url: 'https://public.example.com/public/cat.png' });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const download = mock.calls((q) => q.path === '/public/cat.png').at(-1);
  assert.equal(download.headers.authorization, undefined, 'no key sent to third-party hosts');

  const txt = join(dir, 'notes.txt');
  writeFileSync(txt, 'hello');
  r = await s.call('upload_image', { path: txt });
  assert.match(r.body.error, /Not a JPEG, PNG or WebP/);
  r = await s.call('upload_image', { url: 'http://127.0.0.1:9/x.png' });
  assert.match(r.body.error, /Private/);
  r = await s.call('upload_image', { path: png, url: 'https://public.example.com/public/cat.png' });
  assert.match(r.body.error, /exactly one/);
  assert.equal(mock.calls((q) => q.path === '/v1/uploads/images').length, 2);
  await s.close();
});
