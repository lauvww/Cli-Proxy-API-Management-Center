import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  IconKey,
  IconBot,
  IconFileText,
  IconSatellite
} from '@/components/ui/icons';
import { useAuthStore, useConfigStore, useModelsStore, useNotificationStore } from '@/stores';
import { apiCallApi, apiKeysApi, providersApi, authFilesApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import styles from './DashboardPage.module.scss';

interface QuickStat {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  path: string;
  loading?: boolean;
  sublabel?: string;
}

interface ProviderStats {
  gemini: number | null;
  codex: number | null;
  claude: number | null;
  openai: number | null;
}

type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
type ScannerAction = 'scan' | 'delete' | null;

interface InvalidCodexSummary {
  checked: number;
  invalid: number;
  disabled: number;
  deleted: number;
  errors: number;
  lastAction: Exclude<ScannerAction, null> | null;
  lastRunAt: number | null;
}

interface CodexQuotaCheckResult {
  name: string;
  statusCode: number;
  errorMessage?: string;
}

const INVALID_SCAN_CONCURRENCY = 20;
const INVALID_SCAN_TIMEOUT_MS = 30_000;
const INVALID_SCAN_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const INVALID_SCAN_USER_AGENT =
  'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const readStringLike = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const resolveAuthFileName = (file: AuthFileItem): string => {
  const candidates = [file.name, file.id, file['file_name'], file['fileName']];
  for (const value of candidates) {
    const normalized = readStringLike(value);
    if (normalized) return normalized;
  }
  return '';
};

const resolveAuthIndex = (file: AuthFileItem): string => {
  const candidates = [file.authIndex, file['auth_index'], file['auth-index']];
  for (const value of candidates) {
    const normalized = readStringLike(value);
    if (normalized) return normalized;
  }
  return '';
};

const resolveCodexAccountId = (file: AuthFileItem): string => {
  const idToken = asRecord(file['id_token']) ?? asRecord(file['idToken']);
  if (!idToken) return '';
  return readStringLike(idToken['chatgpt_account_id'] ?? idToken['chatgptAccountId']);
};

const resolveProvider = (file: AuthFileItem): string => {
  return readStringLike(file.provider || file.type).toLowerCase();
};

const isAuthFileDisabled = (file: AuthFileItem): boolean => {
  const raw = file.disabled ?? file['is_disabled'] ?? file['isDisabled'];
  if (typeof raw === 'boolean') return raw;
  const normalized = readStringLike(raw).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  values.forEach((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    deduped.push(normalized);
  });
  return deduped;
};

