import { createHash } from 'node:crypto';
import type { PluginContext } from 'emdash';
import { parseCardUrl, parseNeodbUrl } from './parse';
import { languageOf, tokenOf } from './settings';
import { SNAPSHOT_VERSION } from './snapshot';
import { ITEMS_TTL_MS, UA, type ItemLink, type ItemMark, type ItemSnapshot } from './types';

type JsonRecord = Record<string, unknown>;

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

function coverUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) return `https://neodb.social${raw}`;
  return '';
}

function yearOf(data: JsonRecord): string {
  const yearRaw = data.year ?? data.pub_year ?? data.release_year;
  if (typeof yearRaw === 'number' && Number.isFinite(yearRaw)) return String(yearRaw);
  if (typeof yearRaw === 'string' && yearRaw.trim()) return yearRaw.slice(0, 4);
  if (typeof data.release_date === 'string') return data.release_date.slice(0, 4);
  return '';
}

function kindOf(category: string): string {
  if (category === 'album') return 'music';
  if (category === 'performance') return 'drama';
  return category;
}

function publicItemUrl(raw: unknown, type: string, uuid: string): string {
  if (typeof raw === 'string' && raw.startsWith('https://')) return raw;
  if (typeof raw === 'string' && raw.startsWith('/')) return `https://neodb.social${raw}`;
  return `https://neodb.social/${type}/${uuid}`;
}

