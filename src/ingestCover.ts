import type { PluginContext } from 'emdash';
import { UA } from './types';

export type PosterRef = {
  coverKey: string;
  coverMediaId: string;
  uploaded: boolean;
};

const MAX_BYTES = 20 * 1024 * 1024; // NeoDB serves originals; two covers were 7.7MB and 10.3MB (Cloudflare transforms accept up to 100MB)
const FETCH_MS = 8000;
const FOLDER_NAME = 'neodb-posters';
const FOLDER_KV = 'posterFolderId';

type StoredPoster = { mediaId: string; storageKey: string };

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

function kvKey(uuid: string): string {
  return `poster:${uuid}`;
}

function internalOrigin(): string {
  const origin = String(process.env.EMDASH_INTERNAL_ORIGIN ?? '').trim();
  if (!origin) throw new Error('EMDASH_INTERNAL_ORIGIN is not set');
  return origin.replace(/\/$/, '');
}

function absoluteCover(raw: string): string {
  const cover = raw.startsWith('/') ? `https://neodb.social${raw}` : raw;
  let url: URL;
  try {
    url = new URL(cover);
  } catch {
    throw new Error(`cover is not a URL: ${raw}`);
  }
  if (url.hostname !== 'neodb.social') throw new Error(`cover host ${url.hostname} is not neodb.social`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`cover protocol ${url.protocol}`);
  }
  return url.href;
}

