import { PluginRouteError, type PluginContext } from 'emdash';
import { ingestCover } from './ingestCover';
import { blocks as contentBlocks } from './beforeSave';
import { parseCardUrl, parseNeodbUrl } from './parse';
import { resolve } from './resolve';
import { clearShelfCache } from './shelf';
import { applySnapshot } from './snapshot';

const LOCK_KEY = 'state:refreshRunning';
const LAST_AT_KEY = 'state:lastRefreshAt';
const LAST_RESULT_KEY = 'state:lastRefreshResult';
const LOCK_MS = 10 * 60 * 1000;

export type RefreshFailed = { slug: string; url: string; error: string };

export type RefreshResult = {
  posts: number;
  blocks: number;
  uploaded: number;
  skipped: number;
  failed: RefreshFailed[];
};

type LockState = { startedAt: number };
let refreshing = false; // One runtime per site; KV also exposes progress to the admin.

function originOf(): string {
  const origin = String(process.env.EMDASH_INTERNAL_ORIGIN ?? '').trim();
  if (!origin) throw new Error('EMDASH_INTERNAL_ORIGIN is not set');
  return origin.replace(/\/$/, '');
}

async function listPosts(ctx: PluginContext) {
  if (!ctx.content) throw new PluginRouteError('NO_CONTENT', 'content access missing', 500);
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.content.list('posts', { limit: 100, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function contentRequest(ctx: PluginContext & { request: Request }, id: string, method = 'GET', body?: unknown, suffix = '') {
  const headers = new Headers({ 'X-EmDash-Request': '1', 'Content-Type': 'application/json' });
  for (const name of ['Authorization', 'Cookie']) {
    const value = ctx.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await fetch(`${originOf()}/_emdash/api/content/posts/${encodeURIComponent(id)}${suffix}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const payload = await res.json() as { data?: { item: { data: Record<string, unknown>; status: string; draftRevisionId?: string; liveRevisionId?: string }; _rev?: string }; error?: { message?: string } };
  if (!res.ok) throw new Error(`${method} ${res.status}: ${payload.error?.message || 'content request failed'}`);
  if (!payload.data) throw new Error('Content response missing data');
  return payload.data;
}

async function statusOf(ctx: PluginContext) {
  const lock = await ctx.kv.get<LockState>(LOCK_KEY);
  const running = Boolean(lock && Date.now() - lock.startedAt < LOCK_MS);
  const lastRefreshAt = (await ctx.kv.get<string>(LAST_AT_KEY)) ?? null;
  const result = (await ctx.kv.get<RefreshResult>(LAST_RESULT_KEY)) ?? null;
  return { running, lastRefreshAt, result };
}

async function runRefresh(ctx: PluginContext & { request: Request }): Promise<RefreshResult> {
  if (!ctx.content) throw new PluginRouteError('NO_CONTENT', 'content access missing', 500);
  const posts = await listPosts(ctx);
  const failed: RefreshFailed[] = [];
  let postCount = 0;
  let blockCount = 0;
  let uploaded = 0;
  let skipped = 0;
  const auth = ctx.request.headers;

  for (const item of posts) {
    if (![...contentBlocks(item.data?.content)].some((block) => block._type === 'neodb')) continue;
    let current: Awaited<ReturnType<typeof contentRequest>>;
    try {
      current = await contentRequest(ctx, item.id);
      if (!current._rev) throw new Error('Content revision token missing');
      if (current.item.draftRevisionId && current.item.draftRevisionId !== current.item.liveRevisionId) {
        throw new Error('存在未发布修改，已跳过');
      }
      if (current.item.status !== item.status) throw new Error('文章状态已变化，已跳过');
    } catch (error) {
      failed.push({ slug: item.slug ?? item.id, url: '', error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const pt = current.item.data.content;
    if (!Array.isArray(pt)) continue;
    const blocks = [...contentBlocks(pt)].filter((block) => block._type === 'neodb');
    if (!blocks.length) continue;

    let touched = false;
    for (const block of blocks) {
      blockCount += 1;
      const url = String(block.url ?? '').trim();
      const slug = item.slug ?? item.id;
      if (!url || !parseCardUrl(url)) {
        failed.push({ slug, url, error: url ? 'unsupported url' : 'missing url' });
        continue;
      }
      try {
        const snap = await resolve(url, ctx, { force: true });
        if (!snap) {
          failed.push({ slug, url, error: 'unresolved' });
          continue;
        }
        if (snap.cover) {
          const uuid = parseNeodbUrl(snap.itemUrl)?.uuid;
          if (!uuid) throw new Error('snapshot missing uuid');
          const poster = await ingestCover(ctx, uuid, snap.cover, auth);
          snap.coverKey = poster.coverKey;
          snap.coverMediaId = poster.coverMediaId;
          if (poster.uploaded) uploaded += 1;
          else skipped += 1;
        }
        applySnapshot(block, snap, url);
        touched = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`refresh ${url}: ${message}`);
        failed.push({ slug, url, error: message });
      }
    }

    if (!touched) continue;
    try {
      const updated = await contentRequest(ctx, item.id, 'PUT', { data: { content: pt }, _rev: current._rev });
      if (item.status === 'published') {
        if (!updated._rev) throw new Error('Updated content revision token missing; left as draft');
        await contentRequest(ctx, item.id, 'POST', { _rev: updated._rev }, '/publish');
      }
      postCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`refresh write ${item.slug ?? item.id}: ${message}`);
      failed.push({ slug: item.slug ?? item.id, url: '', error: message });
    }
  }

  return { posts: postCount, blocks: blockCount, uploaded, skipped, failed };
}

export async function refreshHandler(ctx: PluginContext & { request: Request }) {
  const method = ctx.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return statusOf(ctx);
  if (method !== 'POST') {
    throw new PluginRouteError('METHOD_NOT_ALLOWED', 'GET or POST only', 405);
  }

  if (refreshing) throw new PluginRouteError('REFRESH_RUNNING', 'refresh already running', 409);
  refreshing = true;
  try {
  const lock = await ctx.kv.get<LockState>(LOCK_KEY);
  if (lock && Date.now() - lock.startedAt < LOCK_MS) {
    throw new PluginRouteError('REFRESH_RUNNING', 'refresh already running', 409);
  }

  await ctx.kv.set(LOCK_KEY, { startedAt: Date.now() } satisfies LockState);
  try {
    const result = await runRefresh(ctx);
    await clearShelfCache(ctx);
    const lastRefreshAt = new Date().toISOString();
    await ctx.kv.set(LAST_AT_KEY, lastRefreshAt);
    await ctx.kv.set(LAST_RESULT_KEY, result);
    return { ...result, lastRefreshAt };
  } finally {
    await ctx.kv.delete(LOCK_KEY);
  }
  } finally { refreshing = false; }
}
