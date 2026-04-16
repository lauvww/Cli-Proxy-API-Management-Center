import { create } from 'zustand';
import { usageApi, type UsagePoolType, type UsageResponsePayload } from '@/services/api';
import { useAuthStore } from '@/stores/useAuthStore';
import {
  collectUsageDetails,
  computeKeyStatsFromDetails,
  type KeyStats,
  type UsageDetail,
} from '@/utils/usage';
import i18n from '@/i18n';

export const USAGE_STATS_STALE_TIME_MS = 240_000;

export type LoadUsageStatsOptions = {
  force?: boolean;
  staleTimeMs?: number;
  pool?: UsagePoolType;
  authPool?: string;
};

type UsageStatsSnapshot = Record<string, unknown>;

export type UsageStatsMeta = Pick<
  UsageResponsePayload,
  | 'pool_filter'
  | 'pool_filter_applied'
  | 'auth_pool_filter'
  | 'auth_pool_filter_applied'
  | 'auth_pool_filter_defaulted'
  | 'current_auth_pool'
  | 'auth_pool_enabled'
  | 'usage_scope_hint'
  | 'by_pool'
>;

type UsageStatsState = {
  usage: UsageStatsSnapshot | null;
  meta: UsageStatsMeta;
  keyStats: KeyStats;
  usageDetails: UsageDetail[];
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
  scopeKey: string;
  loadUsageStats: (options?: LoadUsageStatsOptions) => Promise<void>;
  clearUsageStats: () => void;
};

const createEmptyKeyStats = (): KeyStats => ({ bySource: {}, byAuthIndex: {} });
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

let usageRequestToken = 0;
let inFlightUsageRequest: { id: number; scopeKey: string; promise: Promise<void> } | null = null;

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : i18n.t('usage_stats.loading_error');

const buildUsageScopeKey = (apiBase: string, managementKey: string, options: LoadUsageStatsOptions) => {
  const pool = options.pool ?? 'all';
  const authPool = options.authPool?.trim() ?? '';
  return `${apiBase}::${managementKey}::${pool}::${authPool}`;
};

export const useUsageStatsStore = create<UsageStatsState>((set, get) => ({
  usage: null,
  meta: createEmptyMeta(),
  keyStats: createEmptyKeyStats(),
  usageDetails: [],
  loading: false,
  error: null,
  lastRefreshedAt: null,
  scopeKey: '',

  loadUsageStats: async (options = {}) => {
    const force = options.force === true;
    const staleTimeMs = options.staleTimeMs ?? USAGE_STATS_STALE_TIME_MS;
    const { apiBase = '', managementKey = '' } = useAuthStore.getState();
    const scopeKey = buildUsageScopeKey(apiBase, managementKey, options);
    const state = get();
    const scopeChanged = state.scopeKey !== scopeKey;

    if (inFlightUsageRequest && inFlightUsageRequest.scopeKey === scopeKey) {
      await inFlightUsageRequest.promise;
      return;
    }

    if (inFlightUsageRequest && inFlightUsageRequest.scopeKey !== scopeKey) {
      usageRequestToken += 1;
      inFlightUsageRequest = null;
    }

    const fresh =
      !scopeChanged &&
      state.lastRefreshedAt !== null &&
      Date.now() - state.lastRefreshedAt < staleTimeMs;

    if (!force && fresh) {
      return;
    }

    if (scopeChanged) {
      set({
        usage: null,
        meta: createEmptyMeta(),
        keyStats: createEmptyKeyStats(),
        usageDetails: [],
        error: null,
        lastRefreshedAt: null,
        scopeKey,
      });
    }

    const requestId = (usageRequestToken += 1);
    set({ loading: true, error: null, scopeKey });

    const requestPromise = (async () => {
      try {
        const usageResponse = await usageApi.getUsage({
          pool: options.pool,
          authPool: options.authPool,
        });
        const rawUsage = usageResponse?.usage ?? usageResponse;
        const usage =
          rawUsage && typeof rawUsage === 'object' ? (rawUsage as UsageStatsSnapshot) : null;

        if (requestId !== usageRequestToken) return;

        const usageDetails = collectUsageDetails(usage);
        set({
          usage,
          meta: {
            pool_filter: usageResponse?.pool_filter,
            pool_filter_applied: usageResponse?.pool_filter_applied,
            auth_pool_filter: usageResponse?.auth_pool_filter,
            auth_pool_filter_applied: usageResponse?.auth_pool_filter_applied,
            auth_pool_filter_defaulted: usageResponse?.auth_pool_filter_defaulted,
            current_auth_pool: usageResponse?.current_auth_pool,
            auth_pool_enabled: usageResponse?.auth_pool_enabled,
            usage_scope_hint: usageResponse?.usage_scope_hint,
            by_pool: usageResponse?.by_pool,
          },
          keyStats: computeKeyStatsFromDetails(usageDetails),
          usageDetails,
          loading: false,
          error: null,
          lastRefreshedAt: Date.now(),
          scopeKey,
        });
      } catch (error: unknown) {
        if (requestId !== usageRequestToken) return;
        const message = getErrorMessage(error);
        set({
          loading: false,
          error: message,
          scopeKey,
        });
        throw new Error(message);
      } finally {
        if (inFlightUsageRequest?.id === requestId) {
          inFlightUsageRequest = null;
        }
      }
    })();

    inFlightUsageRequest = { id: requestId, scopeKey, promise: requestPromise };
    await requestPromise;
  },

  clearUsageStats: () => {
    usageRequestToken += 1;
    inFlightUsageRequest = null;
    set({
      usage: null,
      meta: createEmptyMeta(),
      keyStats: createEmptyKeyStats(),
      usageDetails: [],
      loading: false,
      error: null,
      lastRefreshedAt: null,
      scopeKey: '',
    });
  },
}));
