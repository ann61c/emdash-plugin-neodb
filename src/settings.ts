import type { PluginContext } from 'emdash';

// Single source for the `language` default: the settingsSchema in index.ts
// declares the same value. A schema-declared default is not a fallback —
// when the kv row is empty the default applies.
export const LANGUAGE_DEFAULT = 'zh-CN';

export async function languageOf(ctx: PluginContext): Promise<string> {
  const value = String((await ctx.kv.get('settings:language')) ?? '').trim();
  return value || LANGUAGE_DEFAULT;
}

export async function tokenOf(ctx: PluginContext): Promise<string> {
  const token = String((await ctx.kv.get('settings:token')) ?? '').trim();
  if (!token) throw new Error('neodb plugin setting "token" is not set');
  return token;
}
