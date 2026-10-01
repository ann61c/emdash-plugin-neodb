import { definePlugin } from 'emdash';
import type { PluginDescriptor } from 'emdash';
import { beforeSave } from './beforeSave';
import { refreshHandler } from './refresh';
import { LANGUAGE_DEFAULT } from './settings';
import { shelfHandler, shelfInput } from './shelf';

export function neodbPlugin(): PluginDescriptor {
  return {
    id: 'neodb',
    version: '0.1.0',
    format: 'native',
    entrypoint: 'emdash-plugin-neodb',
    componentsEntry: 'emdash-plugin-neodb/astro',
    adminEntry: 'emdash-plugin-neodb/admin',
    adminPages: [{ path: '/refresh', label: 'NeoDB', icon: 'book' }],
    options: {},
  };
}

export function createPlugin() {
  return definePlugin({
    id: 'neodb',
    version: '0.1.0',
    capabilities: ['network:request', 'content:write', 'media:write'],
    allowedHosts: ['neodb.social'],
    storage: {
      items: { indexes: ['fetchedAt'] },
      shelf: { indexes: ['fetchedAt'] },
    },
    admin: {
      entry: 'emdash-plugin-neodb/admin',
      pages: [{ path: '/refresh', label: 'NeoDB', icon: 'book' }],
      settingsSchema: {
        token: { type: 'secret', label: 'NeoDB token' },
        mediaToken: { type: 'secret', label: 'Media API token', description: 'EmDash token with media:read and media:write scopes for automatic poster archiving.' },
        internalToken: { type: 'secret', label: 'Internal SSR token' },
        language: {
          type: 'select',
          label: 'Language',
          default: LANGUAGE_DEFAULT,
          options: [
            { value: 'zh-CN', label: 'zh-CN' },
            { value: 'en', label: 'en' },
          ],
        },
        posterUrlTemplate: {
          type: 'string',
          label: '海报 URL 模板',
          description:
            '留空 = 直接使用媒体库公开 URL(原图)。占位符:{origin} = 媒体公开 origin(S3_PUBLIC_URL)、{key} = storageKey、{width} = 目标宽度、{height} = 目标高度。示例(Cloudflare):{origin}/cdn-cgi/image/width={width}%2Cformat=auto/{key}',
        },
      },
      portableTextBlocks: [
        {
          type: 'neodb',
          label: 'NeoDB 卡片',
          icon: 'link-external',
          description: 'NeoDB 条目卡片',
          placeholder: 'https://neodb.social/...',
          fields: [{ type: 'text_input', action_id: 'url', label: 'URL' }],
        },
      ],
    },
    hooks: {
      'content:beforeSave': { timeout: 180000, errorPolicy: 'abort', handler: beforeSave },
    },
    routes: {
      shelf: {
        public: true,
        cacheControl: 'no-store',
        input: shelfInput,
        handler: shelfHandler,
      },
      refresh: {
        permission: 'plugins:manage',
        handler: refreshHandler,
      },
    },
  });
}

export default createPlugin;
export { resolve } from './resolve';
