export const NEODB_RE =
  /^https?:\/\/neodb\.social\/(book|movie|tv(?:\/season)?|album|game|podcast|performance(?:\/production)?)\/([a-zA-Z0-9]+)\/?$/i;

const TMDB_RE = /^https?:\/\/(?:www\.)?themoviedb\.org\/[^\s]+$/i;

export type ParsedNeodb = {
  kind: 'neodb';
  url: string;
  type: string;
  uuid: string;
};

export type ParsedTmdb = {
  kind: 'tmdb';
  url: string;
};

export type ParsedCard = ParsedNeodb | ParsedTmdb;

function hostnameOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function parseNeodbUrl(raw: string): ParsedNeodb | null {
  const trimmed = raw.trim();
  const m = trimmed.match(NEODB_RE);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const uuid = m[2];
  return { kind: 'neodb', url: `https://neodb.social/${type}/${uuid}`, type, uuid };
}

export function parseCardUrl(raw: string): ParsedCard | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const host = hostnameOf(trimmed);
  if (!host) return null;
  if (host === 'douban.com' || host.endsWith('.douban.com')) return null;
  const neodb = parseNeodbUrl(trimmed);
  if (neodb) return neodb;
  if (TMDB_RE.test(trimmed)) {
    return { kind: 'tmdb', url: trimmed.split('#')[0] };
  }
  return null;
}