async function runConcurrentTasks<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) break;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const { showNotification } = useNotificationStore();

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const [stats, setStats] = useState<{
    apiKeys: number | null;
    authFiles: number | null;
  }>({
    apiKeys: null,
    authFiles: null
  });

  const [providerStats, setProviderStats] = useState<ProviderStats>({
    gemini: null,
    codex: null,
    claude: null,
    openai: null
  });

  const [loading, setLoading] = useState(true);
  const [scannerAction, setScannerAction] = useState<ScannerAction>(null);
  const [codexSummary, setCodexSummary] = useState<InvalidCodexSummary>({
    checked: 0,
    invalid: 0,
    disabled: 0,
    deleted: 0,
    errors: 0,
    lastAction: null,
    lastRunAt: null
  });

  // Time-of-day state for dynamic greeting
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>(getTimeOfDay);
  const [currentTime, setCurrentTime] = useState(() => new Date());

  const apiKeysCache = useRef<string[]>([]);

  useEffect(() => {
    apiKeysCache.current = [];
  }, [apiBase, config?.apiKeys]);

  // Update time every 60 seconds
  useEffect(() => {
    const id = setInterval(() => {
      setTimeOfDay(getTimeOfDay());
      setCurrentTime(new Date());
    }, 60_000);
    return () => clearInterval(id);
  }, []);

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

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCache.current.length) {
      return apiKeysCache.current;
    }

    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCache.current = configKeys;
      return configKeys;
    }

    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      if (normalized.length) {
        apiKeysCache.current = normalized;
      }
      return normalized;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase) {
      return;
    }

    try {
      const apiKeys = await resolveApiKeysForModels();
      const primaryKey = apiKeys[0];
      await fetchModelsFromStore(apiBase, primaryKey);
    } catch {
      // Ignore model fetch errors on dashboard
    }
  }, [connectionStatus, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      try {
        const [keysRes, filesRes, geminiRes, codexRes, claudeRes, openaiRes] = await Promise.allSettled([
          apiKeysApi.list(),
          authFilesApi.list(),
          providersApi.getGeminiKeys(),
          providersApi.getCodexConfigs(),
          providersApi.getClaudeConfigs(),
          providersApi.getOpenAIProviders()
        ]);

        setStats({
          apiKeys: keysRes.status === 'fulfilled' ? keysRes.value.length : null,
          authFiles: filesRes.status === 'fulfilled' ? filesRes.value.files.length : null
        });

        setProviderStats({
          gemini: geminiRes.status === 'fulfilled' ? geminiRes.value.length : null,
          codex: codexRes.status === 'fulfilled' ? codexRes.value.length : null,
          claude: claudeRes.status === 'fulfilled' ? claudeRes.value.length : null,
          openai: openaiRes.status === 'fulfilled' ? openaiRes.value.length : null
        });
      } finally {
        setLoading(false);
      }
    };

    if (connectionStatus === 'connected') {
      fetchStats();
      fetchModels();
    } else {
      setLoading(false);
    }
  }, [connectionStatus, fetchModels]);

  const scanInvalidCodexAuthFiles = async () => {
    if (scannerAction) return;
    setScannerAction('scan');

    try {
      const response = await authFilesApi.list();
      const codexFiles = response.files.filter(
        (file) => resolveProvider(file) === 'codex' && !isAuthFileDisabled(file)
      );

      if (!codexFiles.length) {
        setCodexSummary((prev) => ({
          ...prev,
          checked: 0,
          invalid: 0,
          disabled: 0,
          errors: 0,
          lastAction: 'scan',
          lastRunAt: Date.now()
        }));
        showNotification(t('dashboard.codex_scan_no_targets'), 'info');
        return;
      }

      const checkResults = await runConcurrentTasks<AuthFileItem, CodexQuotaCheckResult>(
        codexFiles,
        INVALID_SCAN_CONCURRENCY,
        async (file) => {
          const name = resolveAuthFileName(file) || '-';
          const authIndex = resolveAuthIndex(file);
          if (!authIndex) {
            return {
              name,
              statusCode: -1,
              errorMessage: 'Missing auth index'
            };
          }

          const accountId = resolveCodexAccountId(file);
          const header: Record<string, string> = {
            Authorization: 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': INVALID_SCAN_USER_AGENT
          };
          if (accountId) {
            header['Chatgpt-Account-Id'] = accountId;
          }

          try {
            const result = await apiCallApi.request(
              {
                authIndex,
                method: 'GET',
                url: INVALID_SCAN_USAGE_URL,
                header
              },
              { timeout: INVALID_SCAN_TIMEOUT_MS }
            );
            return { name, statusCode: result.statusCode };
          } catch (err: unknown) {
            const message =
              err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : 'Request failed';
            return {
              name,
              statusCode: -1,
              errorMessage: message
            };
          }
        }
      );

      const invalidNames = dedupeStrings(
        checkResults.filter((item) => item.statusCode === 401).map((item) => item.name)
      );

      let disabledCount = 0;
      let disableErrorCount = 0;

      if (invalidNames.length) {
        const disableResults = await runConcurrentTasks<string, boolean>(
          invalidNames,
          INVALID_SCAN_CONCURRENCY,
          async (name) => {
            try {
              await authFilesApi.setStatus(name, true);
              return true;
            } catch {
              return false;
            }
          }
        );
        disabledCount = disableResults.filter(Boolean).length;
        disableErrorCount = disableResults.length - disabledCount;
      }

      const checkErrorCount = checkResults.filter((item) => item.statusCode < 0).length;
      const checkMessageErrorCount = checkResults.filter((item) => item.errorMessage).length;
      const totalErrorCount = checkErrorCount + disableErrorCount;

      setCodexSummary((prev) => ({
        ...prev,
        checked: checkResults.length,
        invalid: invalidNames.length,
        disabled: disabledCount,
        errors: totalErrorCount,
        lastAction: 'scan',
        lastRunAt: Date.now()
      }));

      if (!invalidNames.length) {
        showNotification(t('dashboard.codex_scan_no_401'), 'success');
      } else if (disabledCount === invalidNames.length && totalErrorCount === 0) {
        showNotification(
          t('dashboard.codex_scan_done', {
            checked: checkResults.length,
            invalid: invalidNames.length,
            disabled: disabledCount
          }),
          'success'
        );
      } else {
        showNotification(
          t('dashboard.codex_scan_partial', {
            checked: checkResults.length,
            invalid: invalidNames.length,
            disabled: disabledCount,
            failed: invalidNames.length - disabledCount
          }),
          'warning'
        );
      }

      if (checkMessageErrorCount > 0 || disableErrorCount > 0) {
        showNotification(
          t('dashboard.codex_scan_error_count', {
            checkErrors: checkMessageErrorCount,
            disableErrors: disableErrorCount
          }),
          'warning'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(`${t('notification.load_failed')}: ${message}`, 'error');
    } finally {
      setScannerAction(null);
    }
  };

  const deleteDisabledCodexAuthFiles = async () => {
    if (scannerAction) return;
    setScannerAction('delete');

    try {
      const response = await authFilesApi.list();
      const targets = dedupeStrings(
        response.files
          .filter((file) => resolveProvider(file) === 'codex' && isAuthFileDisabled(file))
          .map((file) => resolveAuthFileName(file))
      );

      if (!targets.length) {
        setCodexSummary((prev) => ({
          ...prev,
          deleted: 0,
          errors: 0,
          lastAction: 'delete',
          lastRunAt: Date.now()
        }));
        showNotification(t('dashboard.codex_delete_no_targets'), 'info');
        return;
      }

      const deleteResults = await runConcurrentTasks<string, boolean>(
        targets,
        INVALID_SCAN_CONCURRENCY,
        async (name) => {
          try {
            const result = await authFilesApi.deleteFile(name);
            return result.deleted > 0 || result.status === 'ok';
          } catch {
            return false;
          }
        }
      );

      const deletedCount = deleteResults.filter(Boolean).length;
      const deleteErrorCount = deleteResults.length - deletedCount;

      setCodexSummary((prev) => ({
        ...prev,
        deleted: deletedCount,
        errors: deleteErrorCount,
        lastAction: 'delete',
        lastRunAt: Date.now()
      }));

      setStats((prev) => ({
        ...prev,
        authFiles: prev.authFiles !== null ? Math.max(prev.authFiles - deletedCount, 0) : prev.authFiles
      }));

      if (deletedCount === targets.length && deleteErrorCount === 0) {
        showNotification(
          t('dashboard.codex_delete_done', {
            found: targets.length,
            deleted: deletedCount
          }),
          'success'
        );
      } else {
        showNotification(
          t('dashboard.codex_delete_partial', {
            found: targets.length,
            deleted: deletedCount,
            failed: targets.length - deletedCount
          }),
          'warning'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
    } finally {
      setScannerAction(null);
    }
  };

  // Calculate total provider keys only when all provider stats are available.
  const providerStatsReady =
    providerStats.gemini !== null &&
    providerStats.codex !== null &&
    providerStats.claude !== null &&
    providerStats.openai !== null;
  const hasProviderStats =
    providerStats.gemini !== null ||
    providerStats.codex !== null ||
    providerStats.claude !== null ||
    providerStats.openai !== null;
  const totalProviderKeys = providerStatsReady
    ? (providerStats.gemini ?? 0) +
      (providerStats.codex ?? 0) +
      (providerStats.claude ?? 0) +
      (providerStats.openai ?? 0)
    : 0;

  const quickStats: QuickStat[] = [
    {
      label: t('dashboard.management_keys'),
      value: stats.apiKeys ?? '-',
      icon: <IconKey size={24} />,
      path: '/config',
      loading: loading && stats.apiKeys === null,
      sublabel: t('nav.config_management')
    },
    {
      label: t('nav.ai_providers'),
      value: loading ? '-' : providerStatsReady ? totalProviderKeys : '-',
      icon: <IconBot size={24} />,
      path: '/ai-providers',
      loading: loading,
      sublabel: hasProviderStats
        ? t('dashboard.provider_keys_detail', {
            gemini: providerStats.gemini ?? '-',
            codex: providerStats.codex ?? '-',
            claude: providerStats.claude ?? '-',
            openai: providerStats.openai ?? '-'
          })
        : undefined
    },
    {
      label: t('nav.auth_files'),
      value: stats.authFiles ?? '-',
      icon: <IconFileText size={24} />,
      path: '/auth-files',
      loading: loading && stats.authFiles === null,
      sublabel: t('dashboard.oauth_credentials')
    },
    {
      label: t('dashboard.available_models'),
      value: modelsLoading ? '-' : models.length,
      icon: <IconSatellite size={24} />,
      path: '/system',
      loading: modelsLoading,
      sublabel: t('dashboard.available_models_desc')
    }
  ];

  const routingStrategyRaw = config?.routingStrategy?.trim() || '';
  const routingStrategyDisplay = !routingStrategyRaw
    ? '-'
    : routingStrategyRaw === 'round-robin'
      ? t('basic_settings.routing_strategy_round_robin')
      : routingStrategyRaw === 'fill-first'
        ? t('basic_settings.routing_strategy_fill_first')
        : routingStrategyRaw;
  const routingStrategyBadgeClass = !routingStrategyRaw
    ? styles.configBadgeUnknown
    : routingStrategyRaw === 'round-robin'
      ? styles.configBadgeRoundRobin
      : routingStrategyRaw === 'fill-first'
        ? styles.configBadgeFillFirst
        : styles.configBadgeUnknown;

  // Derived time-based values
  const greetingKey = `dashboard.greeting_${timeOfDay}`;
  const caringKey = `dashboard.caring_${timeOfDay}`;

  const formattedDate = currentTime.toLocaleDateString(i18n.language, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const formattedTime = currentTime.toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  });

  const codexSummaryLastRunText = codexSummary.lastRunAt
    ? new Date(codexSummary.lastRunAt).toLocaleString(i18n.language)
    : t('dashboard.codex_last_run_never');
  const codexSummaryActionText =
    codexSummary.lastAction === 'scan'
      ? t('dashboard.codex_action_scan')
      : codexSummary.lastAction === 'delete'
        ? t('dashboard.codex_action_delete')
        : t('dashboard.codex_action_none');

  return (
    <div className={styles.dashboard}>
      {/* Decorative background orbs */}
      <div className={styles.backgroundOrbs} aria-hidden="true">
        <div className={styles.orb1} />
        <div className={styles.orb2} />
      </div>

      {/* Hero welcome section */}
      <section className={styles.hero}>
        <span className={styles.heroWatermark} aria-hidden="true">
          OVERVIEW
        </span>
        <div className={styles.heroContent}>
          <span className={styles.heroGreeting}>{t(greetingKey)}</span>
          <h1 className={styles.heroTitle}>{t('dashboard.welcome_back')}</h1>
          <p className={styles.heroCaring}>{t(caringKey)}</p>
        </div>
        <div className={styles.heroMeta}>
          <div className={styles.dateTimeBlock}>
            <span className={styles.time}>{formattedTime}</span>
            <span className={styles.date}>{formattedDate}</span>
          </div>
          <div className={styles.connectionPill}>
            <span
              className={`${styles.statusDot} ${
                connectionStatus === 'connected'
                  ? styles.connected
                  : connectionStatus === 'connecting'
                    ? styles.connecting
                    : styles.disconnected
              }`}
            />
            <span className={styles.pillText}>
              {serverVersion
                ? `v${serverVersion.trim().replace(/^[vV]+/, '')}`
                : t(
                    connectionStatus === 'connected'
                      ? 'common.connected'
                      : connectionStatus === 'connecting'
                        ? 'common.connecting'
                        : 'common.disconnected'
                  )}
            </span>
          </div>
          {serverBuildDate && (
            <span className={styles.buildDate}>
              {new Date(serverBuildDate).toLocaleDateString(i18n.language)}
            </span>
          )}
        </div>
      </section>

      {/* Bento stats grid */}
      <section className={styles.statsSection}>
        <h2 className={styles.sectionHeading}>{t('dashboard.system_overview')}</h2>
        <div className={styles.bentoGrid}>
          {quickStats.map((stat, index) => (
            <Link
              key={stat.path}
              to={stat.path}
              className={`${styles.bentoCard} ${index === 0 ? styles.bentoLarge : ''}`}
              style={{ animationDelay: `${index * 80}ms` }}
            >
              <div className={styles.bentoIcon}>{stat.icon}</div>
              <div className={styles.bentoContent}>
                <span className={styles.bentoValue}>
                  {stat.loading ? '...' : stat.value}
                </span>
                <span className={styles.bentoLabel}>{stat.label}</span>
                {stat.sublabel && !stat.loading && (
                  <span className={styles.bentoSublabel}>{stat.sublabel}</span>
                )}
              </div>
            </Link>
          ))}
          <div
            className={`${styles.bentoCard} ${styles.bentoScannerCard}`}
            style={{ animationDelay: `${quickStats.length * 80}ms` }}
          >
            <div className={styles.bentoIcon}>
              <IconBot size={24} />
            </div>
            <div className={styles.bentoContent}>
              <span className={styles.bentoLabel}>{t('dashboard.codex_panel_heading')}</span>
              <span className={styles.bentoSublabel}>
                {t('dashboard.codex_last_run', {
                  action: codexSummaryActionText,
                  time: codexSummaryLastRunText
                })}
              </span>
            </div>
            <div className={styles.scannerStatRow}>
              <span className={styles.scannerStatItem}>
                {t('dashboard.codex_stat_invalid')}: {codexSummary.invalid}
              </span>
              <span className={styles.scannerStatItem}>
                {t('dashboard.codex_stat_disabled')}: {codexSummary.disabled}
              </span>
              <span className={styles.scannerStatItem}>
                {t('dashboard.codex_stat_deleted')}: {codexSummary.deleted}
              </span>
            </div>
            {connectionStatus !== 'connected' && (
              <p className={styles.scannerHint}>{t('dashboard.codex_connect_required')}</p>
            )}
            <div className={styles.scannerActions}>
              <Button
                size="sm"
                onClick={() => void scanInvalidCodexAuthFiles()}
                loading={scannerAction === 'scan'}
                disabled={connectionStatus !== 'connected' || scannerAction !== null}
              >
                {t('dashboard.codex_scan_action')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void deleteDisabledCodexAuthFiles()}
                loading={scannerAction === 'delete'}
                disabled={connectionStatus !== 'connected' || scannerAction !== null}
              >
                {t('dashboard.codex_delete_action')}
              </Button>
              <Link to="/auth-files" className={styles.scannerLink}>
                {t('dashboard.codex_auth_files_link')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Config pills section */}
      {config && (
        <section className={styles.configSection}>
          <h2 className={styles.sectionHeading}>{t('dashboard.current_config')}</h2>
          <div className={styles.configPillGrid}>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('basic_settings.debug_enable')}</span>
              <span className={`${styles.configPillValue} ${config.debug ? styles.on : styles.off}`}>
                {config.debug ? t('common.yes') : t('common.no')}
              </span>
            </div>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('basic_settings.usage_statistics_enable')}</span>
              <span className={`${styles.configPillValue} ${config.usageStatisticsEnabled ? styles.on : styles.off}`}>
                {config.usageStatisticsEnabled ? t('common.yes') : t('common.no')}
              </span>
            </div>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('basic_settings.logging_to_file_enable')}</span>
              <span className={`${styles.configPillValue} ${config.loggingToFile ? styles.on : styles.off}`}>
                {config.loggingToFile ? t('common.yes') : t('common.no')}
              </span>
            </div>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('basic_settings.retry_count_label')}</span>
              <span className={styles.configPillValue}>{config.requestRetry ?? 0}</span>
            </div>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('basic_settings.ws_auth_enable')}</span>
              <span className={`${styles.configPillValue} ${config.wsAuth ? styles.on : styles.off}`}>
                {config.wsAuth ? t('common.yes') : t('common.no')}
              </span>
            </div>
            <div className={styles.configPill}>
              <span className={styles.configPillLabel}>{t('dashboard.routing_strategy')}</span>
              <span className={`${styles.configBadge} ${routingStrategyBadgeClass}`}>
                {routingStrategyDisplay}
              </span>
            </div>
            {config.proxyUrl && (
              <div className={`${styles.configPill} ${styles.configPillWide}`}>
                <span className={styles.configPillLabel}>{t('basic_settings.proxy_url_label')}</span>
                <span className={styles.configPillMono}>{config.proxyUrl}</span>
              </div>
            )}
          </div>
          <Link to="/config" className={styles.viewMoreLink}>
            {t('dashboard.edit_settings')} →
          </Link>
        </section>
      )}
    </div>
  );
}
