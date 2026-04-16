import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useThemeStore, useConfigStore, useModelsStore } from '@/stores';
import { apiKeysApi } from '@/services/api/apiKeys';
import { authFilesApi } from '@/services/api/authFiles';
import { authPoolApi } from '@/services/api/authPool';
import type { UsagePoolType } from '@/services/api/usage';
import {
  StatCards,
  UsageChart,
  ChartLineSelector,
  ApiDetailsCard,
  ModelStatsCard,
  PriceSettingsCard,
  CredentialStatsCard,
  RequestEventsDetailsCard,
  TokenBreakdownChart,
  CostTrendChart,
  ServiceHealthCard,
  useUsageData,
  useSparklines,
  useChartData,
} from '@/components/usage';
import {
  getModelNamesFromUsage,
  getApiStats,
  getModelStats,
  filterUsageByTimeRange,
  normalizeAuthIndex,
  type UsageTimeRange,
} from '@/utils/usage';
import type { AuthFileItem } from '@/types';
import {
  getAuthPoolStateFromConfig,
  normalizePathForCompare,
  normalizePathForDisplay,
  resolveAuthPoolDisplayPath,
  type AuthPoolState,
} from '@/utils/authPool';
import styles from './UsagePage.module.scss';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const CHART_LINES_STORAGE_KEY = 'cli-proxy-usage-chart-lines-v1';
const TIME_RANGE_STORAGE_KEY = 'cli-proxy-usage-time-range-v1';
const POOL_FILTER_STORAGE_KEY = 'cli-proxy-usage-pool-filter-v1';
const PATH_POOL_FILTER_PREFIX = 'path:';
const DEFAULT_CHART_LINES = ['all'];
const DEFAULT_TIME_RANGE: UsageTimeRange = '24h';
type PathPoolFilter = `path:${string}`;
type UsagePoolFilter = 'plus' | 'free' | 'all' | PathPoolFilter;
const DEFAULT_POOL_FILTER: UsagePoolFilter = 'all';
const MAX_CHART_LINES = 9;
const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: UsageTimeRange; labelKey: string }> = [
  { value: 'all', labelKey: 'usage_stats.range_all' },
  { value: '7h', labelKey: 'usage_stats.range_7h' },
  { value: '24h', labelKey: 'usage_stats.range_24h' },
  { value: '7d', labelKey: 'usage_stats.range_7d' },
];
const HOUR_WINDOW_BY_TIME_RANGE: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '7h': 7,
  '24h': 24,
  '7d': 7 * 24,
};

const normalizeApiKeyList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const keys: string[] = [];

  input.forEach((item) => {
    const record =
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    const value =
      typeof item === 'string'
        ? item
        : record
          ? (record['api-key'] ?? record['apiKey'] ?? record.key ?? record.Key)
          : '';
    const trimmed = String(value ?? '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  });

  return keys;
};

const mergeModelNames = (...sources: string[][]): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];

  sources.forEach((source) => {
    source.forEach((name) => {
      const normalized = String(name ?? '').trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(normalized);
    });
  });

  return merged.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
};

const isUsageTimeRange = (value: unknown): value is UsageTimeRange =>
  value === '7h' || value === '24h' || value === '7d' || value === 'all';

const normalizeChartLines = (value: unknown, maxLines = MAX_CHART_LINES): string[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_CHART_LINES;
  }

  const filtered = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxLines);

  return filtered.length ? filtered : DEFAULT_CHART_LINES;
};

const loadChartLines = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CHART_LINES;
    }
    const raw = localStorage.getItem(CHART_LINES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CHART_LINES;
    }
    return normalizeChartLines(JSON.parse(raw));
  } catch {
    return DEFAULT_CHART_LINES;
  }
};

const loadTimeRange = (): UsageTimeRange => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_TIME_RANGE;
    }
    const raw = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return isUsageTimeRange(raw) ? raw : DEFAULT_TIME_RANGE;
  } catch {
    return DEFAULT_TIME_RANGE;
  }
};

