// Task status for image and video jobs (`GET /v1/tasks/{id}`), with bounded
// polling. Lifecycle documented by APIKO: queued -> in_progress -> completed | failed.

import type { ApikoClient } from './client.js';
import { ApikoError } from './http.js';

export const MAX_WAIT_SECONDS = 45;

export interface TaskView {
  task_id: string;
  status: string;
  done: boolean;
  progress?: string | number;
  result_urls: string[];
  fail_reason?: string;
  usage?: unknown;
  created_at?: number;
  finished_at?: number;
}

const DONE_OK = new Set(['completed', 'succeeded', 'success', 'done']);
const DONE_FAIL = new Set(['failed', 'failure', 'cancelled', 'canceled', 'error', 'expired']);

function normalizeStatus(raw: unknown): { status: string; done: boolean } {
  const s = String(raw ?? 'unknown').toLowerCase();
  if (DONE_OK.has(s)) return { status: 'completed', done: true };
  if (DONE_FAIL.has(s)) return { status: s === 'canceled' ? 'cancelled' : s === 'failure' || s === 'error' ? 'failed' : s, done: true };
  return { status: s, done: false };
}

/** Result links from a task body or a synchronous image response. */
export function resultUrls(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && /^https?:\/\//.test(value) && !urls.includes(value)) urls.push(value);
  };
  if (Array.isArray(body.data)) for (const item of body.data) if (item && typeof item === 'object') push((item as Record<string, unknown>).url);
  push(body.video_url);
  push(body.url);
  return urls;
}

export function taskView(taskId: string, body: Record<string, unknown>): TaskView {
  const { status, done } = normalizeStatus(body.status);
  const view: TaskView = { task_id: String(body.id ?? body.task_id ?? taskId), status, done, result_urls: resultUrls(body) };
  if (body.progress !== undefined && body.progress !== '') view.progress = body.progress as string | number;
  if (typeof body.fail_reason === 'string' && body.fail_reason) view.fail_reason = body.fail_reason;
  else if (body.error && typeof body.error === 'object') {
    const message = (body.error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) view.fail_reason = message;
  }
  if (body.usage !== undefined) view.usage = body.usage;
  if (typeof body.created_at === 'number') view.created_at = body.created_at;
  if (typeof body.finished_at === 'number' && body.finished_at > 0) view.finished_at = body.finished_at;
  return view;
}

export interface PollOptions {
  waitSeconds: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetch a task, polling until it finishes or `waitSeconds` (<= 45) runs out. */
export async function pollTask(client: ApikoClient, taskId: string, options: PollOptions): Promise<TaskView> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, options.waitSeconds));
  const deadline = now() + wait * 1000;
  let attempt = 0;
  for (;;) {
    let view: TaskView;
    try {
      view = taskView(taskId, await client.getTask(taskId));
    } catch (error) {
      if (error instanceof ApikoError && error.status === 404) {
        throw new ApikoError(
          `Task ${taskId} not found: check the id (it must come from this API key's generate call); task records are not kept forever.`,
          404
        );
      }
      // A transient read error while waiting is retried until the deadline.
      if (error instanceof ApikoError && (error.status === null || error.status >= 500) && now() + 3000 < deadline) {
        await sleep(3000);
        continue;
      }
      throw error;
    }
    if (view.done) return view;
    const remaining = deadline - now();
    if (remaining <= 0) return view;
    const interval = attempt < 3 ? 3000 : 5000;
    attempt += 1;
    await sleep(Math.min(interval, remaining));
  }
}
