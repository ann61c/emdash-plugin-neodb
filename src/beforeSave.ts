import type { PluginContext } from 'emdash';
import { ingestCover } from './ingestCover';
import { parseCardUrl, parseNeodbUrl } from './parse';
import { resolve } from './resolve';
import { applySnapshot, clearSnapshot, SNAPSHOT_VERSION } from './snapshot';

type ContentEvent = {
  content: Record<string, unknown>;
  collection: string;
  isNew: boolean;
};

type Block = Record<string, unknown>;

export function* blocks(value: unknown): Generator<Block> {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Block;
    yield block;
    for (const field of ['children', 'content', 'columns']) yield* blocks(block[field]);
  }
}

function uuidOf(snapItemUrl: string, fallbackUrl: string): string {
  const fromSnap = parseNeodbUrl(snapItemUrl)?.uuid;
  if (fromSnap) return fromSnap;
  const fromCard = parseCardUrl(fallbackUrl);
  if (fromCard && fromCard.kind === 'neodb') return fromCard.uuid;
  throw new Error(`neodb snapshot missing uuid for ${fallbackUrl}`);
}

export async function beforeSave(event: ContentEvent, ctx: PluginContext) {
  const content = event.content;
  if (event.collection !== 'posts' && event.collection !== 'pages') return content;
  const pt = content.content;
  if (!Array.isArray(pt)) return content;

  for (const block of blocks(pt)) {
    if (block._type !== 'neodb') continue;
    const url = String(block.url ?? '').trim();
    if (!url) {
      clearSnapshot(block);
      block.error = 'missing url';
      continue;
    }
    if (!parseCardUrl(url)) {
      clearSnapshot(block);
      block.error = 'unsupported url';
      continue;
    }
    if (
      block.resolvedUrl === url &&
      block.itemUrl &&
      block.title &&
      block.snapshotVersion === SNAPSHOT_VERSION &&
      (!block.cover || block.coverKey)
    ) {
      continue;
    }
    clearSnapshot(block);
    const snap = await resolve(url, ctx);
    if (!snap) throw new Error(`neodb unresolved ${url}`);
    if (snap.cover) {
      const poster = await ingestCover(ctx, uuidOf(snap.itemUrl, url), snap.cover);
      snap.coverKey = poster.coverKey;
      snap.coverMediaId = poster.coverMediaId;
    }
    applySnapshot(block, snap, url);
  }

  return content;
}
