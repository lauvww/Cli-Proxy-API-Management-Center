import type { Config } from '@/types';

export type RoutingStrategy = 'round-robin' | 'fill-first';

export interface AuthPoolState {
  enabled: boolean;
  paths: string[];
  activePath: string;
  authDir: string;
  routingStrategyByPath: Record<string, RoutingStrategy>;
  currentStrategy: RoutingStrategy;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const hasWindowsDrivePrefix = (value: string): boolean =>
  value.length >= 2 && /^[a-zA-Z]$/.test(value[0] ?? '') && value[1] === ':';

const isWindowsDriveRoot = (value: string): boolean =>
  value.length === 2 && hasWindowsDrivePrefix(value);

const isWindowsStyleKey = (value: string): boolean =>
  hasWindowsDrivePrefix(value) || value.startsWith('//');

const shouldUseWindowsSeparators = (original: string, cleaned: string): boolean =>
  original.includes('\\') || hasWindowsDrivePrefix(original) || hasWindowsDrivePrefix(cleaned);

const cleanSegments = (segments: string[], allowLeadingParents: boolean): string[] => {
  const stack: string[] = [];

  segments.forEach((segment) => {
    if (!segment || segment === '.') {
      return;
    }

    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
        return;
      }
      if (allowLeadingParents) {
        stack.push('..');
      }
      return;
    }

    stack.push(segment);
  });

  return stack;
};

const cleanRelativePath = (value: string): string =>
  cleanSegments(value.split('/'), false).join('/');

const cleanNormalPath = (value: string): string => {
  const isAbsolute = value.startsWith('/');
  const cleaned = cleanSegments(value.split('/'), !isAbsolute).join('/');

  if (!cleaned) {
    return isAbsolute ? '/' : '.';
  }

  return isAbsolute ? `/${cleaned}` : cleaned;
};

const cleanSlashPath = (value: string): string => {
  if (!value) return '';

  if (hasWindowsDrivePrefix(value)) {
    const prefix = value.slice(0, 2);
    const remainder = value.slice(2).replace(/^\/+/, '');
    if (!remainder) return `${prefix}/`;
    const cleaned = cleanRelativePath(remainder);
    if (!cleaned) return `${prefix}/`;
    return `${prefix}/${cleaned}`;
  }

  if (value.startsWith('//')) {
    const trimmed = value.replace(/^\/+/, '');
    const parts = trimmed.split('/');
    if (parts.length >= 2) {
      const prefix = `//${parts[0]}/${parts[1]}`;
      const remainder = parts.slice(2).join('/');
      if (!remainder) return prefix;
      const cleaned = cleanRelativePath(remainder);
      if (!cleaned) return prefix;
      return `${prefix}/${cleaned}`;
    }
  }

  return cleanNormalPath(value);
};

export const normalizePathForCompare = (value: string): string =>
  (() => {
    const normalized = normalizePathForDisplay(value);
    if (!normalized) return '';
    const key = normalized === '/' ? '/' : normalized.replace(/\\/g, '/').replace(/\/+$/, '');
    if (isWindowsStyleKey(key)) {
      return key.toLowerCase();
    }
    return key;
  })();

export const normalizePathForDisplay = (value: string): string =>
  (() => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const slashNormalized = trimmed.replace(/\\/g, '/');
    const cleaned = cleanSlashPath(slashNormalized);
    if (!cleaned || cleaned === '.') return '';

    if (shouldUseWindowsSeparators(trimmed, cleaned)) {
      const windowsPath = cleaned.replace(/\//g, '\\');
      if (isWindowsDriveRoot(windowsPath)) {
        return `${windowsPath}\\`;
      }
      return windowsPath.replace(/\\+$/, '');
    }

    return cleaned === '/' ? cleaned : cleaned.replace(/\/+$/, '');
  })();

export const authPoolPathsEqual = (left: string, right: string): boolean =>
  normalizePathForCompare(left) !== '' &&
  normalizePathForCompare(left) === normalizePathForCompare(right);

export const pathIsWithinScope = (path: string, scope: string): boolean => {
  const normalizedPath = normalizePathForCompare(path);
  const normalizedScope = normalizePathForCompare(scope);
  if (!normalizedPath || !normalizedScope) return false;
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
};

