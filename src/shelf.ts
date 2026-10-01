import { createHash } from 'node:crypto';
import { z } from 'astro/zod';
import { PluginRouteError, type PluginContext, type RouteContext } from 'emdash';
import { ingestCover, posterUrls } from './ingestCover';
import { parseNeodbUrl } from './parse';
import { rateLimited } from './rateLimit';
import { resolve } from './resolve';
import { languageOf, tokenOf } from './settings';
import { SHELF_TTL_MS, UA, type ItemSnapshot, type ShelfCard, type ShelfPage } from './types';

export const shelfInput = z.object({
  type: z.enum(['movie', 'book', 'music', 'game', 'drama']).default('movie'),
  status: z.enum(['wishlist', 'progress', 'complete', 'dropped']).default('complete'),
  page: z.coerce.number().int().min(1).max(50).default(1),
});

type ShelfType = z.infer<typeof shelfInput>['type'];
type ShelfStatus = z.infer<typeof shelfInput>['status'];

const TYPE_TO_CATEGORY: Record<ShelfType, string> = {
  movie: 'movie',
  book: 'book',
  music: 'music',
  game: 'game',
  drama: 'performance',
};

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && 'average' in value) {
    return asNumber((value as { average?: unknown }).average);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function markedDate(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 10) return '';
  return raw.slice(0, 10);
}

function subjectUrl(raw: unknown, uuid: string, category: string): string {
  if (typeof raw === 'string' && raw.startsWith('https://')) return raw;
  if (typeof raw === 'string' && raw.startsWith('/')) return `https://neodb.social${raw}`;
  if (uuid) return `https://neodb.social/${category || 'movie'}/${uuid}`;
  return '';
}

function emptyPage(page: number): ShelfPage {
  return { ok: false, page, pages: 0, count: 0, items: [] };
}

function shelfStore(ctx: PluginContext) {
  return ctx.storage.shelf as {
    get(id: string): Promise<ShelfPage | null>;
    put(id: string, data: ShelfPage): Promise<void>;
    deleteMany(ids: string[]): Promise<number>;
    query(options: { limit: number; cursor?: string }): Promise<{
      items: Array<{ id: string }>;
      cursor?: string;
      hasMore: boolean;
    }>;
  };
}

