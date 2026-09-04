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
  if (!result) return '无记录';
  const fail = result.failed.length;
  return `posts ${result.posts} · blocks ${result.blocks} · uploaded ${result.uploaded ?? 0} · skipped ${result.skipped ?? 0} · failed ${fail}`;
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
        重新向 NeoDB 拉取卡片快照（评分、我的标记、外链、演职员），写回文章并保持原发布状态。
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
          <div>上次刷新：{formatTime(status?.lastRefreshAt ?? null)}</div>
          <div>上次结果：{resultLine(status?.result ?? null)}</div>
        </div>
      </div>
      {error && (
        <div style={{ marginTop: 12, color: '#b91c1c', fontSize: '0.875rem' }}>{error}</div>
      )}
      {status?.result?.failed?.length ? (
        <ul style={{ marginTop: 16, fontSize: '0.8rem', color: '#6b7280', paddingLeft: 18 }}>
          {status.result.failed.slice(0, 20).map((row, i) => (
            <li key={`${row.slug}-${row.url}-${i}`}>
              {row.slug}
              {row.url ? ` ${row.url}` : ''} — {row.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const pages = {
  '/refresh': RefreshPage,
};