export const normalizeRoutingStrategy = (value: unknown): RoutingStrategy =>
  value === 'fill-first' ? 'fill-first' : 'round-robin';

export const normalizeAuthPoolState = (input: unknown): AuthPoolState => {
  const record = asRecord(input);
  if (!record) {
    return {
      enabled: false,
      paths: [],
      activePath: '',
      authDir: '',
      routingStrategyByPath: {},
      currentStrategy: 'round-robin',
    };
  }

  const rawPaths = Array.isArray(record.paths) ? record.paths : [];
  const pathMap = new Map<string, string>();
  rawPaths.forEach((item) => {
    if (typeof item !== 'string') return;
    const displayPath = normalizePathForDisplay(item);
    const key = normalizePathForCompare(displayPath);
    if (!displayPath || !key || pathMap.has(key)) return;
    pathMap.set(key, displayPath);
  });

  const rawActivePath =
    typeof record['active-path'] === 'string'
      ? record['active-path']
      : typeof record['active_path'] === 'string'
        ? record['active_path']
        : typeof record.activePath === 'string'
          ? record.activePath
          : '';
  const activePath = normalizePathForDisplay(rawActivePath);
  const activeKey = normalizePathForCompare(activePath);
  if (activePath && activeKey && !pathMap.has(activeKey)) {
    pathMap.set(activeKey, activePath);
  }

  const rawAuthDir =
    typeof record['auth-dir'] === 'string'
      ? record['auth-dir']
      : typeof record['auth_dir'] === 'string'
        ? record['auth_dir']
        : typeof record.authDir === 'string'
          ? record.authDir
          : '';

  const strategySource =
    asRecord(
      record['routing-strategy-by-path'] ??
        record['routing_strategy_by_path'] ??
        record.routingStrategyByPath
    ) ?? {};
  const routingStrategyByPath: Record<string, RoutingStrategy> = {};
  Object.entries(strategySource).forEach(([path, strategy]) => {
    const key = normalizePathForCompare(path);
    if (!key) return;
    routingStrategyByPath[key] = normalizeRoutingStrategy(strategy);
  });

  return {
    enabled: record.enabled === true,
    paths: Array.from(pathMap.values()),
    activePath,
    authDir: normalizePathForDisplay(rawAuthDir),
    routingStrategyByPath,
    currentStrategy: normalizeRoutingStrategy(
      record['current-strategy'] ?? record['current_strategy'] ?? record.currentStrategy
    ),
  };
};

export const getAuthPoolStateFromConfig = (config: Config | null | undefined): AuthPoolState => {
  const raw = asRecord(config?.raw);
  const authPoolRaw = asRecord(raw?.['auth-pool'] ?? raw?.authPool) ?? {};
  const rawRouting = asRecord(raw?.routing);
  const activePathRaw =
    typeof authPoolRaw['active-path'] === 'string'
      ? authPoolRaw['active-path']
      : typeof raw?.['auth-dir'] === 'string'
        ? raw['auth-dir']
        : '';
  const authDirRaw = typeof raw?.['auth-dir'] === 'string' ? raw['auth-dir'] : activePathRaw;

  return normalizeAuthPoolState({
    enabled: authPoolRaw.enabled === true,
    paths: authPoolRaw.paths,
    'active-path': activePathRaw,
    'auth-dir': authDirRaw,
    'routing-strategy-by-path': authPoolRaw['routing-strategy-by-path'],
    'current-strategy': rawRouting?.strategy ?? config?.routingStrategy,
  });
};

export const resolveAuthPoolDisplayPath = (
  state: Pick<AuthPoolState, 'paths' | 'activePath' | 'authDir'>,
  path?: string
): string => {
  const target = normalizePathForCompare(path ?? state.activePath ?? state.authDir);
  if (!target) return '';
  return (
    state.paths.find((item) => authPoolPathsEqual(item, target)) ??
    normalizePathForDisplay(path ?? state.activePath ?? state.authDir)
  );
};

export const getAuthPoolName = (path: string): string => {
  const normalized = normalizePathForDisplay(path);
  if (!normalized) return '';

  const slashPath = normalized.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!slashPath) return '';

  const lastSlashIndex = slashPath.lastIndexOf('/');
  if (lastSlashIndex < 0) {
    return slashPath;
  }

  return slashPath.slice(lastSlashIndex + 1);
};
