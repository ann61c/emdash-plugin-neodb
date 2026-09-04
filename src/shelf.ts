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
  };
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
  rating_grade?: unknown;
  created_time?: unknown;
  item?: Record<string, unknown> | null;
};

async function mapMark(ctx: PluginContext, row: UpstreamMark): Promise<ShelfCard | null> {
  const item = row.item;
  if (!item || typeof item !== 'object') return null;
  const uuid = typeof item.uuid === 'string' ? item.uuid : '';
  if (!uuid) return null;
  const category = typeof item.category === 'string' ? item.category : 'movie';
  const title = String(item.display_title || item.title || uuid);
  const remote = typeof item.cover_image_url === 'string' ? item.cover_image_url : '';
  const itemUrl = typeof item.url === 'string' ? item.url : '';
  const year = await yearFor(ctx, itemUrl || `https://neodb.social/${category}/${uuid}`, uuid, category);
  const cached = await itemsStore(ctx).get(uuid);
  let coverKey = cached?.coverKey;
  if (!coverKey && remote) {
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
): Promise<ShelfPage | null> {
  if (!ctx.http) return null;
  const category = TYPE_TO_CATEGORY[type];
  const api = `https://neodb.social/api/me/shelf/${status}?category=${category}&page=${page}`;
  ctx.log.info(`shelf ${type}/${status}/${page}`);
  const res = await ctx.http.fetch(api, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': await languageOf(ctx),
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
    },
  });
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
  const rows = Array.isArray(payload.data) ? (payload.data as UpstreamMark[]) : [];
  const mapped = (await Promise.all(rows.map((row) => mapMark(ctx, row)))).filter(
    (row): row is ShelfCard => row !== null,
  );
  const pages = typeof payload.pages === 'number' && payload.pages > 0 ? payload.pages : mapped.length ? page : 0;
  const count = typeof payload.count === 'number' ? payload.count : mapped.length;
  return { ok: true, page, pages, count, items: mapped, fetchedAt: Date.now() };
}

export async function shelfHandler(ctx: RouteContext) {
  if (ctx.request.method !== 'GET') {
    throw new PluginRouteError('METHOD_NOT_ALLOWED', 'GET only', 405);
  }
  const { type, status, page } = shelfInput.parse(ctx.input);
  const ip = ctx.requestMeta.ip || 'unknown';
  if (rateLimited(`shelf:${ip}`, 60)) {
    throw new PluginRouteError('RATE_LIMITED', 'rate limited', 429);
  }

  const token = await tokenOf(ctx);

  const key = `v5:${type}:${status}:${page}`;
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

  const fetched = await fetchUpstream(ctx, type, status, page, token);
  if (!fetched) return emptyPage(page);
  await shelfStore(ctx).put(key, fetched);
  return {
    ok: fetched.ok,
    page: fetched.page,
    pages: fetched.pages,
    count: fetched.count,
    items: fetched.items,
  };
}
