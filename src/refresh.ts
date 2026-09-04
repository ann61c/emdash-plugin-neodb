import { PluginRouteError, type PluginContext } from 'emdash';
import { ingestCover } from './ingestCover';
import { parseCardUrl, parseNeodbUrl } from './parse';
import { resolve } from './resolve';
import { applySnapshot } from './snapshot';

const LOCK_KEY = 'state:refreshRunning';
const LAST_AT_KEY = 'state:lastRefreshAt';
const LAST_RESULT_KEY = 'state:lastRefreshResult';
const LOCK_MS = 10 * 60 * 1000;

type Block = Record<string, unknown>;

export type RefreshFailed = { slug: string; url: string; error: string };

export type RefreshResult = {
  posts: number;
  blocks: number;
  uploaded: number;
  skipped: number;
  failed: RefreshFailed[];
};

type LockState = { startedAt: number };

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

async function publishPost(ctx: PluginContext & { request: Request }, id: string): Promise<void> {
  const headers = new Headers();
  headers.set('X-EmDash-Request', '1');
  headers.set('Content-Type', 'application/json');
  const auth = ctx.request.headers.get('Authorization');
  if (auth) headers.set('Authorization', auth);
  const cookie = ctx.request.headers.get('Cookie');
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(`${originOf()}/_emdash/api/content/posts/${id}/publish`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`publish ${res.status} ${text.slice(0, 200)}`);
  }
}

async function statusOf(ctx: PluginContext) {
  const lock = await ctx.kv.get<LockState>(LOCK_KEY);
  const running = Boolean(lock && Date.now() - lock.startedAt < LOCK_MS);
  const lastRefreshAt = (await ctx.kv.get<string>(LAST_AT_KEY)) ?? null;
  const result = (await ctx.kv.get<RefreshResult>(LAST_RESULT_KEY)) ?? null;
  return { running, lastRefreshAt, result };
}

async function runRefresh(ctx: PluginContext & { request: Request }): Promise<RefreshResult> {
  if (!ctx.content?.update) throw new PluginRouteError('NO_CONTENT', 'content access missing', 500);
  const posts = await listPosts(ctx);
  const failed: RefreshFailed[] = [];
  let postCount = 0;
  let blockCount = 0;
  let uploaded = 0;
  let skipped = 0;
  const auth = ctx.request.headers;

  for (const item of posts) {
    const data = item.data ?? {};
    const pt = data.content;
    if (!Array.isArray(pt)) continue;
    const blocks = pt.filter((raw): raw is Block => Boolean(raw && typeof raw === 'object' && (raw as Block)._type === 'neodb'));
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
      await ctx.content.update('posts', item.id, { content: pt });
      if (item.status === 'published') await publishPost(ctx, item.id);
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

  const lock = await ctx.kv.get<LockState>(LOCK_KEY);
  if (lock && Date.now() - lock.startedAt < LOCK_MS) {
    throw new PluginRouteError('REFRESH_RUNNING', 'refresh already running', 409);
  }

  await ctx.kv.set(LOCK_KEY, { startedAt: Date.now() } satisfies LockState);
  try {
    const result = await runRefresh(ctx);
    const lastRefreshAt = new Date().toISOString();
    await ctx.kv.set(LAST_AT_KEY, lastRefreshAt);
    await ctx.kv.set(LAST_RESULT_KEY, result);
    return { ...result, lastRefreshAt };
  } finally {
    await ctx.kv.delete(LOCK_KEY);
  }
}
