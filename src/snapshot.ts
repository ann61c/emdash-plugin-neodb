import { SNAPSHOT_VERSION, type ItemSnapshot } from './types';

export { SNAPSHOT_VERSION };

export const SNAPSHOT_KEYS = [
  'title',
  'year',
  'rating',
  'cover',
  'coverKey',
  'coverMediaId',
  'kind',
  'brief',
  'itemUrl',
  'origTitle',
  'links',
  'metaBits',
  'mark',
  'snapshotVersion',
  'resolvedAt',
  'resolvedUrl',
] as const;

export function clearSnapshot(block: Record<string, unknown>): void {
  for (const key of SNAPSHOT_KEYS) delete block[key];
}

export function applySnapshot(block: Record<string, unknown>, snap: ItemSnapshot, url: string): void {
  block.title = snap.title;
  block.year = snap.year;
  block.rating = snap.rating;
  block.cover = snap.cover;
  if (snap.coverKey) block.coverKey = snap.coverKey;
  else delete block.coverKey;
  if (snap.coverMediaId) block.coverMediaId = snap.coverMediaId;
  else delete block.coverMediaId;
  block.kind = snap.kind;
  block.brief = snap.brief;
  block.itemUrl = snap.itemUrl;
  block.origTitle = snap.origTitle;
  block.links = snap.links;
  block.metaBits = snap.metaBits;
  if (snap.mark?.visibility === 0) block.mark = snap.mark;
  else delete block.mark;
  block.snapshotVersion = SNAPSHOT_VERSION;
  block.resolvedAt = new Date().toISOString();
  block.resolvedUrl = url;
  delete block.error;
}