function namesOf(raw: unknown, limit: number): string[] {
  if (limit <= 0) return [];
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
  const out: string[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object' && 'name' in item) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

function namedBit(label: string, raw: unknown, limit: number): string | null {
  const names = namesOf(raw, limit);
  if (!names.length) return null;
  return `${label}: ${names.join(' / ')}`;
}

function pubDateOf(data: JsonRecord): string {
  if (typeof data.pub_date === 'string' && data.pub_date.trim()) return data.pub_date.trim();
  if (typeof data.pubdate === 'string' && data.pubdate.trim()) return data.pubdate.trim();
  const year = data.pub_year;
  const month = data.pub_month;
  const yearText =
    typeof year === 'number' && Number.isFinite(year)
      ? String(year)
      : typeof year === 'string' && year.trim()
        ? year.trim()
        : '';
  if (!yearText) return '';
  const monthNum =
    typeof month === 'number' && month >= 1 && month <= 12
      ? month
      : typeof month === 'string' && month.trim() && Number.isFinite(Number(month))
        ? Number(month)
        : 0;
  if (monthNum >= 1 && monthNum <= 12) return `${yearText}-${String(monthNum).padStart(2, '0')}`;
  return yearText;
}

function houseOf(data: JsonRecord): string {
  if (typeof data.pub_house === 'string' && data.pub_house.trim()) return data.pub_house.trim();
  return namesOf(data.publisher, 1)[0] ?? '';
}

function metaBitsOf(data: JsonRecord, kind: string): string[] {
  const bits: string[] = [];
  const genres = namesOf(data.genre ?? data.genres, 3);
  if (genres.length) bits.push(`类型: ${genres.join(' / ')}`);

  if (kind === 'book') {
    const author = namedBit('作者', data.author ?? data.director, 3);
    if (author) bits.push(author);
    const translator = namedBit('译者', data.translator ?? data.actor, 2);
    if (translator) bits.push(translator);
    const house = houseOf(data);
    if (house) bits.push(house);
    const pubdate = pubDateOf(data);
    if (pubdate) bits.push(pubdate);
    return bits;
  }
  if (kind === 'game') {
    const developer = namedBit('开发者', data.developer ?? data.director, 2);
    if (developer) bits.push(developer);
    const platform = namedBit('平台', data.platform ?? data.actor, 5);
    if (platform) bits.push(platform);
    return bits;
  }

  const directorLabel = kind === 'music' ? '艺术家' : kind === 'podcast' ? '主持人' : '导演';
  const actorLabel = kind === 'music' ? '公司' : kind === 'podcast' ? '制作人' : '演员';
  const directorRaw =
    kind === 'music' ? (data.artist ?? data.director) : kind === 'podcast' ? (data.host ?? data.hosts ?? data.director) : data.director;
  const actorRaw =
    kind === 'music' ? (data.company ?? data.actor) : kind === 'podcast' ? (data.producer ?? data.actor) : data.actor;
  const director = namedBit(directorLabel, directorRaw, 2);
  if (director) bits.push(director);
  const actor = namedBit(actorLabel, actorRaw, 3);
  if (actor) bits.push(actor);
  return bits;
}

type SiteRule = { name: string; class: string; needle?: string; re?: RegExp };

const SITE_RULES: SiteRule[] = [
  { needle: 'douban.com', name: '豆瓣', class: 'douban' },
  { needle: 'themoviedb.org', name: 'TMDB', class: 'tmdb' },
  { needle: 'imdb.com', name: 'IMDb', class: 'imdb' },
  { needle: 'wikidata.org', name: '维基数据', class: 'wikidata' },
  { needle: 'spotify.com', name: 'Spotify', class: 'spotify' },
  { needle: 'goodreads.com', name: 'Goodreads', class: 'goodreads' },
  { needle: 'steampowered.com', name: 'Steam', class: 'steam' },
  { needle: 'steamcommunity.com', name: 'Steam', class: 'steam' },
  { needle: 'igdb.com', name: 'IGDB', class: 'igdb' },
  { needle: 'bangumi.tv', name: 'Bangumi', class: 'bangumi' },
  { needle: 'bgm.tv', name: 'Bangumi', class: 'bangumi' },
  { needle: 'archiveofourown.org', name: 'AO3', class: 'ao3' },
  { needle: 'qidian.com', name: '起点中文网', class: 'qidian' },
  { needle: 'jjwxc.net', name: '晋江文学城', class: 'jjwxc' },
  { needle: 'boardgamegeek.com', name: 'BGG', class: 'bgg' },
  { needle: 'books.com.tw', name: '博客来', class: 'bookstw' },
  { needle: 'books.google', name: 'Google Books', class: 'googlebooks' },
  { needle: 'bandcamp.com', name: 'Bandcamp', class: 'bandcamp' },
  { needle: 'discogs.com', name: 'Discogs', class: 'discogs' },
  { needle: 'musicbrainz.org', name: 'MusicBrainz', class: 'musicbrainz' },
  { needle: 'openlibrary.org', name: 'Open Library', class: 'openlibrary' },
  { needle: 'music.apple.com', name: 'Apple Music', class: 'apple_music' },
  { needle: 'xiaoyuzhoufm.com', name: '小宇宙', class: 'rss' },
  { re: /^https?:\/\/feed\./i, name: 'RSS', class: 'rss' },
  { needle: 'neodb.', name: 'NeoDB', class: 'fedi' },
  { needle: 'minreol.dk', name: 'minreol.dk', class: 'fedi' },
  { needle: 'eggplant.place', name: 'eggplant.place', class: 'fedi' },
  { needle: 'fantastika.social', name: 'fantastika.social', class: 'fedi' },
];

function httpUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:' ? raw : '';
  } catch {
    return '';
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'Link';
  } catch {
    return 'Link';
  }
}

function matchSite(url: string): { name: string; class: string } | null {
  for (const rule of SITE_RULES) {
    if (rule.re && rule.re.test(url)) return { name: rule.name, class: rule.class };
    if (rule.needle && url.includes(rule.needle)) return { name: rule.name, class: rule.class };
  }
  return null;
}

function linksOf(data: JsonRecord): ItemLink[] {
  const resources = Array.isArray(data.external_resources) ? data.external_resources : [];
  const links: ItemLink[] = [];
  for (const resource of resources) {
    const url = httpUrl(resource && typeof resource === 'object' ? (resource as { url?: unknown }).url : null);
    if (!url) continue;
    const site = matchSite(url);
    if (site) links.push({ url, name: site.name, class: site.class });
    else links.push({ url, name: hostLabel(url), class: 'external' });
  }
  return links;
}

