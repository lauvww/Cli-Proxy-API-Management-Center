import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { CredentialInfo, SourceInfo } from '@/types/sourceInfo';
import { buildCandidateUsageSourceIds, normalizeAuthIndex } from '@/utils/usage';
import { maskApiKey } from '@/utils/format';

export interface SourceInfoMapInput {
  apiKeys?: string[];
  apiKeyAliases?: Record<string, string>;
  geminiApiKeys?: GeminiKeyConfig[];
  claudeApiKeys?: ProviderKeyConfig[];
  codexApiKeys?: ProviderKeyConfig[];
  vertexApiKeys?: ProviderKeyConfig[];
  openaiCompatibility?: OpenAIProviderConfig[];
}

export function buildSourceInfoMap(input: SourceInfoMapInput): Map<string, SourceInfo> {
  const map = new Map<string, SourceInfo>();

  const registerSource = (sourceId: string, displayName: string, type: string) => {
    if (!sourceId || !displayName || map.has(sourceId)) return;
    map.set(sourceId, { displayName, type });
  };

  const registerCandidates = (displayName: string, type: string, candidates: string[]) => {
    candidates.forEach((sourceId) => registerSource(sourceId, displayName, type));
  };

  const resolveConfiguredDisplayName = (apiKey: string | undefined, fallback: string) => {
    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    const alias =
      normalizedApiKey && typeof input.apiKeyAliases?.[normalizedApiKey] === 'string'
        ? input.apiKeyAliases[normalizedApiKey].trim()
        : '';
    if (alias) {
      return alias;
    }
    if (fallback.trim()) {
      return fallback.trim();
    }
    return normalizedApiKey ? maskApiKey(normalizedApiKey) : fallback;
  };

  (input.apiKeys || []).forEach((apiKey, index) => {
    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!normalizedApiKey) return;
    const displayName = resolveConfiguredDisplayName(normalizedApiKey, `API Key #${index + 1}`);
    registerCandidates(
      displayName,
      'api-key',
      buildCandidateUsageSourceIds({ apiKey: normalizedApiKey })
    );
  });

  const providers: Array<{
    items: Array<{ apiKey?: string; prefix?: string }>;
    type: string;
    label: string;
  }> = [
    { items: input.geminiApiKeys || [], type: 'gemini', label: 'Gemini' },
    { items: input.claudeApiKeys || [], type: 'claude', label: 'Claude' },
    { items: input.codexApiKeys || [], type: 'codex', label: 'Codex' },
    { items: input.vertexApiKeys || [], type: 'vertex', label: 'Vertex' },
  ];

  providers.forEach(({ items, type, label }) => {
    items.forEach((item, index) => {
      const displayName = resolveConfiguredDisplayName(
        item.apiKey,
        item.prefix?.trim() || `${label} #${index + 1}`
      );
      registerCandidates(
        displayName,
        type,
        buildCandidateUsageSourceIds({ apiKey: item.apiKey, prefix: item.prefix })
      );
    });
  });

  // OpenAI 特殊处理：多 apiKeyEntries
  (input.openaiCompatibility || []).forEach((provider, providerIndex) => {
    const displayName = resolveConfiguredDisplayName(
      provider.apiKeyEntries?.[0]?.apiKey,
      provider.prefix?.trim() || provider.name || `OpenAI #${providerIndex + 1}`
    );
    const candidates = new Set<string>();
    buildCandidateUsageSourceIds({ prefix: provider.prefix }).forEach((id) => candidates.add(id));
    (provider.apiKeyEntries || []).forEach((entry) => {
      buildCandidateUsageSourceIds({ apiKey: entry.apiKey }).forEach((id) => candidates.add(id));
    });
    registerCandidates(displayName, 'openai', Array.from(candidates));
  });

  return map;
}

export function resolveSourceDisplay(
  sourceRaw: string,
  authIndex: unknown,
  sourceInfoMap: Map<string, SourceInfo>,
  authFileMap: Map<string, CredentialInfo>
): SourceInfo {
  const source = sourceRaw.trim();
  const matched = sourceInfoMap.get(source);
  if (matched) return matched;

  const authIndexKey = normalizeAuthIndex(authIndex);
  if (authIndexKey) {
    const authInfo = authFileMap.get(authIndexKey);
    if (authInfo) {
      return { displayName: authInfo.name || authIndexKey, type: authInfo.type };
    }
  }

  return {
    displayName: source.startsWith('t:') ? source.slice(2) : source || '-',
    type: '',
  };
}
