/**
 * 模型列表状态管理（带缓存）
 */

import { create } from 'zustand';
import { modelsApi } from '@/services/api/models';
import { CACHE_EXPIRY_MS } from '@/utils/constants';
import type { ModelInfo } from '@/utils/models';

interface ModelsCache {
  data: ModelInfo[];
  timestamp: number;
  apiBase: string;
  apiKeyScope: string;
}

interface ModelsState {
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
  cache: ModelsCache | null;
  scope: string;
  scopeMode: string;

  fetchModels: (
    apiBase: string,
    apiKeys?: string | string[],
    forceRefresh?: boolean
  ) => Promise<ModelInfo[]>;
  clearCache: () => void;
  isCacheValid: (apiBase: string, apiKeys?: string | string[]) => boolean;
}

const normalizeApiKeyCandidates = (apiKeys?: string | string[]): string[] => {
  const rawList = Array.isArray(apiKeys) ? apiKeys : typeof apiKeys === 'string' ? [apiKeys] : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  rawList.forEach((apiKey) => {
    const trimmed = apiKey.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized;
};

const buildModelsCacheScope = (apiKeys?: string | string[]): string => {
  const normalized = normalizeApiKeyCandidates(apiKeys);
  if (!normalized.length) return '';
  return normalized.join('|');
};

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  loading: false,
  error: null,
  cache: null,
  scope: '',
  scopeMode: '',

  fetchModels: async (apiBase, apiKeys, forceRefresh = false) => {
    const { cache, isCacheValid } = get();
    const normalizedCandidates = normalizeApiKeyCandidates(apiKeys);
    const apiKeyScope = buildModelsCacheScope(normalizedCandidates);

    // 检查缓存
    if (!forceRefresh && isCacheValid(apiBase, apiKeyScope) && cache) {
      set({ models: cache.data, error: null });
      return cache.data;
    }

    set({ loading: true, error: null });

    try {
      const candidates = normalizedCandidates.length ? normalizedCandidates : [''];
      let list: ModelInfo[] | null = null;
      let scope = '';
      let scopeMode = '';
      let lastError: unknown = null;

      for (const candidate of candidates) {
        try {
          const result = await modelsApi.fetchModelsWithMeta(apiBase, candidate || undefined);
          list = result.models;
          scope = result.scope;
          scopeMode = result.mode;
          break;
        } catch (error: unknown) {
          lastError = error;
        }
      }

      if (list === null) {
        throw lastError instanceof Error
          ? lastError
          : new Error('Failed to fetch models with all configured API keys');
      }
      const now = Date.now();

      set({
        models: list,
        loading: false,
        scope,
        scopeMode,
        cache: { data: list, timestamp: now, apiBase, apiKeyScope },
      });

      return list;
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Failed to fetch models';
      set({
        error: message,
        loading: false,
        models: cache?.data ?? [],
      });
      throw error;
    }
  },

  clearCache: () => {
    set({ cache: null, models: [], scope: '', scopeMode: '' });
  },

  isCacheValid: (apiBase, apiKeys) => {
    const { cache } = get();
    if (!cache) return false;
    if (cache.apiBase !== apiBase) return false;
    const apiKeyScope = buildModelsCacheScope(apiKeys);
    if ((cache.apiKeyScope || '') !== apiKeyScope) return false;
    return Date.now() - cache.timestamp < CACHE_EXPIRY_MS;
  },
}));