const SHELF_STATUS: Record<string, string> = {
  wishlist: '想看',
  progress: '在看',
  complete: '看过',
  dropped: '不看了',
};

function markOf(data: JsonRecord): ItemMark | undefined {
  const status = SHELF_STATUS[String(data.shelf_type ?? '')];
  const created = typeof data.created_time === 'string' ? data.created_time.slice(0, 10) : '';
  if (!status || created.length < 10) return undefined;
  const gradeRaw = data.rating_grade;
  const grade =
    typeof gradeRaw === 'number' && Number.isFinite(gradeRaw) && gradeRaw > 0
      ? gradeRaw
      : typeof gradeRaw === 'string' && gradeRaw.trim() && Number.isFinite(Number(gradeRaw)) && Number(gradeRaw) > 0
        ? Number(gradeRaw)
        : null;
  return {
    visibility: 0,
    date: created,
    status,
    rating: grade,
    comment: typeof data.comment_text === 'string' ? data.comment_text : '',
  };
}

export function mapItem(data: JsonRecord, typeHint = '', uuidHint = ''): ItemSnapshot | null {
  const uuid = typeof data.uuid === 'string' && data.uuid ? data.uuid : uuidHint;
  if (!uuid) return null;
  const category = String(data.category ?? typeHint.split('/')[0] ?? '');
  const type = typeHint || category || 'movie';
  const kind = kindOf(category || type.split('/')[0]);
  const title = String(data.display_title || data.title || uuid);
  const origTitle = typeof data.orig_title === 'string' ? data.orig_title.trim() : '';
  return {
    kind,
    title,
    year: yearOf(data),
    rating: asNumber(data.rating),
    cover: coverUrl(data.cover_image_url),
    itemUrl: publicItemUrl(data.url, type, uuid),
    brief: String(data.brief || data.description || ''),
    origTitle: origTitle && origTitle !== title ? origTitle : '',
    links: linksOf(data),
    metaBits: metaBitsOf(data, kind),
    snapshotVersion: SNAPSHOT_VERSION,
    fetchedAt: Date.now(),
  };
}

type CachedSnapshot = ItemSnapshot & { cacheScope?: string };

function items(ctx: PluginContext) {
  return ctx.storage.items as {
    get(id: string): Promise<CachedSnapshot | null>;
    put(id: string, data: CachedSnapshot): Promise<void>;
  };
}

