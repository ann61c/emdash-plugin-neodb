import pkg from '../package.json';

export type ItemLink = {
  url: string;
  name: string;
  class: string;
};

export type ItemMark = {
  date: string;
  status: string;
  rating: number | null;
  comment: string;
};

export type ItemSnapshot = {
  kind: string;
  title: string;
  year: string;
  rating: number;
  cover: string;
  coverKey?: string;
  coverMediaId?: string;
  itemUrl: string;
  brief: string;
  origTitle: string;
  links: ItemLink[];
  metaBits: string[];
  mark?: ItemMark;
  snapshotVersion: number;
  fetchedAt: number;
};

export const SNAPSHOT_VERSION = 3;

export type ShelfCard = {
  uuid: string;
  title: string;
  year: string;
  rating: number;
  mine: number | null;
  marked: string;
  coverKey?: string;
  poster: string;
  poster2x?: string;
  url: string;
  category: string;
};

export type ShelfPage = {
  ok: boolean;
  page: number;
  pages: number;
  count: number;
  items: ShelfCard[];
  fetchedAt?: number;
};

export const ITEMS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SHELF_TTL_MS = 60 * 60 * 1000;
export const UA = `emdash-plugin-neodb/${pkg.version}`;

export const TYPE_LABEL: Record<string, string> = {
  movie: '影视',
  book: '书籍',
  music: '音乐',
  album: '音乐',
  game: '游戏',
  drama: '戏剧',
  performance: '戏剧',
  tv: '剧集',
  podcast: '播客',
};