function restHeaders(auth?: Headers): Record<string, string> {
  const headers: Record<string, string> = {
    'X-EmDash-Request': '1',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const authorization = auth?.get('Authorization');
  if (authorization) headers.Authorization = authorization;
  const cookie = auth?.get('Cookie');
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function restJson(
  path: string,
  auth: Headers | undefined,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${internalOrigin()}${path}`, {
    ...init,
    headers: { ...restHeaders(auth), ...(init?.headers as Record<string, string> | undefined) },
  });
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function mediaNeed(ctx: PluginContext): {
  get: NonNullable<NonNullable<PluginContext['media']>['get']>;
  list: NonNullable<NonNullable<PluginContext['media']>['list']>;
  upload: NonNullable<NonNullable<PluginContext['media']>['upload']>;
} {
  const media = ctx.media;
  if (!media?.get || !media.list || !media.upload) {
    throw new Error('ctx.media.upload is missing; declare media:write');
  }
  return { get: media.get, list: media.list, upload: media.upload };
}

async function findByFilename(
  ctx: PluginContext,
  uuid: string,
  auth?: Headers,
): Promise<StoredPoster | null> {
  const needle = `neodb-${uuid}`;
  if (!auth) return null;
  const { status, json } = await restJson(
    `/_emdash/api/media?q=${encodeURIComponent(needle)}&limit=50`,
    auth,
  );
  if (status >= 200 && status < 300 && json) {
    const data = (json.data ?? json) as { items?: Array<Record<string, unknown>> };
    const items = Array.isArray(data.items) ? data.items : [];
    const hit = items.find((item) => {
      const name = String(item.filename ?? '');
      return name === needle || name.startsWith(`${needle}.`);
    });
    const mediaId = typeof hit?.id === 'string' ? hit.id : '';
    const storageKey = typeof hit?.storageKey === 'string' ? hit.storageKey : '';
    if (mediaId && storageKey) return { mediaId, storageKey };
  }
  return null;
}

async function ensureFolder(ctx: PluginContext, auth?: Headers): Promise<string | undefined> {
  const remembered = String((await ctx.kv.get(FOLDER_KV)) ?? '').trim();
  if (remembered) return remembered;
  if (!auth) return undefined;
  const listed = await restJson(`/_emdash/api/media/folders?q=${encodeURIComponent(FOLDER_NAME)}`, auth);
  const data = listed.json?.data as { items?: Array<{ id?: string; name?: string }> } | undefined;
  const existing = data?.items?.find((item) => item.name === FOLDER_NAME && item.id);
  if (existing?.id) {
    await ctx.kv.set(FOLDER_KV, existing.id);
    return existing.id;
  }
  const created = await restJson('/_emdash/api/media/folders', auth, {
    method: 'POST',
    body: JSON.stringify({ name: FOLDER_NAME }),
  });
  const item = (created.json?.data as { item?: { id?: string } } | undefined)?.item;
  if (created.status >= 200 && created.status < 300 && item?.id) {
    await ctx.kv.set(FOLDER_KV, item.id);
    return item.id;
  }
  ctx.log.warn(`neodb-posters folder skipped: ${created.status}`);
  return undefined;
}

async function assignFolder(mediaId: string, folderId: string, auth?: Headers): Promise<void> {
  if (!auth) return;
  const { status } = await restJson(`/_emdash/api/media/${mediaId}`, auth, {
    method: 'PUT',
    body: JSON.stringify({ folderId }),
  });
  if (status >= 300) {
    // Public shelf has no session; skip folder assignment rather than fail the card.
    return;
  }
}

export async function ingestCover(
  ctx: PluginContext,
  uuid: string,
  cover: string,
  auth?: Headers,
): Promise<PosterRef> {
  if (!uuid) throw new Error('neodb uuid missing for poster ingest');
  const media = mediaNeed(ctx);
  const remembered = (await ctx.kv.get(kvKey(uuid))) as StoredPoster | null;
  if (remembered?.mediaId && remembered.storageKey) {
    const still = await media.get(remembered.mediaId);
    if (still) {
      const ref = { coverKey: remembered.storageKey, coverMediaId: remembered.mediaId, uploaded: false };
      await rememberOnItem(ctx, uuid, ref);
      const folderId = await ensureFolder(ctx, auth);
      if (folderId) await assignFolder(remembered.mediaId, folderId, auth);
      return ref;
    }
  }

  const existing = await findByFilename(ctx, uuid, auth);
  if (existing) {
    await ctx.kv.set(kvKey(uuid), existing);
    const ref = { coverKey: existing.storageKey, coverMediaId: existing.mediaId, uploaded: false };
    await rememberOnItem(ctx, uuid, ref);
    return ref;
  }

  if (!ctx.http) throw new Error('ctx.http missing; declare network:request');
  const url = absoluteCover(cover);
  let res: Response;
  try {
    res = await ctx.http.fetch(url, {
      signal: AbortSignal.timeout(FETCH_MS),
      headers: { Accept: 'image/*', 'User-Agent': UA },
    });
  } catch (err) {
    throw new Error(`cover fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`cover fetch ${url}: ${res.status}`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) throw new Error(`cover content-type ${mime || '(empty)'}`);
  const ext = EXT[mime];
  if (!ext) throw new Error(`cover content-type ${mime} is not a still image`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error(`cover ${url} is empty`);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`cover ${url} is ${bytes.byteLength} bytes`);

  const filename = `neodb-${uuid}${ext}`;
  const uploaded = await media.upload(filename, mime, bytes);
  const stored: StoredPoster = { mediaId: uploaded.mediaId, storageKey: uploaded.storageKey };
  await ctx.kv.set(kvKey(uuid), stored);
  const folderId = await ensureFolder(ctx, auth);
  if (folderId) await assignFolder(uploaded.mediaId, folderId, auth);
  const ref = { coverKey: uploaded.storageKey, coverMediaId: uploaded.mediaId, uploaded: true };
  await rememberOnItem(ctx, uuid, ref);
  return ref;
}

async function rememberOnItem(ctx: PluginContext, uuid: string, ref: PosterRef): Promise<void> {
  const store = ctx.storage.items as {
    get(id: string): Promise<{ coverKey?: string; coverMediaId?: string } | null>;
    put(id: string, data: unknown): Promise<void>;
  } | undefined;
  if (!store?.get || !store.put) return;
  const prev = await store.get(uuid);
  if (!prev) return;
  prev.coverKey = ref.coverKey;
  prev.coverMediaId = ref.coverMediaId;
  await store.put(uuid, prev);
}

// Poster URLs come from the `posterUrlTemplate` plugin setting, not from a
// baked-in CDN path. Empty template = the media library's own public URL
// (emdash's `/_emdash/api/media/file/<key>` route, the same URL
// `ctx.media.upload()` returns); no origin is assembled by the plugin.
const POSTER_SIZES = [
  { width: 96, height: 128 },
  { width: 192, height: 256 },
];

const MEDIA_FILE_PATH = '/_emdash/api/media/file/';

export function publicMediaUrl(storageKey: string): string {
  return `${MEDIA_FILE_PATH}${storageKey}`;
}

function mediaPublicOrigin(): string {
  const raw = String(process.env.S3_PUBLIC_URL ?? '').trim();
  if (!raw) throw new Error('S3_PUBLIC_URL is not set (posterUrlTemplate placeholder {origin})');
  try {
    return new URL(raw).origin.replace(/\/$/, '');
  } catch {
    throw new Error('S3_PUBLIC_URL is not a valid URL');
  }
}

function renderPosterTemplate(template: string, storageKey: string, width: number, height: number): string {
  const key = storageKey.split('/').map(encodeURIComponent).join('/');
  return template
    .replaceAll('{origin}', () => mediaPublicOrigin())
    .replaceAll('{key}', () => key)
    .replaceAll('{width}', () => String(width))
    .replaceAll('{height}', () => String(height));
}

export async function posterUrls(
  ctx: PluginContext,
  storageKey: string,
): Promise<{ poster: string; poster2x: string | undefined }> {
  const template = String((await ctx.kv.get('settings:posterUrlTemplate')) ?? '').trim();
  if (!template) {
    return { poster: publicMediaUrl(storageKey), poster2x: undefined };
  }
  const [one, two] = POSTER_SIZES.map((size) => renderPosterTemplate(template, storageKey, size.width, size.height));
  return { poster: one, poster2x: two };
}
