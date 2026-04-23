import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
} from '@/components/quota';
import { authPoolApi } from '@/services/api/authPool';
import { authFilesApi } from '@/services/api/authFiles';
import {
  useAuthStore,
  useConfigStore,
  useNotificationStore,
  useQuotaStore,
  useThemeStore,
  useUsageStatsStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  authPoolPathsEqual,
  getAuthPoolName,
  getAuthPoolStateFromConfig,
  normalizePathForCompare,
  resolveAuthPoolDisplayPath,
  type AuthPoolState,
  type RoutingStrategy,
} from '@/utils/authPool';
import { normalizeAuthIndex } from '@/utils/usage';
import {
  getAuthFileIcon,
  getTypeColor,
  getTypeLabel,
  parsePriorityValue,
  resolveAuthFileStats,
  type QuotaProviderType,
} from '@/features/authFiles/constants';
import { formatModified } from '@/features/authFiles/constants';
import { resolveAuthProvider } from '@/utils/quota';
import { resolveCodexPlanType } from '@/utils/quota/resolvers';
import styles from './AuthPoolPage.module.scss';

const EMPTY_AUTH_POOL_STATE: AuthPoolState = {
  enabled: false,
  paths: [],
  activePath: '',
  authDir: '',
  routingStrategyByPath: {},
  currentStrategy: 'round-robin',
};

const HOT_RELOAD_SETTLE_MS = 250;

const waitForHotReload = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, HOT_RELOAD_SETTLE_MS);
  });

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const resolvePlanType = (file: AuthFileItem): string =>
  readText(file.plan_type) || readText(file.planType) || resolveCodexPlanType(file) || '';

const resolveQuotaType = (file: AuthFileItem): QuotaProviderType | null => {
  const provider = resolveAuthProvider(file);
  if (provider === 'antigravity') return 'antigravity';
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'gemini-cli') return 'gemini-cli';
  if (provider === 'kimi') return 'kimi';
  return null;
};

type QuotaStateLike =
  | {
      status?: string;
      planType?: string | null;
      tierLabel?: string | null;
      creditBalance?: number | null;
      windows?: Array<{ id?: string; label?: string; usedPercent?: number | null }>;
      groups?: Array<{ remainingFraction?: number }>;
      rows?: Array<{ used?: number; limit?: number }>;
    }
  | undefined;

type AuthPoolMetricTone = 'neutral' | 'provider' | 'success' | 'warning' | 'danger' | 'premium';
type AuthPoolMetricSlot =
  | 'provider'
  | 'premium'
  | 'priority'
  | 'five-hour'
  | 'seven-day'
  | 'secondary';

type QuotaMetricBadge = {
  key: string;
  label: string;
  value: string;
  tone: AuthPoolMetricTone;
  slot: AuthPoolMetricSlot;
  large?: boolean;
};

const getRemainingPercentLabel = (usedPercent?: number | null): string => {
  if (typeof usedPercent !== 'number') {
    return '--';
  }
  return `${Math.max(0, Math.round(100 - usedPercent))}%`;
};

const getRemainingPercent = (usedPercent?: number | null): number | null => {
  if (typeof usedPercent !== 'number') {
    return null;
  }
  return Math.max(0, Math.round(100 - usedPercent));
};

const getMetricToneByPercent = (remainingPercent: number | null): AuthPoolMetricTone => {
  if (remainingPercent === null) {
    return 'neutral';
  }
  if (remainingPercent <= 20) {
    return 'danger';
  }
  if (remainingPercent <= 50) {
    return 'warning';
  }
  return 'success';
};

const isPremiumPlan = (value: string): boolean => /pro|max|ultra|premium/i.test(value);

const toTitleWords = (value: string): string =>
  value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');

const getPlanBadgeText = (
  file: AuthFileItem,
  quotaType: QuotaProviderType | null,
  quota: QuotaStateLike
): string => {
  const planType = readText(quota?.planType) || resolvePlanType(file);
  const tierLabel = readText(quota?.tierLabel);
  const source = tierLabel || planType;
  if (!source) {
    return '';
  }

  const normalized = source.toLowerCase().replace(/\s+/g, '');
  if (quotaType === 'codex' && normalized === 'pro') {
    return 'Pro 20x';
  }
  if (normalized.includes('prolite') || normalized.includes('pro-lite')) {
    return 'Pro Lite';
  }
  if (normalized.includes('max')) {
    return 'Max';
  }
  if (normalized.includes('ultra')) {
    return 'Ultra';
  }
  if (normalized.includes('pro')) {
    return tierLabel || 'Pro';
  }

  return toTitleWords(source);
};

const findQuotaWindow = (
  windows: Array<{ id?: string; label?: string; usedPercent?: number | null }> | undefined,
  matcher: (id: string) => boolean
) => {
  if (!Array.isArray(windows)) return undefined;
  return windows.find((window) => matcher(readText(window.id)));
};

