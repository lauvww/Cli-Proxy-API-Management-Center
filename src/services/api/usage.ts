/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import { computeKeyStats, KeyStats } from '@/utils/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;

export type UsagePoolType = 'plus' | 'free' | 'custom' | 'all';

export interface UsageQueryOptions {
  pool?: UsagePoolType;
  authPool?: string;
  byPool?: boolean;
}

export interface UsageResponsePayload {
  usage?: Record<string, unknown>;
  failed_requests?: number;
  pool_filter?: string;
  pool_filter_applied?: boolean;
  auth_pool_filter?: string;
  auth_pool_filter_applied?: boolean;
  auth_pool_filter_defaulted?: boolean;
  current_auth_pool?: string;
  auth_pool_enabled?: boolean;
  usage_scope_hint?: string;
  by_pool?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface UsageExportPayload {
  version?: number;
  exported_at?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UsageImportResponse {
  added?: number;
  skipped?: number;
  total_requests?: number;
  failed_requests?: number;
  [key: string]: unknown;
}

export const usageApi = {
  /**
   * 获取使用统计原始数据
   */
  getUsage: (options: UsageQueryOptions = {}) => {
    const params: Record<string, unknown> = {};
    if (options.pool && options.pool !== 'all') {
      params.pool = options.pool;
    }
    if (typeof options.authPool === 'string' && options.authPool.trim()) {
      params.auth_pool = options.authPool.trim();
    }
    if (options.byPool) {
      params.by_pool = 1;
    }
    return apiClient.get<UsageResponsePayload>('/usage', {
      timeout: USAGE_TIMEOUT_MS,
      params,
    });
  },

  /**
   * 导出使用统计快照
   */
  exportUsage: () => apiClient.get<UsageExportPayload>('/usage/export', { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 导入使用统计快照
   */
  importUsage: (payload: unknown) =>
    apiClient.post<UsageImportResponse>('/usage/import', payload, { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      const response = await usageApi.getUsage();
      payload = response?.usage ?? response;
    }
    return computeKeyStats(payload);
  },
};