function fresh(snap: CachedSnapshot | null, scope: string): snap is CachedSnapshot {
  return Boolean(
    snap && snap.cacheScope === scope && snap.snapshotVersion === SNAPSHOT_VERSION && Date.now() - snap.fetchedAt < ITEMS_TTL_MS,
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

type RequestSettings = { token: string; language: string };

async function neodbGet(
  ctx: PluginContext,
  url: string,
  auth: boolean,
  settings: RequestSettings,
): Promise<{ status: number; data: JsonRecord | null }> {
  if (!ctx.http) return { status: 0, data: null };
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': settings.language,
    'User-Agent': UA,
  };
  if (auth) {
    headers.Authorization = `Bearer ${settings.token}`;
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await ctx.http.fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    ctx.log.warn(`fetch ${url} failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  return { status: res.status, data: asRecord(await readJson(res)) };
}

async function withMark(ctx: PluginContext, snap: ItemSnapshot, uuid: string, settings: RequestSettings): Promise<ItemSnapshot> {
  const { status, data } = await neodbGet(ctx, `https://neodb.social/api/me/shelf/item/${uuid}`, true, settings);
  if (status === 404) return snap;
  if (status !== 200) throw new Error(`neodb mark ${uuid}: HTTP ${status}`);
  if (!data || ![0, 1, 2].includes(data.visibility as number)) throw new Error(`neodb mark ${uuid}: invalid visibility`);
  if (data.visibility !== 0) return snap;
  const mark = markOf(data);
  const grade = data.rating_grade;
  const validGrade = grade == null ||
    ((typeof grade === 'number' || typeof grade === 'string') && Number.isFinite(Number(grade)));
  if (!mark || !Number.isFinite(Date.parse(mark.date)) || !validGrade ||
      (data.comment_text != null && typeof data.comment_text !== 'string')) {
    throw new Error(`neodb mark ${uuid}: invalid response`);
  }
  snap.mark = mark;
  return snap;
}

function pollUrlOf(data: JsonRecord | null, status: number): string | null {
  if (!data) return null;
  if (status !== 202 && data.queued !== true && data.status !== 'queued') return null;
  const raw = data.url ?? data.poll ?? data.poll_url;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const abs = raw.startsWith('http') ? raw : `https://neodb.social${raw.startsWith('/') ? raw : `/${raw}`}`;
    if (new URL(abs).hostname !== 'neodb.social') return null;
    return abs;
  } catch {
    return null;
  }
}

async function catalogFetch(ctx: PluginContext, itemUrl: string, settings: RequestSettings): Promise<JsonRecord | null> {
  const first = `https://neodb.social/api/catalog/fetch?url=${encodeURIComponent(itemUrl)}`;
  let url = first;
  for (let i = 0; i < 8; i += 1) {
    const { status, data } = await neodbGet(ctx, url, true, settings);
    if (status >= 200 && status < 300 && data && typeof data.uuid === 'string') return data;
    const next = pollUrlOf(data, status);
    if (!next || status === 0) {
      if (status !== 200) ctx.log.info(`fail catalog`);
      return null;
    }
    url = next;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  ctx.log.info('fail catalog poll');
  return null;
}

export async function resolve(
  url: string,
  ctx: PluginContext,
  opts?: { force?: boolean },
): Promise<ItemSnapshot | null> {
  const parsed = parseCardUrl(url);
  if (!parsed) return null;
  const force = Boolean(opts?.force);
  // Keep one slot per item; authenticated marks and localized fields require the same settings.
  const [token, language] = await Promise.all([tokenOf(ctx), languageOf(ctx)]);
  const settings = { token, language };
  const scope = createHash('sha256')
    // Invalidate snapshots cached before mark failures were distinguished from absence.
    .update(JSON.stringify(['public-marks-v3', token, language]))
    .digest('hex');

  if (parsed.kind === 'neodb') {
    if (!force) {
      const cached = await items(ctx).get(parsed.uuid);
      if (fresh(cached, scope)) return cached;
    }
    const { status, data } = await neodbGet(
      ctx,
      `https://neodb.social/api/${parsed.type}/${parsed.uuid}`,
      false,
      settings,
    );
    if (status !== 200 || !data) {
      ctx.log.info(`fail ${parsed.type}/${parsed.uuid}`);
      return null;
    }
    const snap = mapItem(data, parsed.type, parsed.uuid);
    if (!snap) return null;
    const filled = await withMark(ctx, snap, parsed.uuid, settings);
    await items(ctx).put(parsed.uuid, { ...filled, cacheScope: scope });
    ctx.log.info(`item ${parsed.type}/${parsed.uuid}`);
    return filled;
  }

  const data = await catalogFetch(ctx, parsed.url, settings);
  if (!data) return null;
  const uuid = String(data.uuid ?? '');
  if (!uuid) return null;
  if (!force) {
    const cached = await items(ctx).get(uuid);
    if (fresh(cached, scope)) return cached;
  }
  const type =
    parseNeodbUrl(typeof data.url === 'string' ? data.url : '')?.type ||
    String(data.category ?? 'movie');
  const snap = mapItem(data, type, uuid);
  if (!snap) return null;
  const filled = await withMark(ctx, snap, uuid, settings);
  await items(ctx).put(uuid, { ...filled, cacheScope: scope });
  ctx.log.info(`catalog ${uuid}`);
  return filled;
}

export async function resolveByTypeId(
  ctx: PluginContext,
  type: string,
  uuid: string,
): Promise<ItemSnapshot | null> {
  return resolve(`https://neodb.social/${type}/${uuid}`, ctx);
}
