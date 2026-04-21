import { apiClient } from './client';
import { normalizeAuthPoolState, type AuthPoolState, type RoutingStrategy } from '@/utils/authPool';
import type { AuthFilesResponse } from '@/types/authFile';

export interface AuthPoolFilesResponse extends AuthFilesResponse {
  viewed_auth_pool?: string;
  readonly?: boolean;
}

export const authPoolApi = {
  async getAuthPool(): Promise<AuthPoolState> {
    const data = await apiClient.get('/auth-pool');
    return normalizeAuthPoolState(data);
  },

  async setEnabled(enabled: boolean): Promise<AuthPoolState> {
    const data = await apiClient.patch('/auth-pool/enabled', { enabled });
    return normalizeAuthPoolState(data);
  },

  async addPath(path: string): Promise<AuthPoolState> {
    const data = await apiClient.post('/auth-pool/paths', { path });
    return normalizeAuthPoolState(data);
  },

  async deletePath(path: string): Promise<AuthPoolState> {
    const data = await apiClient.delete(`/auth-pool/paths?path=${encodeURIComponent(path)}`);
    return normalizeAuthPoolState(data);
  },

  async setCurrent(path: string): Promise<AuthPoolState> {
    const data = await apiClient.patch('/auth-pool/current', { path });
    return normalizeAuthPoolState(data);
  },

  async setStrategy(strategy: RoutingStrategy, path?: string): Promise<AuthPoolState> {
    const data = await apiClient.patch(
      '/auth-pool/strategy',
      path ? { path, strategy } : { strategy }
    );
    return normalizeAuthPoolState(data);
  },

  async listFiles(path?: string): Promise<AuthPoolFilesResponse> {
    const query =
      typeof path === 'string' && path.trim() ? `?path=${encodeURIComponent(path)}` : '';
    return apiClient.get<AuthPoolFilesResponse>(`/auth-pool/files${query}`);
  },
};
