const WINDOW_MS = 60_000;
const MAX_KEYS = 5000;
const buckets = new Map<string, number[]>();

function prune(now: number): void {
  for (const [key, list] of buckets) {
    if (list.every((t) => now - t >= WINDOW_MS)) buckets.delete(key);
  }
}

export function rateLimited(key: string, max: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) prune(now);
  // Still flooded after pruning: refuse (fail closed) instead of growing without bound.
  if (buckets.size > MAX_KEYS && !buckets.has(key)) return true;
  const list = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= max) {
    buckets.set(key, list);
    return true;
  }
  list.push(now);
  buckets.set(key, list);
  return false;
}
