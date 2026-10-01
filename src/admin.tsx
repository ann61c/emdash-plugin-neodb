import { apiFetch, parseApiResponse } from 'emdash/plugin-utils';
import * as React from 'react';

type Failed = { slug: string; url: string; error: string };

type RefreshResult = {
  posts: number;
  blocks: number;
  uploaded?: number;
  skipped?: number;
  failed: Failed[];
};

type RefreshStatus = {
  running: boolean;
  lastRefreshAt: string | null;
  result: RefreshResult | null;
};

function usePluginAPI() {
  return React.useMemo(
    () => ({
      get: async <T,>(route: string) => {
        const res = await apiFetch(`/_emdash/api/plugins/neodb/${route}`);
        return parseApiResponse<T>(res, 'NeoDB request failed');
      },
      post: async <T,>(route: string, body?: unknown) => {
        const res = await apiFetch(`/_emdash/api/plugins/neodb/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        return parseApiResponse<T>(res, 'NeoDB request failed');
      },
    }),
    [],
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function resultLine(result: RefreshResult | null): string {
  if (!result) return '暂无刷新记录';
  const fail = result.failed.length;
  return `已更新 ${result.posts} 篇文章 · 已检查 ${result.blocks} 张卡片 · 新上传 ${result.uploaded ?? 0} 张封面 · 复用 ${result.skipped ?? 0} 张封面 · 未完成记录 ${fail} 条`;
}

function RefreshPage() {
  const api = usePluginAPI();
  const [status, setStatus] = React.useState<RefreshStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const next = await api.get<RefreshStatus>('refresh');
    setStatus(next);
  }, [api]);

  React.useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const onRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<RefreshResult & { lastRefreshAt?: string }>('refresh');
      setStatus({
        running: false,
        lastRefreshAt: result.lastRefreshAt ?? new Date().toISOString(),
        result,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      try {
        await load();
      } catch {
        /* keep posted error */
      }
    } finally {
      setBusy(false);
    }
  };

  const running = busy || Boolean(status?.running);

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: 12 }}>NeoDB</h1>
      <p style={{ color: '#4b5563', fontSize: '0.875rem', marginBottom: 16 }}>
        重新向 NeoDB 拉取卡片快照（评分、公开的个人标记、外链、演职员），已有未发布修改的文章会跳过；刷新期间发生编辑则停止写回，保留你的修改。其余文章自动更新并保持原发布状态。未确认可见性的旧个人标记暂不展示，刷新后仅展示 NeoDB 中公开的标记。
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onRefresh}
          disabled={running}
          style={{
            padding: '0.5rem 1.25rem',
            borderRadius: 6,
            background: running ? '#9ca3af' : '#374151',
            color: 'white',
            border: 'none',
            cursor: running ? 'wait' : 'pointer',
            fontWeight: 500,
          }}
        >
          {running ? '刷新中…' : '刷新 NeoDB 数据'}
        </button>
        <div style={{ fontSize: '0.875rem', color: '#374151' }}>
          <div>上次刷新时间：{formatTime(status?.lastRefreshAt ?? null)}</div>
          <div>上次刷新结果：{resultLine(status?.result ?? null)}</div>
        </div>
      </div>
      {status?.lastRefreshAt && (
        <p style={{ marginTop: 12, color: '#6b7280', fontSize: '0.8rem' }}>
          以下是上次刷新时的记录，不代表当前仍有问题。修改文章后记录不会自动更新，再次刷新后才会替换。
          “复用封面”表示封面已存在、无需上传，不是跳过卡片更新。
        </p>
      )}
      {error && (
        <div style={{ marginTop: 12, color: '#b91c1c', fontSize: '0.875rem' }}>{error}</div>
      )}
      {status?.result?.failed?.length ? (
        <div style={{ marginTop: 16, fontSize: '0.8rem', color: '#6b7280' }}>
          <p>上次未完成的记录（包括跳过和失败，同一篇文章可能有多条）：</p>
          <ul style={{ paddingLeft: 18 }}>
          {status.result.failed.slice(0, 20).map((row, i) => (
            <li key={`${row.slug}-${row.url}-${i}`}>
              {row.slug}
              {row.url ? ` ${row.url}` : ''} — {({ 'missing url': '该卡片当时缺少链接', 'unsupported url': '当时的卡片链接不受支持', unresolved: '当时未能获取卡片资料' } as Record<string, string>)[row.error] ?? row.error}
            </li>
          ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export const pages = {
  '/refresh': RefreshPage,
};
