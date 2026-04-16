import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { authPoolApi } from '@/services/api/authPool';
import { authFilesApi } from '@/services/api/authFiles';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  authPoolPathsEqual,
  getAuthPoolStateFromConfig,
  normalizePathForCompare,
  resolveAuthPoolDisplayPath,
  type AuthPoolState,
  type RoutingStrategy,
} from '@/utils/authPool';
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
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);

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
      setAuthPool(getAuthPoolStateFromConfig(config));
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
        fetchConfig(undefined, true).catch(() => null),
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
  }, [config, connectionStatus, fetchConfig, t]);

  useHeaderRefresh(refreshAuthPool);

  useEffect(() => {
    void refreshAuthPool();
  }, [refreshAuthPool]);

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
        const strategy = authPool.routingStrategyByPath[normalizedPath] ?? authPool.currentStrategy;
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

  const totalFiles = currentPoolFiles.length;
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
                title={t('auth_pool.scope_card_title')}
                extra={loading ? t('common.loading') : null}
              >
                <div className={styles.cardSection}>
                  <div className={styles.info}>{t('auth_pool.single_active_notice')}</div>
                  <div className={styles.info}>{t('auth_pool.switch_effect_hint')}</div>
                  <div className={styles.info}>{t('auth_pool.scope_usage_info')}</div>
                  <div className={styles.info}>{t('auth_pool.scope_auth_files_info')}</div>
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
                      <div className={styles.fileCopy}>
                        <div className={styles.fileName}>{file.name}</div>
                        <div className={styles.fileMeta}>{renderFileMeta(file)}</div>
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
