import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  USAGE_STATS_STALE_TIME_MS,
  useNotificationStore,
  type LoadUsageStatsOptions,
  type UsageStatsMeta,
} from '@/stores';
import { usageApi } from '@/services/api/usage';
import { downloadBlob } from '@/utils/download';
import { loadModelPrices, saveModelPrices, type ModelPrice } from '@/utils/usage';

export interface UsagePayload {
  total_requests?: number;
  success_count?: number;
  failure_count?: number;
  total_tokens?: number;
  apis?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseUsageDataReturn {
  usage: UsagePayload | null;
  meta: UsageStatsMeta;
  loading: boolean;
  error: string;
  lastRefreshedAt: Date | null;
  modelPrices: Record<string, ModelPrice>;
  setModelPrices: (prices: Record<string, ModelPrice>) => void;
  loadUsage: () => Promise<void>;
  handleExport: () => Promise<void>;
  handleImport: () => void;
  handleImportChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  exporting: boolean;
  importing: boolean;
}

const createEmptyMeta = (): UsageStatsMeta => ({
  pool_filter: 'all',
  pool_filter_applied: false,
  auth_pool_filter: '',
  auth_pool_filter_applied: false,
  auth_pool_filter_defaulted: false,
  current_auth_pool: '',
  auth_pool_enabled: false,
  usage_scope_hint: '',
});

type UsageHookState = {
  usage: UsagePayload | null;
  meta: UsageStatsMeta;
  loading: boolean;
  error: string;
  lastRefreshedAt: number | null;
};

type CachedUsageScope = Omit<UsageHookState, 'loading' | 'error'>;

const createEmptyState = (): UsageHookState => ({
  usage: null,
  meta: createEmptyMeta(),
  loading: false,
  error: '',
  lastRefreshedAt: null,
});

const buildUsageScopeKey = (options: LoadUsageStatsOptions): string => {
  const pool = options.pool ?? 'all';
  const authPool = options.authPool?.trim() ?? '';
  return `${pool}::${authPool}`;
};

export function useUsageData(options: LoadUsageStatsOptions = {}): UseUsageDataReturn {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const [state, setState] = useState<UsageHookState>(() => createEmptyState());
  const [modelPrices, setModelPrices] = useState<Record<string, ModelPrice>>({});
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const cacheRef = useRef<Map<string, CachedUsageScope>>(new Map());
  const requestTokenRef = useRef(0);
  const scopeKey = useMemo(() => buildUsageScopeKey(options), [options.authPool, options.pool]);

  const loadUsageInternal = useCallback(
    async ({
      force = false,
      staleTimeMs = USAGE_STATS_STALE_TIME_MS,
    }: {
      force?: boolean;
      staleTimeMs?: number;
    } = {}) => {
      const cached = cacheRef.current.get(scopeKey);
      if (!force && cached?.lastRefreshedAt && Date.now() - cached.lastRefreshedAt < staleTimeMs) {
        setState({
          usage: cached.usage,
          meta: cached.meta,
          loading: false,
          error: '',
          lastRefreshedAt: cached.lastRefreshedAt,
        });
        return;
      }

      const requestId = (requestTokenRef.current += 1);
      setState((prev) => ({
        usage: cached?.usage ?? prev.usage,
        meta: cached?.meta ?? prev.meta,
        loading: true,
        error: '',
        lastRefreshedAt: cached?.lastRefreshedAt ?? prev.lastRefreshedAt,
      }));

      try {
        const usageResponse = await usageApi.getUsage({
          pool: options.pool,
          authPool: options.authPool,
        });
        if (requestId !== requestTokenRef.current) {
          return;
        }

        const rawUsage = usageResponse?.usage ?? usageResponse;
        const usage = rawUsage && typeof rawUsage === 'object' ? (rawUsage as UsagePayload) : null;
        const meta: UsageStatsMeta = {
          pool_filter: usageResponse?.pool_filter,
          pool_filter_applied: usageResponse?.pool_filter_applied,
          auth_pool_filter: usageResponse?.auth_pool_filter,
          auth_pool_filter_applied: usageResponse?.auth_pool_filter_applied,
          auth_pool_filter_defaulted: usageResponse?.auth_pool_filter_defaulted,
          current_auth_pool: usageResponse?.current_auth_pool,
          auth_pool_enabled: usageResponse?.auth_pool_enabled,
          usage_scope_hint: usageResponse?.usage_scope_hint,
          by_pool: usageResponse?.by_pool,
        };
        const lastRefreshedAt = Date.now();

        cacheRef.current.set(scopeKey, { usage, meta, lastRefreshedAt });
        setState({
          usage,
          meta,
          loading: false,
          error: '',
          lastRefreshedAt,
        });
      } catch (err: unknown) {
        if (requestId !== requestTokenRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : '';
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message || t('usage_stats.loading_error'),
        }));
        throw err;
      }
    },
    [options.authPool, options.pool, scopeKey, t]
  );

  const loadUsage = useCallback(async () => {
    await loadUsageInternal({ force: true, staleTimeMs: USAGE_STATS_STALE_TIME_MS });
  }, [loadUsageInternal]);

  useEffect(() => {
    const cached = cacheRef.current.get(scopeKey);
    if (cached) {
      setState({
        usage: cached.usage,
        meta: cached.meta,
        loading: false,
        error: '',
        lastRefreshedAt: cached.lastRefreshedAt,
      });
    } else {
      setState(createEmptyState());
    }

    void loadUsageInternal({ staleTimeMs: USAGE_STATS_STALE_TIME_MS }).catch(() => {});
  }, [loadUsageInternal, scopeKey]);

  useEffect(() => {
    setModelPrices(loadModelPrices());
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await usageApi.exportUsage();
      const exportedAt =
        typeof data?.exported_at === 'string' ? new Date(data.exported_at) : new Date();
      const safeTimestamp = Number.isNaN(exportedAt.getTime())
        ? new Date().toISOString()
        : exportedAt.toISOString();
      const filename = `usage-export-${safeTimestamp.replace(/[:.]/g, '-')}.json`;
      downloadBlob({
        filename,
        blob: new Blob([JSON.stringify(data ?? {}, null, 2)], { type: 'application/json' }),
      });
      showNotification(t('usage_stats.export_success'), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setExporting(false);
    }
  };

  const handleImport = () => {
    importInputRef.current?.click();
  };

  const handleImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        showNotification(t('usage_stats.import_invalid'), 'error');
        return;
      }

      const result = await usageApi.importUsage(payload);
      showNotification(
        t('usage_stats.import_success', {
          added: result?.added ?? 0,
          skipped: result?.skipped ?? 0,
          total: result?.total_requests ?? 0,
          failed: result?.failed_requests ?? 0,
        }),
        'success'
      );
      try {
        await loadUsageInternal({ force: true, staleTimeMs: USAGE_STATS_STALE_TIME_MS });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '';
        showNotification(
          `${t('notification.refresh_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      showNotification(
        `${t('notification.upload_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setImporting(false);
    }
  };

  const handleSetModelPrices = useCallback((prices: Record<string, ModelPrice>) => {
    setModelPrices(prices);
    saveModelPrices(prices);
  }, []);

  return {
    usage: state.usage,
    meta: state.meta,
    loading: state.loading,
    error: state.error,
    lastRefreshedAt: state.lastRefreshedAt ? new Date(state.lastRefreshedAt) : null,
    modelPrices,
    setModelPrices: handleSetModelPrices,
    loadUsage,
    handleExport,
    handleImport,
    handleImportChange,
    importInputRef,
    exporting,
    importing,
  };
}