export async function clearShelfCache(ctx: PluginContext): Promise<void> {
  const store = shelfStore(ctx);
  let cursor: string | undefined;
  do {
    const page = await store.query({ limit: 1000, cursor });
    if (page.items.length) await store.deleteMany(page.items.map((item) => item.id));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

function itemsStore(ctx: PluginContext) {
  return ctx.storage.items as {
    get(id: string): Promise<ItemSnapshot | null>;
  };
}

async function yearFor(ctx: PluginContext, itemUrl: string, uuid: string, category: string): Promise<string> {
  const absolute = itemUrl.startsWith('/') ? `https://neodb.social${itemUrl}` : itemUrl;
  const parsed = parseNeodbUrl(absolute) || (uuid ? parseNeodbUrl(`https://neodb.social/${category}/${uuid}`) : null);
  if (parsed) {
    const cached = await itemsStore(ctx).get(parsed.uuid);
    if (cached?.year) return cached.year;
  }
  if (!parsed) return '';
  const snap = await resolve(parsed.url, ctx);
  return snap?.year ?? '';
}

type UpstreamMark = {
  visibility?: unknown;
  rating_grade?: unknown;
  created_time?: unknown;
  item?: Record<string, unknown> | null;
};

async function mapMark(ctx: PluginContext, row: UpstreamMark, enrich = true): Promise<ShelfCard | null> {
  const item = row.item;
  if (!item || typeof item !== 'object') return null;
  const uuid = typeof item.uuid === 'string' ? item.uuid : '';
  if (!uuid) return null;
  const category = typeof item.category === 'string' ? item.category : 'movie';
  const title = String(item.display_title || item.title || uuid);
  const remote = typeof item.cover_image_url === 'string' ? item.cover_image_url : '';
  const itemUrl = typeof item.url === 'string' ? item.url : '';
  const year = enrich ? await yearFor(ctx, itemUrl || `https://neodb.social/${category}/${uuid}`, uuid, category) : '';
  const cached = enrich ? await itemsStore(ctx).get(uuid) : null;
  let coverKey = cached?.coverKey;
  if (enrich && !coverKey && remote) {
    const auth = 'request' in ctx ? (ctx as { request?: Request }).request?.headers : undefined;
    const poster = await ingestCover(ctx, uuid, remote, auth);
    coverKey = poster.coverKey;
  }
  const urls = coverKey ? await posterUrls(ctx, coverKey) : { poster: '', poster2x: undefined as string | undefined };
  const mineRaw = row.rating_grade;
  const mine =
    typeof mineRaw === 'number' && Number.isFinite(mineRaw)
      ? mineRaw
      : typeof mineRaw === 'string' && mineRaw.trim() && Number.isFinite(Number(mineRaw))
        ? Number(mineRaw)
        : null;
  return {
    uuid,
    title,
    year,
    rating: asNumber(item.rating),
    mine,
    marked: markedDate(row.created_time),
    coverKey,
    poster: urls.poster,
    poster2x: urls.poster2x,
    url: subjectUrl(item.id || itemUrl, uuid, category),
    category,
  };
}

async function fetchUpstream(
  ctx: PluginContext,
  type: ShelfType,
  status: ShelfStatus,
  page: number,
  token: string,
  language: string,
): Promise<ShelfPage | null> {
  if (!ctx.http) return null;
  const category = TYPE_TO_CATEGORY[type];
  const api = `https://neodb.social/api/me/shelf/${status}?category=${category}&page=${page}`;
  ctx.log.info(`shelf ${type}/${status}/${page}`);
  const started = Date.now();
  let res: Response;
  try {
    res = await ctx.http.fetch(api, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
        Authorization: `Bearer ${token}`,
        'User-Agent': UA,
      },
    });
  } catch (err) {
    ctx.log.warn(`fetch ${api} failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (!res.ok) {
    ctx.log.info(`fail shelf ${type}/${status}/${page}`);
    return null;
  }
  let payload: { data?: unknown; pages?: unknown; count?: unknown };
  try {
    payload = (await res.json()) as { data?: unknown; pages?: unknown; count?: unknown };
  } catch {
    ctx.log.info(`fail shelf ${type}/${status}/${page}`);
    return null;
  }
  if (!payload || !Array.isArray(payload.data) ||
      !Number.isInteger(payload.pages) || Number(payload.pages) < 0 ||
      !Number.isInteger(payload.count) || Number(payload.count) < 0 ||
      !payload.data.every((row: unknown) => row && typeof row === 'object' &&
        [0, 1, 2].includes((row as UpstreamMark).visibility as number) &&
        typeof (row as UpstreamMark).item?.uuid === 'string' && (row as UpstreamMark).item?.uuid)) {
    return null;
  }
  const rows = (payload.data as UpstreamMark[]).filter((row) => row.visibility === 0);
  let partial = false;
  const mapped = (await Promise.all(rows.map(async (row) => {
    try {
      return await mapMark(ctx, row);
    } catch (error) {
      partial = true;
      ctx.log.warn(`shelf item ${String(row.item?.uuid ?? '')}: ${error instanceof Error ? error.message : String(error)}`);
      return mapMark(ctx, row, false);
    }
  }))).filter(
    (row): row is ShelfCard => row !== null,
  );
  const pages = typeof payload.pages === 'number' && payload.pages > 0 ? payload.pages : mapped.length ? page : 0;
  // Only report this page's public items; upstream totals include restricted marks.
  const count = mapped.length;
  return { ok: true, page, pages, count, items: mapped, fetchedAt: partial ? undefined : Date.now() };
}

export async function shelfHandler(ctx: RouteContext) {
  if (ctx.request.method !== 'GET') {
    throw new PluginRouteError('METHOD_NOT_ALLOWED', 'GET only', 405);
  }
  const { type, status, page } = shelfInput.parse(ctx.input);
  const internalToken = await ctx.kv.get<string>('settings:internalToken');
  const internal = internalToken && ctx.request.headers.get('X-Hera-Internal') === internalToken;
  const ip = ctx.requestMeta.ip || 'unknown';
  if (!internal && rateLimited(`shelf:${ip}`, 60)) {
    throw new PluginRouteError('RATE_LIMITED', 'rate limited', 429);
  }

  const token = await tokenOf(ctx);
  const language = await languageOf(ctx);

  const account = createHash('sha256').update(token).digest('hex').slice(0, 12);
  const key = `v7-public:${account}:${language}:${type}:${status}:${page}`;
  const cached = await shelfStore(ctx).get(key);
  if (cached?.ok && cached.fetchedAt && Date.now() - cached.fetchedAt < SHELF_TTL_MS) {
    ctx.log.info(`shelf-cache ${type}/${status}/${page}`);
    return {
      ok: cached.ok,
      page: cached.page,
      pages: cached.pages,
      count: cached.count,
      items: cached.items,
    };
  }

  const fetched = await fetchUpstream(ctx, type, status, page, token, language);
  if (!fetched) return emptyPage(page);
  if (fetched.fetchedAt) await shelfStore(ctx).put(key, fetched);
  return {
    ok: fetched.ok,
    page: fetched.page,
    pages: fetched.pages,
    count: fetched.count,
    items: fetched.items,
  };
}