const isPathPoolFilter = (value: unknown): value is PathPoolFilter =>
  typeof value === 'string' && value.startsWith(PATH_POOL_FILTER_PREFIX);

const createPathPoolFilter = (normalizedPath: string): PathPoolFilter =>
  `${PATH_POOL_FILTER_PREFIX}${normalizedPath}` as PathPoolFilter;

const isUsagePoolFilter = (value: unknown): value is UsagePoolFilter =>
  value === 'plus' || value === 'free' || value === 'all' || isPathPoolFilter(value);

const loadPoolFilter = (): UsagePoolFilter => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_POOL_FILTER;
    }
    const raw = localStorage.getItem(POOL_FILTER_STORAGE_KEY);
    return isUsagePoolFilter(raw) ? raw : DEFAULT_POOL_FILTER;
  } catch {
    return DEFAULT_POOL_FILTER;
  }
};

const extractAuthDir = (raw: Record<string, unknown> | undefined): string => {
  if (!raw) return '';
  const candidates = [raw['auth-dir'], raw.authDir, raw['auth_dir']];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }

  return '';
};

const buildDefaultPoolPaths = (authDir: string): string[] => {
  const trimmed = authDir.trim();
  if (!trimmed) return [];

  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return [];

  let basePath = withoutTrailingSeparators;
  if (/[\\/](plus|free)$/i.test(withoutTrailingSeparators)) {
    const segmentIndex = Math.max(
      withoutTrailingSeparators.lastIndexOf('\\'),
      withoutTrailingSeparators.lastIndexOf('/')
    );
    if (segmentIndex <= 0) return [];
    basePath = withoutTrailingSeparators.slice(0, segmentIndex);
  }

  const separator = basePath.includes('\\') ? '\\' : '/';
  return [`${basePath}${separator}Plus`, `${basePath}${separator}Free`];
};

const getAuthFilePathCandidates = (file: AuthFileItem): string[] =>
  [file.path, file.filePath, file.filepath, file.fullPath, file.absolutePath, file.absolute_path]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

const resolveAuthFileDirectory = (path: string): string => {
  const normalized = normalizePathForDisplay(path);
  if (!normalized) return '';
  const lastSeparatorIndex = normalized.lastIndexOf('\\');
  if (lastSeparatorIndex < 0) return normalized;
  const lastSegment = normalized.slice(lastSeparatorIndex + 1);
  if (lastSegment.toLowerCase().endsWith('.json')) {
    return normalized.slice(0, lastSeparatorIndex);
  }
  return normalized;
};

const inferPoolTypeFromPath = (path: string): Exclude<UsagePoolType, 'all'> => {
  const normalized = normalizePathForCompare(path);
  if (!normalized) return 'custom';

  const segments = normalized
    .split('\\')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  for (let idx = segments.length - 1; idx >= 0; idx--) {
    const segment = segments[idx];
    if (segment === 'plus') return 'plus';
    if (segment === 'free') return 'free';
  }
  return 'custom';
};

