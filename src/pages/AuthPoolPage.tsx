import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
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
      windows?: Array<{ usedPercent?: number | null }>;
      groups?: Array<{ remainingFraction?: number }>;
      rows?: Array<{ used?: number; limit?: number }>;
    }
  | undefined;

const formatQuotaSummary = (quotaType: QuotaProviderType | null, quota: QuotaStateLike): string => {
  if (!quotaType || !quota || quota.status !== 'success') {
    return '';
  }

  if (quotaType === 'codex') {
    const planType = readText(quota.planType);
    const usedPercent = quota.windows?.[0]?.usedPercent;
    if (planType && typeof usedPercent === 'number') {
      return `${planType} · ${Math.max(0, Math.round(100 - usedPercent))}%`;
    }
    if (planType) return planType;
    if (typeof usedPercent === 'number') {
      return `${Math.max(0, Math.round(100 - usedPercent))}%`;
    }
  }

  if (quotaType === 'claude') {
    const planType = readText(quota.planType);
    const usedPercent = quota.windows?.[0]?.usedPercent;
    if (planType && typeof usedPercent === 'number') {
      return `${planType} · ${Math.max(0, Math.round(100 - usedPercent))}%`;
    }
    if (planType) return planType;
    if (typeof usedPercent === 'number') {
      return `${Math.max(0, Math.round(100 - usedPercent))}%`;
    }
  }

  if (quotaType === 'gemini-cli') {
    if (quota.tierLabel && typeof quota.creditBalance === 'number') {
      return `${quota.tierLabel} · ${quota.creditBalance}`;
    }
    if (quota.tierLabel) return quota.tierLabel;
    if (typeof quota.creditBalance === 'number') return String(quota.creditBalance);
  }

  if (quotaType === 'antigravity') {
    const remainingFraction = quota.groups?.[0]?.remainingFraction;
    if (typeof remainingFraction === 'number') {
      return `${Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100)}%`;
    }
  }

  if (quotaType === 'kimi') {
    const row = quota.rows?.[0];
    if (row && typeof row.used === 'number' && typeof row.limit === 'number' && row.limit > 0) {
      return `${row.used}/${row.limit}`;
    }
  }

  return '';
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
  const [currentPoolFiles, setCurrentPoolFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const disableControls = connectionStatus !== 'connected' || saving;

  const refreshAuthPool = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAuthPool(getAuthPoolStateFromConfig(useConfigStore.getState().config));
      setCurrentPoolFiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const [poolState, authFilesResponse] = await Promise.all([
        authPoolApi.getAuthPool(),
        authFilesApi.list(),
      ]);
      setAuthPool(poolState);
      setCurrentPoolFiles(authFilesResponse?.files ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
      setAuthPool(getAuthPoolStateFromConfig(config));
      setCurrentPoolFiles([]);
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, t]);

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
    if (connectionStatus !== 'connected' || currentPoolFiles.length === 0) {
      return;
    }

    let cancelled = false;
    const scheduleFetch = <TState, TData>(
      currentState: TState | undefined,
      setter: (updater: (prev: Record<string, TState>) => Record<string, TState>) => void,
      configEntry: {
        buildLoadingState: () => TState;
        buildSuccessState: (data: TData) => TState;
        buildErrorState: (message: string, status?: number) => TState;
        fetchQuota: (file: AuthFileItem, translate: TFunction) => Promise<TData>;
      },
      file: AuthFileItem
    ) => {
      const stateLike = currentState as QuotaStateLike;
      if (stateLike?.status === 'loading' || stateLike?.status === 'success') {
        return;
      }

      setter((prev: Record<string, TState>) => ({
        ...prev,
        [file.name]: configEntry.buildLoadingState(),
      }));

      void configEntry
        .fetchQuota(file, t)
        .then((data) => {
          if (cancelled) return;
          setter((prev: Record<string, TState>) => ({
            ...prev,
            [file.name]: configEntry.buildSuccessState(data),
          }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          const status =
            err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
              ? err.status
              : undefined;
          setter((prev: Record<string, TState>) => ({
            ...prev,
            [file.name]: configEntry.buildErrorState(message, status),
          }));
        });
    };

    currentPoolFiles.forEach((file) => {
      const quotaType = resolveQuotaType(file);
      if (!quotaType || file.disabled === true) {
        return;
      }

      switch (quotaType) {
        case 'antigravity':
          scheduleFetch(antigravityQuota[file.name], setAntigravityQuota, ANTIGRAVITY_CONFIG, file);
          break;
        case 'claude':
          scheduleFetch(claudeQuota[file.name], setClaudeQuota, CLAUDE_CONFIG, file);
          break;
        case 'codex':
          scheduleFetch(codexQuota[file.name], setCodexQuota, CODEX_CONFIG, file);
          break;
        case 'gemini-cli':
          scheduleFetch(geminiCliQuota[file.name], setGeminiCliQuota, GEMINI_CLI_CONFIG, file);
          break;
        case 'kimi':
          scheduleFetch(kimiQuota[file.name], setKimiQuota, KIMI_CONFIG, file);
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    antigravityQuota,
    claudeQuota,
    codexQuota,
    connectionStatus,
    currentPoolFiles,
    geminiCliQuota,
    kimiQuota,
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
  const currentStrategy = useMemo<RoutingStrategy>(() => {
    if (!currentPathKey) return authPool.currentStrategy;
    return authPool.routingStrategyByPath[currentPathKey] ?? authPool.currentStrategy;
  }, [authPool.currentStrategy, authPool.routingStrategyByPath, currentPathKey]);

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
        const strategy = authPool.routingStrategyByPath[normalizedPath] ?? 'round-robin';
        return {
          path,
          normalizedPath,
          isActive,
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
    ]
  );

  const filteredFiles = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return currentPoolFiles;
    return currentPoolFiles.filter((file) => buildSearchText(file).includes(normalizedSearch));
  }, [currentPoolFiles, search]);

  const runWithRefresh = useCallback(
    async (action: () => Promise<AuthPoolState>, successKey: string) => {
      setSaving(true);
      setError('');
      try {
        const nextState = await action();
        await waitForHotReload();
        const authFilesResponse = await authFilesApi.list().catch(() => ({ files: [] }));
        setAuthPool(nextState);
        setCurrentPoolFiles(authFilesResponse?.files ?? []);
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
    [fetchConfig, showNotification, t]
  );

  const handleAddPath = useCallback(() => {
    const nextPath = draftPath.trim();
    if (!nextPath) return;
    void runWithRefresh(async () => {
      const nextState = await authPoolApi.addPath(nextPath);
      setDraftPath('');
      return nextState;
    }, 'auth_pool.notifications.path_added');
  }, [draftPath, runWithRefresh]);

  const handleSwitchPath = useCallback(
    (path: string) => {
      if (
        !path ||
        authPoolPathsEqual(path, currentDisplayPath || authPool.activePath || authPool.authDir)
      ) {
        return;
      }
      void runWithRefresh(
        () => authPoolApi.setCurrent(path),
        'auth_pool.notifications.path_switched'
      );
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
      const targetPath = currentDisplayPath || authPool.activePath || authPool.authDir;
      if (!targetPath) return;
      void runWithRefresh(
        () => authPoolApi.setStrategy(nextStrategy, targetPath),
        'auth_pool.notifications.strategy_saved'
      );
    },
    [authPool.activePath, authPool.authDir, currentDisplayPath, runWithRefresh]
  );

  const handleFileToggle = useCallback(
    async (file: AuthFileItem) => {
      const fileName = file.name?.trim();
      if (!fileName) return;

      setSaving(true);
      setError('');
      const nextDisabled = file.disabled !== true;
      try {
        await authFilesApi.setStatus(fileName, nextDisabled);
        const authFilesResponse = await authFilesApi.list();
        setCurrentPoolFiles(authFilesResponse?.files ?? []);
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
    [showNotification, t]
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

  const renderFileQuota = useCallback(
    (file: AuthFileItem) => {
      const quotaType = resolveQuotaType(file);
      if (!quotaType) return '';

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

      return formatQuotaSummary(quotaType, quotaMap[file.name] as QuotaStateLike);
    },
    [antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, kimiQuota]
  );

  const totalFiles = currentPoolFiles.length;
  const enabledFiles = useMemo(
    () => currentPoolFiles.filter((file) => file.disabled !== true).length,
    [currentPoolFiles]
  );
  const disabledFiles = totalFiles - enabledFiles;
  const currentPoolName = useMemo(
    () => getAuthPoolName(currentDisplayPath || authPool.activePath || authPool.authDir),
    [authPool.activePath, authPool.authDir, currentDisplayPath]
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
                      <span className={`${styles.badge} ${styles.badgeActive}`}>
                        {t('auth_pool.single_active_badge')}
                      </span>
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
                          className={`${styles.pathItem} ${item.isActive ? styles.pathItemActive : ''}`}
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
                    value={currentStrategy}
                    options={strategyOptions}
                    onChange={handleStrategyChange}
                    disabled={disableControls || !currentPathKey}
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
                        {currentPoolName || t('common.not_set')}
                      </div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>{t('auth_pool.enabled_status')}</div>
                      <div className={styles.statusValue}>{t('auth_pool.current_in_use')}</div>
                    </div>
                    <div className={styles.statusTile}>
                      <div className={styles.statusLabel}>{t('auth_pool.path_count')}</div>
                      <div className={styles.statusValue}>{pathItems.length}</div>
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
            title={t('auth_pool.current_auth_files_title')}
            extra={loading ? t('common.loading') : `${totalFiles}`}
          >
            <div className={styles.cardSection}>
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
                            <div className={styles.badges}>
                              <span className={styles.badge}>
                                {getTypeLabel(t, file.type || 'unknown')}
                              </span>
                              {resolvePlanType(file) ? (
                                <span className={styles.badge}>{resolvePlanType(file)}</span>
                              ) : null}
                              {parsePriorityValue(file.priority ?? file['priority']) !==
                              undefined ? (
                                <span className={styles.badge}>
                                  P{parsePriorityValue(file.priority ?? file['priority'])}
                                </span>
                              ) : null}
                              {renderFileQuota(file) ? (
                                <span className={styles.badge}>{renderFileQuota(file)}</span>
                              ) : null}
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
                            <span className={styles.fileExtraItem}>
                              {t('stats.success')}/{t('stats.failure')}:{' '}
                              {resolveAuthFileStats(file, keyStats).success}/
                              {resolveAuthFileStats(file, keyStats).failure}
                            </span>
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
                          disabled={disableControls}
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