const buildQuotaMetricBadges = (
  file: AuthFileItem,
  quotaType: QuotaProviderType | null,
  quota: QuotaStateLike,
  t: ReturnType<typeof useTranslation>['t']
): QuotaMetricBadge[] => {
  const badges: QuotaMetricBadge[] = [];
  const planText = getPlanBadgeText(file, quotaType, quota);
  const hasPremiumPlan = isPremiumPlan(planText);
  const priorityValue = parsePriorityValue(file.priority ?? file['priority']);

  badges.push({
    key: 'provider',
    label: getTypeLabel(t, file.type || 'unknown'),
    value: '',
    tone: 'provider',
    slot: 'provider',
  });

  if (planText) {
    badges.push({
      key: `plan-${planText}`,
      label: planText,
      value: '',
      tone: hasPremiumPlan ? 'premium' : 'neutral',
      slot: 'premium',
      large: hasPremiumPlan,
    });
  }

  if (priorityValue !== undefined) {
    badges.push({
      key: `priority-${priorityValue}`,
      label: `P${priorityValue}`,
      value: '',
      tone: hasPremiumPlan ? 'premium' : 'neutral',
      slot: 'priority',
    });
  }

  if (!quota) {
    return badges;
  }

  if (quota.status === 'loading') {
    badges.push({
      key: 'quota-loading',
      label: 'Quota',
      value: '...',
      tone: 'neutral',
      slot: 'secondary',
    });
    return badges;
  }

  if (quota.status !== 'success') {
    return badges;
  }

  if (quotaType === 'codex' || quotaType === 'claude') {
    const fiveHourWindow = findQuotaWindow(quota.windows, (id) => id === 'five-hour');
    const weeklyWindow = findQuotaWindow(
      quota.windows,
      (id) => id === 'weekly' || id.startsWith('seven-day')
    );

    if (fiveHourWindow) {
      const remainingPercent = getRemainingPercent(fiveHourWindow.usedPercent);
      badges.push({
        key: '5h',
        label: '5H',
        value: getRemainingPercentLabel(fiveHourWindow.usedPercent),
        tone: getMetricToneByPercent(remainingPercent),
        slot: 'five-hour',
      });
    }
    if (weeklyWindow) {
      const remainingPercent = getRemainingPercent(weeklyWindow.usedPercent);
      badges.push({
        key: '7d',
        label: '7D',
        value: getRemainingPercentLabel(weeklyWindow.usedPercent),
        tone: getMetricToneByPercent(remainingPercent),
        slot: 'seven-day',
      });
    }
  }

  if (quotaType === 'gemini-cli' && typeof quota.creditBalance === 'number') {
    badges.push({
      key: 'credits',
      label: 'Credits',
      value: String(quota.creditBalance),
      tone: hasPremiumPlan ? 'premium' : 'neutral',
      slot: 'secondary',
    });
  }

  if (quotaType === 'kimi') {
    const firstRow = quota.rows?.[0];
    if (firstRow && typeof firstRow.used === 'number' && typeof firstRow.limit === 'number') {
      badges.push({
        key: 'quota',
        label: 'Quota',
        value: `${firstRow.used}/${firstRow.limit}`,
        tone:
          firstRow.limit - firstRow.used <= 0
            ? 'danger'
            : firstRow.limit - firstRow.used >= firstRow.limit * 0.8
              ? 'success'
              : 'warning',
        slot: 'secondary',
      });
    }
  }

  if (quotaType === 'antigravity') {
    const firstGroup = quota.groups?.[0];
    if (firstGroup && typeof firstGroup.remainingFraction === 'number') {
      badges.push({
        key: 'quota',
        label: 'Quota',
        value: `${Math.round(Math.max(0, Math.min(1, firstGroup.remainingFraction)) * 100)}%`,
        tone:
          firstGroup.remainingFraction <= 0
            ? 'danger'
            : firstGroup.remainingFraction >= 0.8
              ? 'success'
              : 'warning',
        slot: 'secondary',
      });
    }
  }

  return badges;
};