export function UsagePage() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const availableModels = useModelsStore((state) => state.models);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);
  const apiKeysCacheRef = useRef<string[]>([]);
  const [authFilesForPools, setAuthFilesForPools] = useState<AuthFileItem[]>([]);

  // Data hook
  const [poolFilter, setPoolFilter] = useState<UsagePoolFilter>(loadPoolFilter);
  const [authPoolState, setAuthPoolState] = useState<AuthPoolState>(() =>
    getAuthPoolStateFromConfig(config)
  );
  const poolFilterInitializedRef = useRef(false);

  const loadAuthFilesForPools = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAuthFilesForPools([]);
      return;
    }

    try {
      const data = await authFilesApi.list();
      setAuthFilesForPools(data?.files || []);
    } catch {
      // Keep usage panel resilient even if auth-files endpoint is temporarily unavailable.
    }
  }, [connectionStatus]);

  const refreshAuthPool = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAuthPoolState(getAuthPoolStateFromConfig(config));
      return;
    }
    try {
      const nextState = await authPoolApi.getAuthPool();
      setAuthPoolState(nextState);
    } catch {
      setAuthPoolState(getAuthPoolStateFromConfig(config));
    }
  }, [config, connectionStatus]);

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCacheRef.current.length) {
      return apiKeysCacheRef.current;
    }

    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCacheRef.current = configKeys;
      return configKeys;
    }

    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      if (normalized.length) {
        apiKeysCacheRef.current = normalized;
      }
      return normalized;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  useEffect(() => {
    apiKeysCacheRef.current = [];
  }, [config?.apiKeys, apiBase]);

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      setAuthFilesForPools([]);
      return;
    }

    void Promise.all([
      loadAuthFilesForPools(),
      fetchConfig(undefined, true).catch(() => {}),
      refreshAuthPool(),
    ]).catch(() => {});
  }, [connectionStatus, fetchConfig, loadAuthFilesForPools, refreshAuthPool]);

  useEffect(() => {
    let cancelled = false;

    const fetchAvailableModels = async () => {
      if (connectionStatus !== 'connected' || !apiBase) {
        return;
      }

      try {
        const apiKeys = await resolveApiKeysForModels();
        if (cancelled) return;
        const primaryKey = apiKeys[0];
        await fetchModelsFromStore(apiBase, primaryKey);
      } catch {
        // Keep usage page resilient when /v1/models is unavailable.
      }
    };

    void fetchAvailableModels();
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, apiBase, fetchModelsFromStore, resolveApiKeysForModels]);

  // Chart lines state
  const [chartLines, setChartLines] = useState<string[]>(loadChartLines);
  const [timeRange, setTimeRange] = useState<UsageTimeRange>(loadTimeRange);

  const timeRangeOptions = useMemo(
    () =>
      TIME_RANGE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: t(opt.labelKey),
      })),
    [t]
  );
  const currentAuthDir = useMemo(
    () => extractAuthDir(config?.raw as Record<string, unknown> | undefined),
    [config?.raw]
  );
  const defaultPoolPaths = useMemo(() => buildDefaultPoolPaths(currentAuthDir), [currentAuthDir]);
  const discoveredPoolPaths = useMemo(() => {
    const pathMap = new Map<string, string>();

    const registerPath = (path: string) => {
      const displayPath = normalizePathForDisplay(path);
      if (!displayPath) return;
      const normalizedPath = normalizePathForCompare(displayPath);
      if (!normalizedPath || pathMap.has(normalizedPath)) return;
      pathMap.set(normalizedPath, displayPath);
    };

    if (authPoolState.enabled) {
      authPoolState.paths.forEach((path) => registerPath(path));
      registerPath(authPoolState.activePath);
      registerPath(authPoolState.authDir);
    } else {
      registerPath(currentAuthDir);
      defaultPoolPaths.forEach((path) => registerPath(path));
    }

    authFilesForPools.forEach((file) => {
      getAuthFilePathCandidates(file).forEach((candidatePath) => {
        registerPath(resolveAuthFileDirectory(candidatePath));
      });
    });

    return Array.from(pathMap.entries()).map(([normalized, display]) => ({
      normalized,
      display,
    }));
  }, [
    authFilesForPools,
    authPoolState.activePath,
    authPoolState.authDir,
    authPoolState.enabled,
    authPoolState.paths,
    currentAuthDir,
    defaultPoolPaths,
  ]);
  const poolPathDisplayMap = useMemo(
    () => new Map(discoveredPoolPaths.map((entry) => [entry.normalized, entry.display])),
    [discoveredPoolPaths]
  );
  const plusPoolPath = useMemo(
    () =>
      discoveredPoolPaths.find((entry) => /[\\]plus$/i.test(entry.normalized))?.normalized ?? '',
    [discoveredPoolPaths]
  );
  const freePoolPath = useMemo(
    () =>
      discoveredPoolPaths.find((entry) => /[\\]free$/i.test(entry.normalized))?.normalized ?? '',
    [discoveredPoolPaths]
  );
  const hasPoolPathMetadata = useMemo(
    () => authFilesForPools.some((file) => getAuthFilePathCandidates(file).length > 0),
    [authFilesForPools]
  );
  const resolvedPoolFilter = useMemo<UsagePoolFilter>(() => {
    if (isUsagePoolFilter(poolFilter)) return poolFilter;
    return DEFAULT_POOL_FILTER;
  }, [poolFilter]);
  const selectedPoolPath = useMemo(() => {
    if (resolvedPoolFilter === 'all') return '';
    if (resolvedPoolFilter === 'plus') return plusPoolPath;
    if (resolvedPoolFilter === 'free') return freePoolPath;
    if (isPathPoolFilter(resolvedPoolFilter)) {
      return normalizePathForCompare(resolvedPoolFilter.slice(PATH_POOL_FILTER_PREFIX.length));
    }
    return '';
  }, [freePoolPath, plusPoolPath, resolvedPoolFilter]);
  const requestedServerPoolType = useMemo<UsagePoolType>(() => {
    if (resolvedPoolFilter === 'all') return 'all';
    if (resolvedPoolFilter === 'plus' || resolvedPoolFilter === 'free') return resolvedPoolFilter;
    if (isPathPoolFilter(resolvedPoolFilter)) {
      return inferPoolTypeFromPath(resolvedPoolFilter.slice(PATH_POOL_FILTER_PREFIX.length));
    }
    return 'custom';
  }, [resolvedPoolFilter]);
  const currentAuthPoolDisplayPath = useMemo(
    () => resolveAuthPoolDisplayPath(authPoolState),
    [authPoolState]
  );
  const requestedAuthPoolFilter = useMemo(() => {
    if (authPoolState.enabled && resolvedPoolFilter === 'all') {
      return 'all';
    }
    if (resolvedPoolFilter === 'plus') {
      return plusPoolPath ? (poolPathDisplayMap.get(plusPoolPath) ?? plusPoolPath) : '';
    }
    if (resolvedPoolFilter === 'free') {
      return freePoolPath ? (poolPathDisplayMap.get(freePoolPath) ?? freePoolPath) : '';
    }
    if (isPathPoolFilter(resolvedPoolFilter)) {
      const normalizedPath = normalizePathForCompare(
        resolvedPoolFilter.slice(PATH_POOL_FILTER_PREFIX.length)
      );
      return poolPathDisplayMap.get(normalizedPath) ?? normalizedPath;
    }
    if (authPoolState.enabled && currentAuthPoolDisplayPath) {
      return currentAuthPoolDisplayPath;
    }
    return '';
  }, [
    authPoolState.enabled,
    currentAuthPoolDisplayPath,
    freePoolPath,
    plusPoolPath,
    poolPathDisplayMap,
    resolvedPoolFilter,
  ]);
  const usageQueryOptions = useMemo(
    () => ({
      pool:
        !requestedAuthPoolFilter && resolvedPoolFilter !== 'all'
          ? requestedServerPoolType
          : authPoolState.enabled && resolvedPoolFilter === 'all'
            ? 'all'
            : undefined,
      authPool: requestedAuthPoolFilter || undefined,
    }),
    [authPoolState.enabled, requestedAuthPoolFilter, requestedServerPoolType, resolvedPoolFilter]
  );
  const {
    usage,
    meta: usageMeta,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage,
    handleExport,
    handleImport,
    handleImportChange,
    importInputRef,
    exporting,
    importing,
  } = useUsageData(usageQueryOptions);
  const effectiveCurrentAuthPoolDisplayPath = useMemo(
    () =>
      resolveAuthPoolDisplayPath(
        authPoolState,
        typeof usageMeta.current_auth_pool === 'string' && usageMeta.current_auth_pool.trim()
          ? usageMeta.current_auth_pool
          : currentAuthPoolDisplayPath
      ),
    [authPoolState, currentAuthPoolDisplayPath, usageMeta.current_auth_pool]
  );

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([
      loadUsage(),
      loadAuthFilesForPools(),
      fetchConfig(undefined, true).catch(() => {}),
      refreshAuthPool(),
    ]);
  }, [fetchConfig, loadAuthFilesForPools, loadUsage, refreshAuthPool]);

  useHeaderRefresh(handleHeaderRefresh);
  const selectedPoolAuthIndexes = useMemo(() => {
    if (!selectedPoolPath) return new Set<string>();
    const result = new Set<string>();

    authFilesForPools.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex) return;

      const inSelectedPool = getAuthFilePathCandidates(file).some((candidatePath) => {
        const directory = normalizePathForCompare(resolveAuthFileDirectory(candidatePath));
        if (!directory) return false;
        return directory === selectedPoolPath || directory.startsWith(`${selectedPoolPath}\\`);
      });

      if (inSelectedPool) {
        result.add(authIndex);
      }
    });

    return result;
  }, [authFilesForPools, selectedPoolPath]);
  useEffect(() => {
    if (poolFilterInitializedRef.current) return;
    if (!authPoolState.enabled) {
      poolFilterInitializedRef.current = true;
      return;
    }
    const normalizedCurrentPool = normalizePathForCompare(
      currentAuthPoolDisplayPath || authPoolState.activePath || authPoolState.authDir
    );
    if (!normalizedCurrentPool) return;
    if (resolvedPoolFilter === 'all') {
      setPoolFilter(createPathPoolFilter(normalizedCurrentPool));
    }
    poolFilterInitializedRef.current = true;
  }, [
    authPoolState.activePath,
    authPoolState.authDir,
    authPoolState.enabled,
    currentAuthPoolDisplayPath,
    resolvedPoolFilter,
  ]);
  const customPoolOptions = useMemo(() => {
    const reservedPaths = new Set<string>(
      [normalizePathForCompare(currentAuthDir), plusPoolPath, freePoolPath].filter(Boolean)
    );

    return discoveredPoolPaths
      .filter((entry) => !reservedPaths.has(entry.normalized))
      .sort((left, right) =>
        left.display.localeCompare(right.display, undefined, { sensitivity: 'base' })
      )
      .map((entry) => ({
        value: createPathPoolFilter(entry.normalized),
        label: entry.display,
      }));
  }, [currentAuthDir, discoveredPoolPaths, freePoolPath, plusPoolPath]);
  const selectedCustomPoolOption = useMemo(() => {
    if (!isPathPoolFilter(resolvedPoolFilter)) return null;
    if (customPoolOptions.some((option) => option.value === resolvedPoolFilter)) return null;

    const normalizedPath = normalizePathForCompare(
      resolvedPoolFilter.slice(PATH_POOL_FILTER_PREFIX.length)
    );
    if (!normalizedPath) return null;

    return {
      value: createPathPoolFilter(normalizedPath),
      label: poolPathDisplayMap.get(normalizedPath) ?? normalizedPath,
    };
  }, [customPoolOptions, poolPathDisplayMap, resolvedPoolFilter]);
  const poolFilterOptions = useMemo(() => {
    const options: Array<{ value: UsagePoolFilter; label: string }> = [];
    const currentPoolFilter = currentAuthPoolDisplayPath
      ? createPathPoolFilter(normalizePathForCompare(currentAuthPoolDisplayPath))
      : null;
    if (authPoolState.enabled && currentPoolFilter) {
      options.push({ value: currentPoolFilter, label: t('usage_stats.pool_current') });
    }
    options.push(
      { value: 'plus', label: t('usage_stats.pool_plus') },
      { value: 'free', label: t('usage_stats.pool_free') }
    );

    if (
      selectedCustomPoolOption &&
      !options.some((option) => option.value === selectedCustomPoolOption.value)
    ) {
      options.push(selectedCustomPoolOption);
    }

    customPoolOptions.forEach((option) => {
      if (!options.some((item) => item.value === option.value)) {
        options.push(option);
      }
    });
    options.push({ value: 'all', label: t('usage_stats.pool_all') });
    return options;
  }, [
    authPoolState.enabled,
    currentAuthPoolDisplayPath,
    customPoolOptions,
    selectedCustomPoolOption,
    t,
  ]);

  const filteredUsage = useMemo(
    () => (usage ? filterUsageByTimeRange(usage, timeRange) : null),
    [usage, timeRange]
  );
  const poolScopedUsage = useMemo(() => filteredUsage, [filteredUsage]);
  const selectedPoolDisplayPath = useMemo(() => {
    if (resolvedPoolFilter === 'plus') {
      return poolPathDisplayMap.get(plusPoolPath) ?? plusPoolPath;
    }
    if (resolvedPoolFilter === 'free') {
      return poolPathDisplayMap.get(freePoolPath) ?? freePoolPath;
    }
    if (isPathPoolFilter(resolvedPoolFilter)) {
      const normalizedPath = normalizePathForCompare(
        resolvedPoolFilter.slice(PATH_POOL_FILTER_PREFIX.length)
      );
      return poolPathDisplayMap.get(normalizedPath) ?? normalizedPath;
    }
    return '';
  }, [freePoolPath, plusPoolPath, poolPathDisplayMap, resolvedPoolFilter]);
  const poolScopeLabel = useMemo(() => {
    if (authPoolState.enabled && usageMeta.current_auth_pool && resolvedPoolFilter === 'all') {
      return t('usage_stats.pool_scope_all_auth_pools');
    }
    if (resolvedPoolFilter === 'all') {
      return t('usage_stats.pool_scope_all');
    }
    if (!hasPoolPathMetadata) {
      return t('usage_stats.pool_scope_path', {
        path: t('common.not_set'),
        count: 0,
      });
    }

    const targetPath =
      selectedPoolDisplayPath || effectiveCurrentAuthPoolDisplayPath || t('common.not_set');
    return t('usage_stats.pool_scope_path', {
      path: targetPath,
      count: selectedPoolAuthIndexes.size,
    });
  }, [
    authPoolState.enabled,
    hasPoolPathMetadata,
    resolvedPoolFilter,
    selectedPoolAuthIndexes.size,
    selectedPoolDisplayPath,
    t,
    effectiveCurrentAuthPoolDisplayPath,
  ]);
  const usageScopeHint = useMemo(() => {
    if (typeof usageMeta.usage_scope_hint === 'string' && usageMeta.usage_scope_hint.trim()) {
      return usageMeta.usage_scope_hint;
    }
    if (authPoolState.enabled) {
      return t('usage_stats.auth_pool_scope_hint', {
        path: effectiveCurrentAuthPoolDisplayPath || t('common.not_set'),
      });
    }
    return '';
  }, [authPoolState.enabled, effectiveCurrentAuthPoolDisplayPath, t, usageMeta.usage_scope_hint]);
  const hourWindowHours = timeRange === 'all' ? undefined : HOUR_WINDOW_BY_TIME_RANGE[timeRange];

  const handleChartLinesChange = useCallback((lines: string[]) => {
    setChartLines(normalizeChartLines(lines));
  }, []);
  const handlePoolFilterChange = useCallback(
    (next: string) => {
      if (!isUsagePoolFilter(next)) return;
      setPoolFilter(next);
    },
    [setPoolFilter]
  );

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(CHART_LINES_STORAGE_KEY, JSON.stringify(chartLines));
    } catch {
      // Ignore storage errors.
    }
  }, [chartLines]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, timeRange);
    } catch {
      // Ignore storage errors.
    }
  }, [timeRange]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(POOL_FILTER_STORAGE_KEY, poolFilter);
    } catch {
      // Ignore storage errors.
    }
  }, [poolFilter]);

  const nowMs = lastRefreshedAt?.getTime() ?? 0;
  const effectiveLoading = loading;

  // Sparklines hook
  const { requestsSparkline, tokensSparkline, rpmSparkline, tpmSparkline, costSparkline } =
    useSparklines({ usage: poolScopedUsage, loading: effectiveLoading, nowMs });

  // Chart data hook
  const {
    requestsPeriod,
    setRequestsPeriod,
    tokensPeriod,
    setTokensPeriod,
    requestsChartData,
    tokensChartData,
    requestsChartOptions,
    tokensChartOptions,
  } = useChartData({
    usage: poolScopedUsage,
    chartLines,
    isDark,
    isMobile,
    hourWindowHours,
  });

  // Derived data
  const usageModelNames = useMemo(() => getModelNamesFromUsage(poolScopedUsage), [poolScopedUsage]);
  const apiModelNames = useMemo(
    () =>
      mergeModelNames(
        availableModels.map((model) => model.name || ''),
        availableModels
          .map((model) => model.alias || '')
          .filter((alias) => alias && alias.trim() !== '')
      ),
    [availableModels]
  );
  const priceModelNames = useMemo(
    () => mergeModelNames(usageModelNames, apiModelNames),
    [usageModelNames, apiModelNames]
  );
  const apiStats = useMemo(
    () => getApiStats(poolScopedUsage, modelPrices),
    [poolScopedUsage, modelPrices]
  );
  const modelStats = useMemo(
    () => getModelStats(poolScopedUsage, modelPrices),
    [poolScopedUsage, modelPrices]
  );
  const hasPrices = Object.keys(modelPrices).length > 0;
  const selectedPoolFilterLabel = useMemo(
    () =>
      poolFilterOptions.find((option) => option.value === resolvedPoolFilter)?.label ??
      t('common.not_set'),
    [poolFilterOptions, resolvedPoolFilter, t]
  );
  const quickPoolFilterOptions = useMemo(() => {
    const quickValues: UsagePoolFilter[] = ['plus', 'free'];
    if (isPathPoolFilter(resolvedPoolFilter)) {
      quickValues.push(resolvedPoolFilter);
    }
    quickValues.push('all');

    return quickValues.map((value) => ({
      value,
      label: poolFilterOptions.find((option) => option.value === value)?.label ?? String(value),
    }));
  }, [poolFilterOptions, resolvedPoolFilter]);

  return (
    <div className={styles.container}>
      {effectiveLoading && !usage && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('usage_stats.title')}</h1>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeGroup}>
            <span className={styles.timeRangeLabel}>{t('usage_stats.range_filter')}</span>
            <Select
              value={timeRange}
              options={timeRangeOptions}
              onChange={(value) => setTimeRange(value as UsageTimeRange)}
              className={styles.timeRangeSelectControl}
              ariaLabel={t('usage_stats.range_filter')}
              fullWidth={false}
            />
          </div>
          <div className={styles.poolFilterGroup}>
            <span className={styles.timeRangeLabel}>{t('usage_stats.pool_filter')}</span>
            <Select
              value={resolvedPoolFilter}
              options={poolFilterOptions}
              onChange={handlePoolFilterChange}
              className={styles.poolFilterSelectControl}
              ariaLabel={t('usage_stats.pool_filter')}
              fullWidth={false}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            loading={exporting}
            disabled={effectiveLoading || importing}
          >
            {t('usage_stats.export')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleImport}
            loading={importing}
            disabled={effectiveLoading || exporting}
          >
            {t('usage_stats.import')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleHeaderRefresh().catch(() => {})}
            disabled={effectiveLoading || exporting || importing}
          >
            {effectiveLoading ? t('common.loading') : t('usage_stats.refresh')}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleImportChange}
          />
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <div className={styles.poolQuickPanel}>
        <div className={styles.poolQuickHeader}>
          <span className={styles.poolQuickLabel}>{t('usage_stats.pool_filter')}</span>
          <span className={styles.poolQuickCurrent}>{selectedPoolFilterLabel}</span>
        </div>
        <div className={styles.poolQuickButtons}>
          {quickPoolFilterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.poolQuickButton} ${
                resolvedPoolFilter === option.value ? styles.poolQuickButtonActive : ''
              }`}
              onClick={() => handlePoolFilterChange(option.value)}
              title={option.label}
            >
              <span className={styles.poolQuickButtonText}>{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.poolScopeHint}>
        <span className={styles.poolScopeBadge}>{selectedPoolFilterLabel}</span>
        <span>{poolScopeLabel}</span>
      </div>
      {usageScopeHint ? <div className={styles.poolScopeHint}>{usageScopeHint}</div> : null}

      {error && <div className={styles.errorBox}>{error}</div>}

      {/* Stats Overview Cards */}
      <StatCards
        usage={poolScopedUsage}
        loading={effectiveLoading}
        modelPrices={modelPrices}
        nowMs={nowMs}
        sparklines={{
          requests: requestsSparkline,
          tokens: tokensSparkline,
          rpm: rpmSparkline,
          tpm: tpmSparkline,
          cost: costSparkline,
        }}
      />

      {/* Chart Line Selection */}
      <ChartLineSelector
        chartLines={chartLines}
        modelNames={usageModelNames}
        maxLines={MAX_CHART_LINES}
        onChange={handleChartLinesChange}
      />

      {/* Service Health */}
      <ServiceHealthCard usage={poolScopedUsage} loading={effectiveLoading} />

      {/* Charts Grid */}
      <div className={styles.chartsGrid}>
        <UsageChart
          title={t('usage_stats.requests_trend')}
          period={requestsPeriod}
          onPeriodChange={setRequestsPeriod}
          chartData={requestsChartData}
          chartOptions={requestsChartOptions}
          loading={effectiveLoading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
        <UsageChart
          title={t('usage_stats.tokens_trend')}
          period={tokensPeriod}
          onPeriodChange={setTokensPeriod}
          chartData={tokensChartData}
          chartOptions={tokensChartOptions}
          loading={effectiveLoading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
      </div>

      {/* Token Breakdown Chart */}
      <TokenBreakdownChart
        usage={poolScopedUsage}
        loading={effectiveLoading}
        isDark={isDark}
        isMobile={isMobile}
        hourWindowHours={hourWindowHours}
      />

      {/* Cost Trend Chart */}
      <CostTrendChart
        usage={poolScopedUsage}
        loading={effectiveLoading}
        isDark={isDark}
        isMobile={isMobile}
        modelPrices={modelPrices}
        hourWindowHours={hourWindowHours}
      />

      {/* Details Grid */}
      <div className={styles.detailsGrid}>
        <ApiDetailsCard apiStats={apiStats} loading={effectiveLoading} hasPrices={hasPrices} />
        <ModelStatsCard modelStats={modelStats} loading={effectiveLoading} hasPrices={hasPrices} />
      </div>

      <RequestEventsDetailsCard
        usage={poolScopedUsage}
        loading={effectiveLoading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={config?.openaiCompatibility || []}
      />

      {/* Credential Stats */}
      <CredentialStatsCard
        usage={poolScopedUsage}
        loading={effectiveLoading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={config?.openaiCompatibility || []}
      />

      {/* Price Settings */}
      <PriceSettingsCard
        modelNames={priceModelNames}
        modelPrices={modelPrices}
        onPricesChange={setModelPrices}
      />
    </div>
  );
}