const buildSearchText = (file: AuthFileItem): string =>
  [
    file.name,
    file.provider,
    file.type,
    readText(file.label),
    readText(file.email),
    readText(file.account),
    readText(file.account_type),
    readText(file.note),
    readText(file.auth_index),
    readText(file.status),
    readText(file.statusMessage),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

export function AuthPoolPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const keyStats = useUsageStatsStore((state) => state.keyStats);
  const loadUsageStats = useUsageStatsStore((state) => state.loadUsageStats);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setGeminiCliQuota = useQuotaStore((state) => state.setGeminiCliQuota);
  const setKimiQuota = useQuotaStore((state) => state.setKimiQuota);

  const [authPool, setAuthPool] = useState<AuthPoolState>(
    () => getAuthPoolStateFromConfig(config) ?? EMPTY_AUTH_POOL_STATE
  );
  const [draftPath, setDraftPath] = useState('');
  const [search, setSearch] = useState('');
  const [viewPath, setViewPath] = useState('');
  const [viewedPoolFiles, setViewedPoolFiles] = useState<AuthFileItem[]>([]);
  const [poolLoading, setPoolLoading] = useState(true);
  const [filesLoading, setFilesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const quotaQueueRunIdRef = useRef(0);
  const filesRequestIdRef = useRef(0);
  const quotaStateRef = useRef({
    antigravityQuota,
    claudeQuota,
    codexQuota,
    geminiCliQuota,
    kimiQuota,
  });

  const loading = poolLoading || filesLoading;
  const disableControls = connectionStatus !== 'connected' || saving;

  const refreshAuthPool = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAuthPool(getAuthPoolStateFromConfig(useConfigStore.getState().config));
      setViewedPoolFiles([]);
      setPoolLoading(false);
      setFilesLoading(false);
      return;
    }

    setPoolLoading(true);
    setError('');
    try {
      const poolState = await authPoolApi.getAuthPool();
      setAuthPool(poolState);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
      setAuthPool(getAuthPoolStateFromConfig(config));
      setViewedPoolFiles([]);
    } finally {
      setPoolLoading(false);
    }
  }, [config, connectionStatus, t]);

  useHeaderRefresh(refreshAuthPool);

  useEffect(() => {
    void refreshAuthPool();
  }, [refreshAuthPool]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      return;
    }
    setAuthPool(getAuthPoolStateFromConfig(config) ?? EMPTY_AUTH_POOL_STATE);
  }, [config, connectionStatus]);

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      return;
    }
    void loadUsageStats().catch(() => {});
  }, [connectionStatus, loadUsageStats]);

  useEffect(() => {
    quotaStateRef.current = {
      antigravityQuota,
      claudeQuota,
      codexQuota,
      geminiCliQuota,
      kimiQuota,
    };
  }, [antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, kimiQuota]);

  useEffect(() => {
    const currentRunId = quotaQueueRunIdRef.current + 1;
    quotaQueueRunIdRef.current = currentRunId;

    const normalizedViewedPath = normalizePathForCompare(
      viewPath || authPool.activePath || authPool.authDir
    );
    const normalizedCurrentPath = normalizePathForCompare(authPool.activePath || authPool.authDir);

    if (
      connectionStatus !== 'connected' ||
      (normalizedViewedPath !== '' &&
        normalizedCurrentPath !== '' &&
        normalizedViewedPath !== normalizedCurrentPath) ||
      viewedPoolFiles.length === 0
    ) {
      return;
    }

    const isCancelled = () => quotaQueueRunIdRef.current !== currentRunId;

    const getQuotaState = (quotaType: QuotaProviderType, fileName: string): QuotaStateLike => {
      const quotaState = quotaStateRef.current;
      switch (quotaType) {
        case 'antigravity':
          return quotaState.antigravityQuota[fileName] as QuotaStateLike;
        case 'claude':
          return quotaState.claudeQuota[fileName] as QuotaStateLike;
        case 'codex':
          return quotaState.codexQuota[fileName] as QuotaStateLike;
        case 'gemini-cli':
          return quotaState.geminiCliQuota[fileName] as QuotaStateLike;
        case 'kimi':
          return quotaState.kimiQuota[fileName] as QuotaStateLike;
        default:
          return undefined;
      }
    };

    const runSequentialQuotaFetch = async () => {
      for (const file of viewedPoolFiles) {
        if (isCancelled()) {
          return;
        }

        const quotaType = resolveQuotaType(file);
        if (!quotaType || file.disabled === true) {
          continue;
        }

        const currentState = getQuotaState(quotaType, file.name);
        if (currentState?.status === 'loading' || currentState?.status === 'success') {
          continue;
        }

        switch (quotaType) {
          case 'antigravity':
            setAntigravityQuota((prev) => ({
              ...prev,
              [file.name]: ANTIGRAVITY_CONFIG.buildLoadingState(),
            }));
            try {
              const data = await ANTIGRAVITY_CONFIG.fetchQuota(file, t);
              if (isCancelled()) return;
              setAntigravityQuota((prev) => ({
                ...prev,
                [file.name]: ANTIGRAVITY_CONFIG.buildSuccessState(data),
              }));
            } catch (err: unknown) {
              if (isCancelled()) return;
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const status =
                err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
                  ? err.status
                  : undefined;
              setAntigravityQuota((prev) => ({
                ...prev,
                [file.name]: ANTIGRAVITY_CONFIG.buildErrorState(message, status),
              }));
            }
            break;
          case 'claude':
            setClaudeQuota((prev) => ({
              ...prev,
              [file.name]: CLAUDE_CONFIG.buildLoadingState(),
            }));
            try {
              const data = await CLAUDE_CONFIG.fetchQuota(file, t);
              if (isCancelled()) return;
              setClaudeQuota((prev) => ({
                ...prev,
                [file.name]: CLAUDE_CONFIG.buildSuccessState(data),
              }));
            } catch (err: unknown) {
              if (isCancelled()) return;
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const status =
                err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
                  ? err.status
                  : undefined;
              setClaudeQuota((prev) => ({
                ...prev,
                [file.name]: CLAUDE_CONFIG.buildErrorState(message, status),
              }));
            }
            break;
          case 'codex':
            setCodexQuota((prev) => ({
              ...prev,
              [file.name]: CODEX_CONFIG.buildLoadingState(),
            }));
            try {
              const data = await CODEX_CONFIG.fetchQuota(file, t);
              if (isCancelled()) return;
              setCodexQuota((prev) => ({
                ...prev,
                [file.name]: CODEX_CONFIG.buildSuccessState(data),
              }));
            } catch (err: unknown) {
              if (isCancelled()) return;
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const status =
                err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
                  ? err.status
                  : undefined;
              setCodexQuota((prev) => ({
                ...prev,
                [file.name]: CODEX_CONFIG.buildErrorState(message, status),
              }));
            }
            break;
          case 'gemini-cli':
            setGeminiCliQuota((prev) => ({
              ...prev,
              [file.name]: GEMINI_CLI_CONFIG.buildLoadingState(),
            }));
            try {
              const data = await GEMINI_CLI_CONFIG.fetchQuota(file, t);
              if (isCancelled()) return;
              setGeminiCliQuota((prev) => ({
                ...prev,
                [file.name]: GEMINI_CLI_CONFIG.buildSuccessState(data),
              }));
            } catch (err: unknown) {
              if (isCancelled()) return;
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const status =
                err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
                  ? err.status
                  : undefined;
              setGeminiCliQuota((prev) => ({
                ...prev,
                [file.name]: GEMINI_CLI_CONFIG.buildErrorState(message, status),
              }));
            }
            break;
          case 'kimi':
            setKimiQuota((prev) => ({
              ...prev,
              [file.name]: KIMI_CONFIG.buildLoadingState(),
            }));
            try {
              const data = await KIMI_CONFIG.fetchQuota(file, t);
              if (isCancelled()) return;
              setKimiQuota((prev) => ({
                ...prev,
                [file.name]: KIMI_CONFIG.buildSuccessState(data),
              }));
            } catch (err: unknown) {
              if (isCancelled()) return;
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const status =
                err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
                  ? err.status
                  : undefined;
              setKimiQuota((prev) => ({
                ...prev,
                [file.name]: KIMI_CONFIG.buildErrorState(message, status),
              }));
            }
            break;
          default:
            break;
        }
      }
    };

    void runSequentialQuotaFetch();

    return () => {
      if (quotaQueueRunIdRef.current === currentRunId) {
        quotaQueueRunIdRef.current += 1;
      }
    };
  }, [
    authPool.activePath,
    authPool.authDir,
    connectionStatus,
    viewPath,
    viewedPoolFiles,
    setAntigravityQuota,
    setClaudeQuota,
    setCodexQuota,
    setGeminiCliQuota,
    setKimiQuota,
    t,
  ]);

  const currentDisplayPath = useMemo(() => resolveAuthPoolDisplayPath(authPool), [authPool]);
  const currentPathKey = useMemo(
    () => normalizePathForCompare(currentDisplayPath || authPool.activePath || authPool.authDir),
    [authPool.activePath, authPool.authDir, currentDisplayPath]
  );
  useEffect(() => {
    const fallbackPath =
      currentDisplayPath || authPool.activePath || authPool.authDir || authPool.paths[0] || '';

    setViewPath((previousPath) => {
      const normalizedPrevious = normalizePathForCompare(previousPath);
      if (normalizedPrevious) {
        const matchedPath = authPool.paths.find((path) => authPoolPathsEqual(path, previousPath));
        if (matchedPath) {
          return matchedPath;
        }
      }

      return fallbackPath;
    });
  }, [authPool.activePath, authPool.authDir, authPool.paths, currentDisplayPath]);

  const viewedDisplayPath = useMemo(() => {
    const normalizedViewPath = normalizePathForCompare(viewPath);
    if (normalizedViewPath) {
      return authPool.paths.find((path) => authPoolPathsEqual(path, viewPath)) ?? viewPath;
    }

    return currentDisplayPath || authPool.activePath || authPool.authDir;
  }, [authPool.activePath, authPool.authDir, authPool.paths, currentDisplayPath, viewPath]);
  const viewedPathKey = useMemo(
    () => normalizePathForCompare(viewedDisplayPath || currentDisplayPath || authPool.authDir),
    [authPool.authDir, currentDisplayPath, viewedDisplayPath]
  );
  const isViewingCurrent = useMemo(() => {
    if (!viewedPathKey || !currentPathKey) {
      return true;
    }
    return viewedPathKey === currentPathKey;
  }, [currentPathKey, viewedPathKey]);
  const selectedStrategy = useMemo<RoutingStrategy>(() => {
    if (!viewedPathKey) {
      return authPool.currentStrategy;
    }
    return authPool.routingStrategyByPath[viewedPathKey] ?? authPool.currentStrategy;
  }, [authPool.currentStrategy, authPool.routingStrategyByPath, viewedPathKey]);

  const strategyOptions = useMemo(
    () => [
      {
        value: 'round-robin',
        label: t('config_management.visual.sections.network.strategy_round_robin'),
      },
      {
        value: 'fill-first',
        label: t('config_management.visual.sections.network.strategy_fill_first'),
      },
    ],
    [t]
  );

  const pathItems = useMemo(
    () =>
      authPool.paths.map((path) => {
        const normalizedPath = normalizePathForCompare(path);
        const isActive = authPoolPathsEqual(
          path,
          currentDisplayPath || authPool.activePath || authPool.authDir
        );
        const isViewed = authPoolPathsEqual(path, viewedDisplayPath);
        const strategy = authPool.routingStrategyByPath[normalizedPath] ?? 'round-robin';
        return {
          path,
          normalizedPath,
          isActive,
          isViewed,
          strategy,
        };
      }),
    [
      authPool.activePath,
      authPool.authDir,
      authPool.currentStrategy,
      authPool.paths,
      authPool.routingStrategyByPath,
      currentDisplayPath,
      viewedDisplayPath,
    ]
  );

  const loadViewedPoolFiles = useCallback(
    async (poolState: AuthPoolState, preferredPath?: string) => {
      if (connectionStatus !== 'connected') {
        setViewedPoolFiles([]);
        setFilesLoading(false);
        return;
      }

      const targetPath =
        resolveAuthPoolDisplayPath(poolState, preferredPath) ||
        resolveAuthPoolDisplayPath(poolState) ||
        poolState.activePath ||
        poolState.authDir;
      const activePath =
        resolveAuthPoolDisplayPath(poolState) || poolState.activePath || poolState.authDir;
      const requestId = filesRequestIdRef.current + 1;
      filesRequestIdRef.current = requestId;
      setFilesLoading(true);

      try {
        const response =
          targetPath && activePath && authPoolPathsEqual(targetPath, activePath)
            ? await authFilesApi.list()
            : await authPoolApi.listFiles(targetPath);

        if (filesRequestIdRef.current !== requestId) {
          return;
        }

        setViewedPoolFiles(response?.files ?? []);
      } catch (err: unknown) {
        if (filesRequestIdRef.current !== requestId) {
          return;
        }

        const message = err instanceof Error ? err.message : t('notification.refresh_failed');
        setViewedPoolFiles([]);
        setError(message);
      } finally {
        if (filesRequestIdRef.current === requestId) {
          setFilesLoading(false);
        }
      }
    },
    [connectionStatus, t]
  );

  useEffect(() => {
    void loadViewedPoolFiles(authPool, viewedDisplayPath || viewPath);
  }, [authPool, loadViewedPoolFiles, viewPath, viewedDisplayPath]);

  const filteredFiles = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return viewedPoolFiles;
    return viewedPoolFiles.filter((file) => buildSearchText(file).includes(normalizedSearch));
  }, [viewedPoolFiles, search]);

  const runWithRefresh = useCallback(
    async (action: () => Promise<AuthPoolState>, successKey: string) => {
      setSaving(true);
      setError('');
      try {
        const nextState = await action();
        await waitForHotReload();
        setAuthPool(nextState);
        await loadViewedPoolFiles(nextState, viewedDisplayPath || viewPath);
        await fetchConfig(undefined, true).catch(() => null);
        showNotification(t(successKey), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('notification.save_failed');
        setError(message);
        showNotification(`${t('notification.save_failed')}: ${message}`, 'error');
      } finally {
        setSaving(false);
      }
    },
    [fetchConfig, loadViewedPoolFiles, showNotification, t, viewPath, viewedDisplayPath]
  );

  const handleAddPath = useCallback(() => {
    const nextPath = draftPath.trim();
    if (!nextPath) return;
    void runWithRefresh(async () => {
      const nextState = await authPoolApi.addPath(nextPath);
      setDraftPath('');
      setViewPath(resolveAuthPoolDisplayPath(nextState, nextPath) || nextPath);
      return nextState;
    }, 'auth_pool.notifications.path_added');
  }, [draftPath, runWithRefresh]);

  const handleViewPath = useCallback((path: string) => {
    if (!path) return;
    setViewPath(path);
  }, []);

  const handleSwitchPath = useCallback(
    (path: string) => {
      if (
        !path ||
        authPoolPathsEqual(path, currentDisplayPath || authPool.activePath || authPool.authDir)
      ) {
        return;
      }
      void runWithRefresh(async () => {
        const nextState = await authPoolApi.setCurrent(path);
        setViewPath(resolveAuthPoolDisplayPath(nextState, path) || path);
        return nextState;
      }, 'auth_pool.notifications.path_switched');
    },
    [authPool.activePath, authPool.authDir, currentDisplayPath, runWithRefresh]
  );

  const handleDeletePath = useCallback(
    (path: string) => {
      if (pathItems.length <= 1) return;
      void runWithRefresh(
        () => authPoolApi.deletePath(path),
        'auth_pool.notifications.path_removed'
      );
    },
    [pathItems.length, runWithRefresh]
  );

  const handleStrategyChange = useCallback(
    (value: string) => {
      const nextStrategy: RoutingStrategy = value === 'fill-first' ? 'fill-first' : 'round-robin';
      const targetPath =
        viewedDisplayPath || currentDisplayPath || authPool.activePath || authPool.authDir;
      if (!targetPath) return;
      void runWithRefresh(
        () => authPoolApi.setStrategy(nextStrategy, targetPath),
        'auth_pool.notifications.strategy_saved'
      );
    },
    [authPool.activePath, authPool.authDir, currentDisplayPath, runWithRefresh, viewedDisplayPath]
  );

  const handleFileToggle = useCallback(
    async (file: AuthFileItem) => {
      if (!isViewingCurrent) {
        return;
      }

      const fileName = file.name?.trim();
      if (!fileName) return;

      setSaving(true);
      setError('');
      const nextDisabled = file.disabled !== true;
      try {
        await authFilesApi.setStatus(fileName, nextDisabled);
        await loadViewedPoolFiles(authPool, viewedDisplayPath || viewPath);
        showNotification(
          nextDisabled
            ? t('auth_pool.notifications.auth_file_disabled')
            : t('auth_pool.notifications.auth_file_enabled'),
          'success'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('notification.update_failed');
        setError(message);
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setSaving(false);
      }
    },
    [
      authPool,
      isViewingCurrent,
      loadViewedPoolFiles,
      showNotification,
      t,
      viewPath,
      viewedDisplayPath,
    ]
  );

  const renderFileMeta = useCallback(
    (file: AuthFileItem) => {
      const parts = [
        file.provider || file.type || '',
        readText(file.email),
        readText(file.label),
        readText(file.account),
        readText(file.auth_index),
      ].filter(Boolean);

      if (parts.length === 0) {
        return t('common.not_set');
      }
      return parts.join(' · ');
    },
    [t]
  );

  const renderFileQuotaBadges = useCallback(
    (file: AuthFileItem): QuotaMetricBadge[] => {
      const quotaType = resolveQuotaType(file);
      if (!quotaType) {
        return [];
      }

      const quotaMap =
        quotaType === 'antigravity'
          ? antigravityQuota
          : quotaType === 'claude'
            ? claudeQuota
            : quotaType === 'codex'
              ? codexQuota
              : quotaType === 'gemini-cli'
                ? geminiCliQuota
                : kimiQuota;

      return buildQuotaMetricBadges(file, quotaType, quotaMap[file.name] as QuotaStateLike, t);
    },
    [antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, kimiQuota, t]
  );

  const totalFiles = viewedPoolFiles.length;
  const enabledFiles = useMemo(
    () => viewedPoolFiles.filter((file) => file.disabled !== true).length,
    [viewedPoolFiles]
  );
  const disabledFiles = totalFiles - enabledFiles;
  const activePoolName = useMemo(
    () => getAuthPoolName(currentDisplayPath || authPool.activePath || authPool.authDir),
    [authPool.activePath, authPool.authDir, currentDisplayPath]
  );
  const viewedPoolName = useMemo(
    () =>
      getAuthPoolName(
        viewedDisplayPath || currentDisplayPath || authPool.activePath || authPool.authDir
      ),
    [authPool.activePath, authPool.authDir, currentDisplayPath, viewedDisplayPath]
  );
  const hasSearch = search.trim().length > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{t('auth_pool.title')}</h1>
          <p className={styles.description}>{t('auth_pool.description')}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refreshAuthPool()}
          disabled={disableControls}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {!authPool.enabled ? (
        <Card title={t('auth_pool.page_disabled_title')}>
          <div className={styles.cardSection}>
            <div className={styles.info}>{t('auth_pool.page_disabled_hint')}</div>
          </div>
        </Card>
      ) : null}

      {authPool.enabled ? (
        <>
          <div className={styles.grid}>
            <div className={styles.stack}>
              <Card title={t('auth_pool.path_list_title')}>
                <div className={styles.cardSection}>
                  <div className={styles.summaryPanel}>
                    <div className={styles.summaryRow}>
                      <div className={styles.summaryCopy}>
                        <div className={styles.label}>{t('auth_pool.current_path')}</div>
                        <div className={styles.value}>
                          {currentDisplayPath || t('common.not_set')}
                        </div>
                      </div>
                      <div className={styles.badges}>
                        <span className={`${styles.badge} ${styles.badgeActive}`}>
                          {t('auth_pool.single_active_badge')}
                        </span>
                      </div>
                    </div>
                    <div className={styles.help}>{t('auth_pool.single_active_notice')}</div>
                  </div>

                  <div className={styles.addRow}>
                    <Input
                      label={t('auth_pool.add_path')}
                      placeholder={t('auth_pool.add_path_placeholder')}
                      value={draftPath}
                      onChange={(event) => setDraftPath(event.target.value)}
                      disabled={disableControls}
                      hint={t('auth_pool.add_path_hint')}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleAddPath}
                      disabled={disableControls || !draftPath.trim()}
                    >
                      {t('auth_pool.add_path_action')}
                    </Button>
                  </div>

                  {pathItems.length > 0 ? (
                    <div className={styles.pathList}>
                      {pathItems.map((item) => (
                        <div
                          key={item.normalizedPath || item.path}
                          className={`${styles.pathItem} ${item.isActive ? styles.pathItemActive : ''} ${
                            item.isViewed ? styles.pathItemViewed : ''
                          }`}
                        >
                          <div className={styles.pathRow}>
                            <div className={styles.pathCopy}>
                              <div className={styles.pathValue}>{item.path}</div>
                              <div className={styles.badges}>
                                {item.isActive ? (
                                  <span className={`${styles.badge} ${styles.badgeActive}`}>
                                    {t('auth_pool.current_in_use')}
                                  </span>
                                ) : null}
                                <span className={styles.badge}>
                                  {item.strategy === 'fill-first'
                                    ? t(
                                        'config_management.visual.sections.network.strategy_fill_first'
                                      )
                                    : t(
                                        'config_management.visual.sections.network.strategy_round_robin'
                                      )}
                                </span>
                              </div>
                            </div>
                            <div className={styles.rowActions}>
                              <Button
                                type="button"
                                variant={item.isViewed ? 'secondary' : 'ghost'}
                                size="sm"
                                disabled={loading}
                                onClick={() => handleViewPath(item.path)}
                              >
                                {item.isViewed
                                  ? t('auth_pool.viewing_action')
                                  : t('auth_pool.view_action')}
                              </Button>
                              <Button
                                type="button"
                                variant={item.isActive ? 'primary' : 'ghost'}
                                size="sm"
                                disabled={disableControls || item.isActive}
                                onClick={() => handleSwitchPath(item.path)}
                              >
                                {item.isActive
                                  ? t('auth_pool.current_in_use')
                                  : t('auth_pool.set_current_action')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={disableControls || item.isActive || pathItems.length <= 1}
                                onClick={() => handleDeletePath(item.path)}
                              >
                                {t('auth_pool.remove_action')}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.empty}>{t('auth_pool.empty')}</div>
                  )}
                </div>
              </Card>
            </div>

            <div className={styles.stack}>
              <Card title={t('auth_pool.current_strategy')}>
                <div className={styles.cardSection}>
                  <div className={styles.summaryRow}>
                    <div className={styles.summaryCopy}>
                      <div className={styles.label}>{t('auth_pool.current_strategy')}</div>
                      <div className={styles.help}>{t('auth_pool.current_strategy_help')}</div>
                    </div>
                  </div>
                  <Select
                    value={selectedStrategy}
                    options={strategyOptions}
                    onChange={handleStrategyChange}
                    disabled={disableControls || !viewedPathKey}
                  />
                </div>
              </Card>

              <Card
                title={t('auth_pool.status_card_title')}
                extra={loading ? t('common.loading') : null}
              >
                <div className={styles.cardSection}>
                  <div className={styles.statusGrid}>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>{t('auth_pool.current_pool_name')}</div>
                      <div className={styles.statusValue}>
                        {viewedPoolName || t('common.not_set')}
                      </div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>{t('auth_pool.path_count')}</div>
                      <div className={styles.statusValue}>{pathItems.length}</div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>{t('auth_pool.current_pool_name')}</div>
                      <div className={styles.statusValue}>
                        {activePoolName || t('common.not_set')}
                      </div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>
                        {t('auth_pool.current_auth_files_count')}
                      </div>
                      <div className={styles.statusValue}>{totalFiles}</div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>
                        {t('auth_pool.current_enabled_files')}
                      </div>
                      <div className={styles.statusValue}>{enabledFiles}</div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>
                        {t('auth_pool.current_disabled_files')}
                      </div>
                      <div className={styles.statusValue}>{disabledFiles}</div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          <Card
            title={
              isViewingCurrent
                ? t('auth_pool.current_auth_files_title')
                : t('auth_pool.runtime_auth_files_title')
            }
            extra={loading ? t('common.loading') : `${totalFiles}`}
          >
            <div className={styles.cardSection}>
              {!isViewingCurrent && viewedDisplayPath ? (
                <div className={styles.help}>{viewedDisplayPath}</div>
              ) : null}
              <div className={styles.searchRow}>
                <Input
                  label={t('auth_pool.search_label')}
                  placeholder={t('auth_pool.search_placeholder')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={disableControls && !loading}
                />
              </div>

              {filteredFiles.length > 0 ? (
                <div className={styles.fileList}>
                  {filteredFiles.map((file) => (
                    <div key={file.name} className={styles.fileItem}>
                      <div className={styles.fileVisual}>
                        <div
                          className={styles.fileAvatar}
                          style={{
                            backgroundColor: getTypeColor(file.type || 'unknown', resolvedTheme).bg,
                            color: getTypeColor(file.type || 'unknown', resolvedTheme).text,
                            ...(getTypeColor(file.type || 'unknown', resolvedTheme).border
                              ? {
                                  border: getTypeColor(file.type || 'unknown', resolvedTheme)
                                    .border,
                                }
                              : {}),
                          }}
                        >
                          {getAuthFileIcon(file.type || 'unknown', resolvedTheme) ? (
                            <img
                              src={getAuthFileIcon(file.type || 'unknown', resolvedTheme) || ''}
                              alt=""
                              className={styles.fileAvatarImage}
                            />
                          ) : (
                            <span className={styles.fileAvatarFallback}>
                              {getTypeLabel(t, file.type || 'unknown')
                                .slice(0, 1)
                                .toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className={styles.fileCopy}>
                          <div className={styles.fileHeaderRow}>
                            <div className={styles.fileName}>{file.name}</div>
                            <div className={styles.fileMetricRail}>
                              {renderFileQuotaBadges(file).map((badge) => (
                                <span
                                  key={`${file.name}-${badge.key}`}
                                  className={[
                                    styles.metricBadge,
                                    badge.large ? styles.metricBadgeLarge : '',
                                    badge.tone === 'premium' ? styles.metricBadgePremium : '',
                                    badge.tone === 'provider' ? styles.metricBadgeProvider : '',
                                    badge.tone === 'success' ? styles.metricBadgeSuccess : '',
                                    badge.tone === 'warning' ? styles.metricBadgeWarning : '',
                                    badge.tone === 'danger' ? styles.metricBadgeDanger : '',
                                    badge.slot === 'provider' ? styles.metricBadgeSlotProvider : '',
                                    badge.slot === 'premium' ? styles.metricBadgeSlotPremium : '',
                                    badge.slot === 'priority' ? styles.metricBadgeSlotPriority : '',
                                    badge.slot === 'five-hour'
                                      ? styles.metricBadgeSlotFiveHour
                                      : '',
                                    badge.slot === 'seven-day'
                                      ? styles.metricBadgeSlotSevenDay
                                      : '',
                                    badge.slot === 'secondary'
                                      ? styles.metricBadgeSlotSecondary
                                      : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                >
                                  <span className={styles.metricBadgeLabel}>{badge.label}</span>
                                  {badge.value ? (
                                    <span className={styles.metricBadgeValue}>{badge.value}</span>
                                  ) : null}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className={styles.fileMeta}>{renderFileMeta(file)}</div>
                          <div className={styles.fileExtraMeta}>
                            <span className={styles.fileExtraItem}>
                              {t('auth_files.file_modified')}: {formatModified(file)}
                            </span>
                            {normalizeAuthIndex(file['auth_index'] ?? file.authIndex) ? (
                              <span className={styles.fileExtraItem}>
                                Auth #{normalizeAuthIndex(file['auth_index'] ?? file.authIndex)}
                              </span>
                            ) : null}
                            {isViewingCurrent ? (
                              <span className={styles.fileExtraItem}>
                                {t('stats.success')}/{t('stats.failure')}:{' '}
                                {resolveAuthFileStats(file, keyStats).success}/
                                {resolveAuthFileStats(file, keyStats).failure}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className={styles.rowActions}>
                        {file.disabled === true ? (
                          <span className={styles.badge}>{t('auth_pool.auth_file_disabled')}</span>
                        ) : (
                          <span className={`${styles.badge} ${styles.badgeActive}`}>
                            {t('auth_pool.auth_file_enabled')}
                          </span>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={disableControls || !isViewingCurrent}
                          onClick={() => void handleFileToggle(file)}
                        >
                          {file.disabled === true
                            ? t('auth_pool.enable_file_action')
                            : t('auth_pool.disable_file_action')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.empty}>
                  {hasSearch
                    ? t('auth_pool.search_empty')
                    : t('auth_pool.current_auth_files_empty')}
                </div>
              )}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
