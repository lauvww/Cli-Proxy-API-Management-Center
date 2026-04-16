import {
  useLayoutEffect,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconCode,
  IconDiamond,
  IconKey,
  IconSatellite,
  IconSettings,
  IconShield,
  IconTimer,
  IconTrendingUp,
  type IconProps,
} from '@/components/ui/icons';
import { ConfigSection } from '@/components/config/ConfigSection';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type {
  PayloadFilterRule,
  PayloadParamValidationErrorCode,
  PayloadRule,
  VisualConfigFieldPath,
  VisualConfigValidationErrorCode,
  VisualConfigValidationErrors,
  VisualConfigValues,
} from '@/types/visualConfig';
import {
  ApiKeysCardEditor,
  PayloadFilterRulesEditor,
  PayloadRulesEditor,
} from './VisualConfigEditorBlocks';
import styles from './VisualConfigEditor.module.scss';

type VisualSectionId =
  | 'server'
  | 'tls'
  | 'remote'
  | 'auth'
  | 'system'
  | 'network'
  | 'quota'
  | 'streaming'
  | 'payload';

type VisualSection = {
  id: VisualSectionId;
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
  errorCount: number;
};

interface VisualConfigEditorProps {
  values: VisualConfigValues;
  validationErrors?: VisualConfigValidationErrors;
  hasPayloadValidationErrors?: boolean;
  disabled?: boolean;
  onChange: (values: Partial<VisualConfigValues>) => void;
}

function getValidationMessage(
  t: ReturnType<typeof useTranslation>['t'],
  errorCode?: VisualConfigValidationErrorCode | PayloadParamValidationErrorCode
) {
  if (!errorCode) return undefined;
  return t(`config_management.visual.validation.${errorCode}`);
}

type ToggleRowProps = {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
};

function ToggleRow({ title, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleCopy}>
        <div className={styles.toggleTitle}>{title}</div>
        {description ? <div className={styles.toggleDescription}>{description}</div> : null}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={title} />
    </div>
  );
}

function SectionGrid({ children }: { children: ReactNode }) {
  return <div className={styles.sectionGrid}>{children}</div>;
}

function SectionStack({ children }: { children: ReactNode }) {
  return <div className={styles.sectionStack}>{children}</div>;
}

function Divider() {
  return <div className={styles.divider} />;
}

function SectionSubsection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.subsection}>
      <div className={styles.subsectionHeader}>
        <h3 className={styles.subsectionTitle}>{title}</h3>
        {description ? <p className={styles.subsectionDescription}>{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function FieldShell({
  label,
  labelId,
  htmlFor,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  label: string;
  labelId?: string;
  htmlFor?: string;
  hint?: string;
  hintId?: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldShell}>
      <label id={labelId} htmlFor={htmlFor} className={styles.fieldLabel}>
        {label}
      </label>
      {children}
      {error ? (
        <div id={errorId} className="error-box">
          {error}
        </div>
      ) : null}
      {hint ? (
        <div id={hintId} className={styles.fieldHint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const AUTH_DIR_PRESETS_STORAGE_KEY = 'config-management:auth-dir-presets';
const AUTH_DIR_PRESETS_LIMIT = 20;

function normalizeAuthDirPath(value: string): string {
  const trimmed = value.trim();
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators.toLowerCase()}\\`;
  }
  return (withoutTrailingSeparators || trimmed).toLowerCase();
}

function buildDefaultAuthDirPresets(authDir: string): string[] {
  const trimmed = authDir.trim();
  if (!trimmed) return [];

  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return [];

  let basePath = withoutTrailingSeparators;
  if (/[\\/](plus|free)$/i.test(withoutTrailingSeparators)) {
    const segmentIndex = Math.max(
      withoutTrailingSeparators.lastIndexOf('\\'),
      withoutTrailingSeparators.lastIndexOf('/')
    );
    if (segmentIndex <= 0) return [];
    basePath = withoutTrailingSeparators.slice(0, segmentIndex);
  }

  if (!basePath) return [];

  const pathSeparator = basePath.includes('\\') ? '\\' : '/';
  return [`${basePath}${pathSeparator}Plus`, `${basePath}${pathSeparator}Free`];
}

export function VisualConfigEditor({
  values,
  validationErrors,
  hasPayloadValidationErrors = false,
  disabled = false,
  onChange,
}: VisualConfigEditorProps) {
  const { t } = useTranslation();
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.isCurrentLayer : true;
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isFloatingSidebar = useMediaQuery('(min-width: 1025px)');
  const shouldRenderFloatingSidebar = !isMobile && isFloatingSidebar && isCurrentLayer;
  const routingStrategyLabelId = useId();
  const routingStrategyHintId = `${routingStrategyLabelId}-hint`;
  const keepaliveInputId = useId();
  const keepaliveHintId = `${keepaliveInputId}-hint`;
  const keepaliveErrorId = `${keepaliveInputId}-error`;
  const nonstreamKeepaliveInputId = useId();
  const nonstreamKeepaliveHintId = `${nonstreamKeepaliveInputId}-hint`;
  const nonstreamKeepaliveErrorId = `${nonstreamKeepaliveInputId}-error`;
  const [activeSectionId, setActiveSectionId] = useState<VisualSectionId>('server');
  const [authDirPresetDraft, setAuthDirPresetDraft] = useState('');
  const [authDirPresets, setAuthDirPresets] = useLocalStorage<string[]>(
    AUTH_DIR_PRESETS_STORAGE_KEY,
    []
  );
  const hasInitializedAuthDirPresetsRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const sidebarAnchorRef = useRef<HTMLElement | null>(null);
  const floatingSidebarRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Partial<Record<VisualSectionId, HTMLElement | null>>>({});
  const mobileNavScrollerRef = useRef<HTMLDivElement | null>(null);
  const mobileNavButtonRefs = useRef<Partial<Record<VisualSectionId, HTMLButtonElement | null>>>(
    {}
  );

  const isKeepaliveDisabled =
    values.streaming.keepaliveSeconds === '' || values.streaming.keepaliveSeconds === '0';
  const isNonstreamKeepaliveDisabled =
    values.streaming.nonstreamKeepaliveInterval === '' ||
    values.streaming.nonstreamKeepaliveInterval === '0';
  const authDirPresetItems = useMemo(() => {
    const seen = new Set<string>();
    const next: string[] = [];

    for (const item of authDirPresets) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed) continue;

      const normalized = normalizeAuthDirPath(trimmed);
      if (seen.has(normalized)) continue;

      seen.add(normalized);
      next.push(trimmed);
      if (next.length >= AUTH_DIR_PRESETS_LIMIT) break;
    }

    return next;
  }, [authDirPresets]);
  const activeAuthDirKey = useMemo(() => normalizeAuthDirPath(values.authDir), [values.authDir]);
  const nextAuthDirPresetCandidate = authDirPresetDraft.trim() || values.authDir.trim();

  useEffect(() => {
    if (values.authPoolEnabled) return;
    if (hasInitializedAuthDirPresetsRef.current) return;

    if (authDirPresetItems.length > 0) {
      hasInitializedAuthDirPresetsRef.current = true;
      return;
    }

    const defaults = buildDefaultAuthDirPresets(values.authDir);
    if (defaults.length === 0) return;

    setAuthDirPresets(defaults);
    hasInitializedAuthDirPresetsRef.current = true;
  }, [authDirPresetItems.length, setAuthDirPresets, values.authDir, values.authPoolEnabled]);

  const portError = getValidationMessage(t, validationErrors?.port);
  const logsMaxSizeError = getValidationMessage(t, validationErrors?.logsMaxTotalSizeMb);
  const requestRetryError = getValidationMessage(t, validationErrors?.requestRetry);
  const maxRetryCredentialsError = getValidationMessage(t, validationErrors?.maxRetryCredentials);
  const maxRetryIntervalError = getValidationMessage(t, validationErrors?.maxRetryInterval);
  const keepaliveError = getValidationMessage(t, validationErrors?.['streaming.keepaliveSeconds']);
  const bootstrapRetriesError = getValidationMessage(
    t,
    validationErrors?.['streaming.bootstrapRetries']
  );
  const nonstreamKeepaliveError = getValidationMessage(
    t,
    validationErrors?.['streaming.nonstreamKeepaliveInterval']
  );

  const handleApiKeysTextChange = useCallback(
    (apiKeysText: string) => onChange({ apiKeysText }),
    [onChange]
  );
  const handlePayloadDefaultRulesChange = useCallback(
    (payloadDefaultRules: PayloadRule[]) => onChange({ payloadDefaultRules }),
    [onChange]
  );
  const handlePayloadDefaultRawRulesChange = useCallback(
    (payloadDefaultRawRules: PayloadRule[]) => onChange({ payloadDefaultRawRules }),
    [onChange]
  );
  const handlePayloadOverrideRulesChange = useCallback(
    (payloadOverrideRules: PayloadRule[]) => onChange({ payloadOverrideRules }),
    [onChange]
  );
  const handlePayloadOverrideRawRulesChange = useCallback(
    (payloadOverrideRawRules: PayloadRule[]) => onChange({ payloadOverrideRawRules }),
    [onChange]
  );
  const handlePayloadFilterRulesChange = useCallback(
    (payloadFilterRules: PayloadFilterRule[]) => onChange({ payloadFilterRules }),
    [onChange]
  );
  const handleSaveAuthDirPreset = useCallback(() => {
    const candidate = nextAuthDirPresetCandidate;
    if (!candidate) return;

    const candidateKey = normalizeAuthDirPath(candidate);
    const merged = [
      candidate,
      ...authDirPresetItems.filter((item) => normalizeAuthDirPath(item) !== candidateKey),
    ];

    setAuthDirPresets(merged.slice(0, AUTH_DIR_PRESETS_LIMIT));
    setAuthDirPresetDraft('');
  }, [authDirPresetItems, nextAuthDirPresetCandidate, setAuthDirPresets]);
  const handleApplyAuthDirPreset = useCallback(
    (preset: string) => {
      onChange({ authDir: preset });
    },
    [onChange]
  );
  const handleRemoveAuthDirPreset = useCallback(
    (preset: string) => {
      const targetKey = normalizeAuthDirPath(preset);
      setAuthDirPresets(
        authDirPresetItems.filter((item) => normalizeAuthDirPath(item) !== targetKey)
      );
    },
    [authDirPresetItems, setAuthDirPresets]
  );
  const isAuthDirPresetActive = useCallback(
    (preset: string) => normalizeAuthDirPath(preset) === activeAuthDirKey,
    [activeAuthDirKey]
  );
  const handleRoutingStrategyChange = useCallback(
    (nextValue: VisualConfigValues['routingStrategy']) => {
      onChange({ routingStrategy: nextValue });
    },
    [onChange]
  );

  const countErrors = useCallback(
    (fields: VisualConfigFieldPath[]) =>
      fields.reduce((total, field) => total + (validationErrors?.[field] ? 1 : 0), 0),
    [validationErrors]
  );

  const sections = useMemo<VisualSection[]>(
    () => [
      {
        id: 'server',
        title: t('config_management.visual.sections.server.title'),
        description: t('config_management.visual.sections.server.description'),
        icon: IconSettings,
        errorCount: countErrors(['port']),
      },
      {
        id: 'tls',
        title: t('config_management.visual.sections.tls.title'),
        description: t('config_management.visual.sections.tls.description'),
        icon: IconShield,
        errorCount: 0,
      },
      {
        id: 'remote',
        title: t('config_management.visual.sections.remote.title'),
        description: t('config_management.visual.sections.remote.description'),
        icon: IconSatellite,
        errorCount: 0,
      },
      {
        id: 'auth',
        title: t('config_management.visual.sections.auth.title'),
        description: t('config_management.visual.sections.auth.description'),
        icon: IconKey,
        errorCount: 0,
      },
      {
        id: 'system',
        title: t('config_management.visual.sections.system.title'),
        description: t('config_management.visual.sections.system.description'),
        icon: IconDiamond,
        errorCount: countErrors(['logsMaxTotalSizeMb']),
      },
      {
        id: 'network',
        title: t('config_management.visual.sections.network.title'),
        description: t('config_management.visual.sections.network.description'),
        icon: IconTrendingUp,
        errorCount: countErrors(['requestRetry', 'maxRetryCredentials', 'maxRetryInterval']),
      },
      {
        id: 'quota',
        title: t('config_management.visual.sections.quota.title'),
        description: t('config_management.visual.sections.quota.description'),
        icon: IconTimer,
        errorCount: 0,
      },
      {
        id: 'streaming',
        title: t('config_management.visual.sections.streaming.title'),
        description: t('config_management.visual.sections.streaming.description'),
        icon: IconSatellite,
        errorCount: countErrors([
          'streaming.keepaliveSeconds',
          'streaming.bootstrapRetries',
          'streaming.nonstreamKeepaliveInterval',
        ]),
      },
      {
        id: 'payload',
        title: t('config_management.visual.sections.payload.title'),
        description: t('config_management.visual.sections.payload.description'),
        icon: IconCode,
        errorCount: hasPayloadValidationErrors ? 1 : 0,
      },
    ],
    [countErrors, hasPayloadValidationErrors, t]
  );

  const hasValidationIssues =
    sections.some((section) => section.errorCount > 0) || hasPayloadValidationErrors;
  const focusSections = useMemo(
    () => sections.filter((section) => ['server', 'network', 'payload'].includes(section.id)),
    [sections]
  );

  useEffect(() => {
    if (!isCurrentLayer) return undefined;
    if (typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio);

        if (visibleEntries.length === 0) return;
        setActiveSectionId(visibleEntries[0].target.id as VisualSectionId);
      },
      {
        rootMargin: '-18% 0px -58% 0px',
        threshold: [0.12, 0.3, 0.55],
      }
    );

    for (const section of sections) {
      const element = sectionRefs.current[section.id];
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [isCurrentLayer, sections]);

  useEffect(() => {
    if (!isCurrentLayer || !isMobile) return;
    const scroller = mobileNavScrollerRef.current;
    const button = mobileNavButtonRefs.current[activeSectionId];
    if (!scroller || !button) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const centeredLeft =
      scroller.scrollLeft +
      (buttonRect.left - scrollerRect.left) -
      (scroller.clientWidth - buttonRect.width) / 2;
    const maxScrollLeft = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
    const targetLeft = Math.min(Math.max(centeredLeft, 0), maxScrollLeft);

    scroller.scrollTo({
      left: targetLeft,
      behavior: 'smooth',
    });
  }, [activeSectionId, isCurrentLayer, isMobile]);

  const handleSectionJump = useCallback((sectionId: VisualSectionId) => {
    setActiveSectionId(sectionId);
    sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useLayoutEffect(() => {
    const floatingElement = floatingSidebarRef.current;
    const anchorElement = sidebarAnchorRef.current;
    const workspaceElement = workspaceRef.current;
    if (!floatingElement) return undefined;

    const clearFloatingStyles = () => {
      floatingElement.style.removeProperty('transform');
      floatingElement.style.removeProperty('width');
      floatingElement.style.removeProperty('max-height');
      floatingElement.style.removeProperty('opacity');
      floatingElement.style.removeProperty('pointer-events');
    };

    if (!shouldRenderFloatingSidebar || !anchorElement || !workspaceElement) {
      clearFloatingStyles();
      return undefined;
    }

    /* ---- Cache header height – recomputed only on resize ---- */
    const computeHeaderHeight = () => {
      const header = document.querySelector('.main-header') as HTMLElement | null;
      if (header) return header.getBoundingClientRect().height;

      const raw = getComputedStyle(document.documentElement).getPropertyValue('--header-height');
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 64;
    };
    let headerHeight = computeHeaderHeight();

    /* ---- Cache content scroller – resolved once ---- */
    const contentScroller = document.querySelector('.content') as HTMLElement | null;

    /* ---- Cache floating height from previous frame ---- */
    let cachedFloatingHeight = floatingElement.getBoundingClientRect().height || 200;

    let frameId = 0;

    const updateFloatingPosition = () => {
      frameId = 0;

      const anchorRect = anchorElement.getBoundingClientRect();
      const workspaceRect = workspaceElement.getBoundingClientRect();
      const stickyTop = headerHeight + 20;
      const viewportPadding = 16;
      const maxTop = workspaceRect.bottom - cachedFloatingHeight;
      const unclampedTop = Math.min(Math.max(anchorRect.top, stickyTop), maxTop);
      const top = Math.max(unclampedTop, viewportPadding);
      const left = Math.max(anchorRect.left, viewportPadding);
      const width = Math.max(
        Math.min(anchorRect.width, window.innerWidth - left - viewportPadding),
        220
      );
      const maxHeight = Math.max(window.innerHeight - top - viewportPadding, 160);
      const isVisible =
        workspaceRect.bottom > stickyTop + 24 && anchorRect.top < window.innerHeight;

      floatingElement.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      floatingElement.style.width = `${width}px`;
      floatingElement.style.maxHeight = `${maxHeight}px`;
      floatingElement.style.opacity = isVisible ? '1' : '0';
      floatingElement.style.pointerEvents = isVisible ? 'auto' : 'none';
    };

    const requestPositionUpdate = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateFloatingPosition);
    };

    const handleResize = () => {
      headerHeight = computeHeaderHeight();
      cachedFloatingHeight = floatingElement.getBoundingClientRect().height || cachedFloatingHeight;
      requestPositionUpdate();
    };

    requestPositionUpdate();

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', requestPositionUpdate, { passive: true });
    contentScroller?.addEventListener('scroll', requestPositionUpdate, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestPositionUpdate);
    resizeObserver?.observe(anchorElement);
    resizeObserver?.observe(workspaceElement);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', requestPositionUpdate);
      contentScroller?.removeEventListener('scroll', requestPositionUpdate);
      clearFloatingStyles();
    };
  }, [shouldRenderFloatingSidebar]);

  const navContent = (
    <div className={styles.navList}>
      {sections.map((section, index) => {
        const Icon = section.icon;

        return (
          <button
            key={section.id}
            type="button"
            className={`${styles.navButton} ${
              activeSectionId === section.id ? styles.navButtonActive : ''
            }`}
            onClick={() => handleSectionJump(section.id)}
          >
            <span className={styles.navIndex}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.navMain}>
              <span className={styles.navHeadingRow}>
                <span className={styles.navLabelWrap}>
                  <span className={styles.navIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={styles.navLabel}>{section.title}</span>
                </span>
                {section.errorCount > 0 ? (
                  <span className={styles.navBadge} aria-hidden="true">
                    {section.errorCount}
                  </span>
                ) : null}
              </span>
              <span className={styles.navDescription}>{section.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={styles.visualEditor}>
      <div className={styles.overview}>
        <div className={styles.overviewHeader}>
          <div className={styles.overviewMeta}>
            <span className={styles.overviewPill}>
              {t('config_management.visual.quick_jump', { defaultValue: '快速跳转' })}
            </span>
            {hasValidationIssues ? (
              <span className={`${styles.overviewPill} ${styles.overviewPillWarning}`}>
                {t('config_management.visual.validation.validation_blocked')}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.overviewFocusList}>
          {focusSections.map((section) => {
            const Icon = section.icon;

            return (
              <button
                key={section.id}
                type="button"
                className={`${styles.overviewFocusLink} ${
                  activeSectionId === section.id ? styles.overviewFocusLinkActive : ''
                }`}
                onClick={() => handleSectionJump(section.id)}
              >
                <span className={styles.focusIcon}>
                  <Icon size={16} />
                </span>
                <span className={styles.focusCopy}>
                  <span className={styles.focusTitle}>{section.title}</span>
                  <span className={styles.focusDescription}>{section.description}</span>
                </span>
                {section.errorCount > 0 ? (
                  <span className={styles.navBadge} aria-hidden="true">
                    {section.errorCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={workspaceRef} className={styles.workspace}>
        {isMobile ? (
          <div className={styles.mobileSectionNav}>
            <div
              ref={mobileNavScrollerRef}
              className={styles.mobileSectionNavScroller}
              aria-label={t('config_management.visual.quick_jump', { defaultValue: '快速跳转' })}
            >
              {sections.map((section, index) => (
                <button
                  key={section.id}
                  ref={(node) => {
                    mobileNavButtonRefs.current[section.id] = node;
                  }}
                  type="button"
                  className={`${styles.mobileSectionNavButton} ${
                    activeSectionId === section.id ? styles.mobileSectionNavButtonActive : ''
                  }`}
                  onClick={() => handleSectionJump(section.id)}
                >
                  <span className={styles.mobileSectionNavIndex}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.mobileSectionNavLabel}>{section.title}</span>
                  {section.errorCount > 0 ? (
                    <span className={styles.mobileSectionNavBadge} aria-hidden="true">
                      {section.errorCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <aside ref={sidebarAnchorRef} className={styles.sidebar}>
          {isFloatingSidebar ? (
            <div className={styles.sidebarPlaceholder} aria-hidden="true" />
          ) : (
            <div className={styles.sidebarRail}>{navContent}</div>
          )}
        </aside>

        <div className={styles.sections}>
          <ConfigSection
            id="server"
            ref={(node) => {
              sectionRefs.current.server = node;
            }}
            indexLabel="01"
            icon={<IconSettings size={16} />}
            title={t('config_management.visual.sections.server.title')}
            description={t('config_management.visual.sections.server.description')}
          >
            <SectionGrid>
              <Input
                label={t('config_management.visual.sections.server.host')}
                placeholder="0.0.0.0"
                value={values.host}
                onChange={(e) => onChange({ host: e.target.value })}
                disabled={disabled}
              />
              <Input
                label={t('config_management.visual.sections.server.port')}
                type="number"
                placeholder="8317"
                value={values.port}
                onChange={(e) => onChange({ port: e.target.value })}
                disabled={disabled}
                error={portError}
              />
            </SectionGrid>
          </ConfigSection>

          <ConfigSection
            id="tls"
            ref={(node) => {
              sectionRefs.current.tls = node;
            }}
            indexLabel="02"
            icon={<IconShield size={16} />}
            title={t('config_management.visual.sections.tls.title')}
            description={t('config_management.visual.sections.tls.description')}
          >
            <SectionStack>
              <ToggleRow
                title={t('config_management.visual.sections.tls.enable')}
                description={t('config_management.visual.sections.tls.enable_desc')}
                checked={values.tlsEnable}
                disabled={disabled}
                onChange={(tlsEnable) => onChange({ tlsEnable })}
              />

              {values.tlsEnable ? (
                <>
                  <Divider />
                  <SectionGrid>
                    <Input
                      label={t('config_management.visual.sections.tls.cert')}
                      placeholder="/path/to/cert.pem"
                      value={values.tlsCert}
                      onChange={(e) => onChange({ tlsCert: e.target.value })}
                      disabled={disabled}
                    />
                    <Input
                      label={t('config_management.visual.sections.tls.key')}
                      placeholder="/path/to/key.pem"
                      value={values.tlsKey}
                      onChange={(e) => onChange({ tlsKey: e.target.value })}
                      disabled={disabled}
                    />
                  </SectionGrid>
                </>
              ) : null}
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="remote"
            ref={(node) => {
              sectionRefs.current.remote = node;
            }}
            indexLabel="03"
            icon={<IconSatellite size={16} />}
            title={t('config_management.visual.sections.remote.title')}
            description={t('config_management.visual.sections.remote.description')}
          >
            <SectionStack>
              <ToggleRow
                title={t('config_management.visual.sections.remote.allow_remote')}
                description={t('config_management.visual.sections.remote.allow_remote_desc')}
                checked={values.rmAllowRemote}
                disabled={disabled}
                onChange={(rmAllowRemote) => onChange({ rmAllowRemote })}
              />
              <ToggleRow
                title={t('config_management.visual.sections.remote.disable_panel')}
                description={t('config_management.visual.sections.remote.disable_panel_desc')}
                checked={values.rmDisableControlPanel}
                disabled={disabled}
                onChange={(rmDisableControlPanel) => onChange({ rmDisableControlPanel })}
              />
              <SectionGrid>
                <Input
                  label={t('config_management.visual.sections.remote.secret_key')}
                  type="password"
                  placeholder={t('config_management.visual.sections.remote.secret_key_placeholder')}
                  value={values.rmSecretKey}
                  onChange={(e) => onChange({ rmSecretKey: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label={t('config_management.visual.sections.remote.panel_repo')}
                  placeholder="https://github.com/router-for-me/Cli-Proxy-API-Management-Center"
                  value={values.rmPanelRepo}
                  onChange={(e) => onChange({ rmPanelRepo: e.target.value })}
                  disabled={disabled}
                />
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="auth"
            ref={(node) => {
              sectionRefs.current.auth = node;
            }}
            indexLabel="04"
            icon={<IconKey size={16} />}
            title={t('config_management.visual.sections.auth.title')}
            description={t('config_management.visual.sections.auth.description')}
          >
            <SectionStack>
              <ToggleRow
                title={t('config_management.visual.sections.auth.auth_pool_mode')}
                description={t('config_management.visual.sections.auth.auth_pool_mode_desc')}
                checked={values.authPoolEnabled}
                disabled={disabled}
                onChange={(authPoolEnabled) => onChange({ authPoolEnabled })}
              />
              <Input
                label={t('config_management.visual.sections.auth.auth_dir')}
                placeholder="~/.cli-proxy-api"
                value={values.authDir}
                onChange={(e) => onChange({ authDir: e.target.value })}
                disabled={disabled || values.authPoolEnabled}
                hint={
                  values.authPoolEnabled
                    ? t('config_management.visual.sections.auth.auth_dir_managed_hint')
                    : t('config_management.visual.sections.auth.auth_dir_hint')
                }
              />
              {values.authPoolEnabled ? (
                <div className={styles.emptyState}>
                  {t('config_management.visual.sections.auth.auth_pool_page_hint')}
                </div>
              ) : (
                <SectionSubsection
                  title={t('config_management.visual.sections.auth.auth_pool_title')}
                  description={t('config_management.visual.sections.auth.auth_pool_desc')}
                >
                  <div className={styles.authPoolComposer}>
                    <Input
                      label={t('config_management.visual.sections.auth.auth_pool_input')}
                      placeholder={t(
                        'config_management.visual.sections.auth.auth_pool_placeholder'
                      )}
                      value={authDirPresetDraft}
                      onChange={(e) => setAuthDirPresetDraft(e.target.value)}
                      disabled={disabled}
                      hint={t('config_management.visual.sections.auth.auth_pool_hint')}
                    />
                    <div className={styles.authPoolComposerAction}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={disabled || !nextAuthDirPresetCandidate}
                        onClick={handleSaveAuthDirPreset}
                      >
                        {t('config_management.visual.sections.auth.auth_pool_add')}
                      </Button>
                    </div>
                  </div>
                  {authDirPresetItems.length > 0 ? (
                    <div className={styles.authPoolList}>
                      {authDirPresetItems.map((preset) => {
                        const isActive = isAuthDirPresetActive(preset);

                        return (
                          <div key={preset} className={styles.authPoolItem}>
                            <Button
                              type="button"
                              variant={isActive ? 'primary' : 'ghost'}
                              size="sm"
                              className={`${styles.authPoolSwitch} ${
                                isActive ? styles.authPoolSwitchActive : ''
                              }`}
                              disabled={disabled}
                              onClick={() => handleApplyAuthDirPreset(preset)}
                            >
                              <span className={styles.authPoolPath}>{preset}</span>
                              <span className={styles.authPoolMeta}>
                                {isActive ? (
                                  <span className={styles.authPoolStatus}>
                                    {t('config_management.visual.sections.auth.auth_pool_active')}
                                  </span>
                                ) : null}
                              </span>
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={disabled}
                              onClick={() => handleRemoveAuthDirPreset(preset)}
                            >
                              {t('config_management.visual.sections.auth.auth_pool_remove')}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={styles.emptyState}>
                      {t('config_management.visual.sections.auth.auth_pool_empty')}
                    </div>
                  )}
                </SectionSubsection>
              )}
              <div className={styles.subsection}>
                <ApiKeysCardEditor
                  value={values.apiKeysText}
                  disabled={disabled}
                  onChange={handleApiKeysTextChange}
                />
              </div>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="system"
            ref={(node) => {
              sectionRefs.current.system = node;
            }}
            indexLabel="05"
            icon={<IconDiamond size={16} />}
            title={t('config_management.visual.sections.system.title')}
            description={t('config_management.visual.sections.system.description')}
          >
            <SectionStack>
              <SectionGrid>
                <ToggleRow
                  title={t('config_management.visual.sections.system.debug')}
                  description={t('config_management.visual.sections.system.debug_desc')}
                  checked={values.debug}
                  disabled={disabled}
                  onChange={(debug) => onChange({ debug })}
                />
                <ToggleRow
                  title={t('config_management.visual.sections.system.commercial_mode')}
                  description={t('config_management.visual.sections.system.commercial_mode_desc')}
                  checked={values.commercialMode}
                  disabled={disabled}
                  onChange={(commercialMode) => onChange({ commercialMode })}
                />
                <ToggleRow
                  title={t('config_management.visual.sections.system.logging_to_file')}
                  description={t('config_management.visual.sections.system.logging_to_file_desc')}
                  checked={values.loggingToFile}
                  disabled={disabled}
                  onChange={(loggingToFile) => onChange({ loggingToFile })}
                />
                <ToggleRow
                  title={t('config_management.visual.sections.system.usage_statistics')}
                  description={t('config_management.visual.sections.system.usage_statistics_desc')}
                  checked={values.usageStatisticsEnabled}
                  disabled={disabled}
                  onChange={(usageStatisticsEnabled) => onChange({ usageStatisticsEnabled })}
                />
              </SectionGrid>

              <SectionGrid>
                <Input
                  label={t('config_management.visual.sections.system.logs_max_size')}
                  type="number"
                  placeholder="0"
                  value={values.logsMaxTotalSizeMb}
                  onChange={(e) => onChange({ logsMaxTotalSizeMb: e.target.value })}
                  disabled={disabled}
                  error={logsMaxSizeError}
                />
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="network"
            ref={(node) => {
              sectionRefs.current.network = node;
            }}
            indexLabel="06"
            icon={<IconTrendingUp size={16} />}
            title={t('config_management.visual.sections.network.title')}
            description={t('config_management.visual.sections.network.description')}
          >
            <SectionStack>
              <SectionGrid>
                <Input
                  label={t('config_management.visual.sections.network.proxy_url')}
                  placeholder="socks5://user:pass@127.0.0.1:1080/"
                  value={values.proxyUrl}
                  onChange={(e) => onChange({ proxyUrl: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label={t('config_management.visual.sections.network.request_retry')}
                  type="number"
                  placeholder="3"
                  value={values.requestRetry}
                  onChange={(e) => onChange({ requestRetry: e.target.value })}
                  disabled={disabled}
                  error={requestRetryError}
                />
                <Input
                  label={t('config_management.visual.sections.network.max_retry_credentials')}
                  type="number"
                  placeholder="0"
                  value={values.maxRetryCredentials}
                  onChange={(e) => onChange({ maxRetryCredentials: e.target.value })}
                  disabled={disabled}
                  hint={t('config_management.visual.sections.network.max_retry_credentials_hint')}
                  error={maxRetryCredentialsError}
                />
                <Input
                  label={t('config_management.visual.sections.network.max_retry_interval')}
                  type="number"
                  placeholder="30"
                  value={values.maxRetryInterval}
                  onChange={(e) => onChange({ maxRetryInterval: e.target.value })}
                  disabled={disabled}
                  error={maxRetryIntervalError}
                />
                <FieldShell
                  label={t('config_management.visual.sections.network.routing_strategy')}
                  labelId={routingStrategyLabelId}
                  hint={
                    values.authPoolEnabled
                      ? t(
                          'config_management.visual.sections.network.routing_strategy_managed_by_auth_pool'
                        )
                      : t('config_management.visual.sections.network.routing_strategy_hint')
                  }
                  hintId={routingStrategyHintId}
                >
                  <Select
                    value={values.routingStrategy}
                    options={[
                      {
                        value: 'round-robin',
                        label: t('config_management.visual.sections.network.strategy_round_robin'),
                      },
                      {
                        value: 'fill-first',
                        label: t('config_management.visual.sections.network.strategy_fill_first'),
                      },
                    ]}
                    id={`${routingStrategyLabelId}-select`}
                    disabled={disabled || values.authPoolEnabled}
                    ariaLabelledBy={routingStrategyLabelId}
                    ariaDescribedBy={routingStrategyHintId}
                    onChange={(nextValue) =>
                      handleRoutingStrategyChange(
                        nextValue as VisualConfigValues['routingStrategy']
                      )
                    }
                  />
                </FieldShell>
              </SectionGrid>

              <SectionGrid>
                <ToggleRow
                  title={t('config_management.visual.sections.network.force_model_prefix')}
                  description={t(
                    'config_management.visual.sections.network.force_model_prefix_desc'
                  )}
                  checked={values.forceModelPrefix}
                  disabled={disabled}
                  onChange={(forceModelPrefix) => onChange({ forceModelPrefix })}
                />
                <ToggleRow
                  title={t('config_management.visual.sections.network.ws_auth')}
                  description={t('config_management.visual.sections.network.ws_auth_desc')}
                  checked={values.wsAuth}
                  disabled={disabled}
                  onChange={(wsAuth) => onChange({ wsAuth })}
                />
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="quota"
            ref={(node) => {
              sectionRefs.current.quota = node;
            }}
            indexLabel="07"
            icon={<IconTimer size={16} />}
            title={t('config_management.visual.sections.quota.title')}
            description={t('config_management.visual.sections.quota.description')}
          >
            <SectionGrid>
              <ToggleRow
                title={t('config_management.visual.sections.quota.switch_project')}
                description={t('config_management.visual.sections.quota.switch_project_desc')}
                checked={values.quotaSwitchProject}
                disabled={disabled}
                onChange={(quotaSwitchProject) => onChange({ quotaSwitchProject })}
              />
              <ToggleRow
                title={t('config_management.visual.sections.quota.switch_preview_model')}
                description={t('config_management.visual.sections.quota.switch_preview_model_desc')}
                checked={values.quotaSwitchPreviewModel}
                disabled={disabled}
                onChange={(quotaSwitchPreviewModel) => onChange({ quotaSwitchPreviewModel })}
              />
              <ToggleRow
                title={t('config_management.visual.sections.quota.antigravity_credits')}
                description={t('config_management.visual.sections.quota.antigravity_credits_desc')}
                checked={values.quotaAntigravityCredits}
                disabled={disabled}
                onChange={(quotaAntigravityCredits) => onChange({ quotaAntigravityCredits })}
              />
            </SectionGrid>
          </ConfigSection>

          <ConfigSection
            id="streaming"
            ref={(node) => {
              sectionRefs.current.streaming = node;
            }}
            indexLabel="08"
            icon={<IconSatellite size={16} />}
            title={t('config_management.visual.sections.streaming.title')}
            description={t('config_management.visual.sections.streaming.description')}
          >
            <SectionStack>
              <SectionGrid>
                <FieldShell
                  label={t('config_management.visual.sections.streaming.keepalive_seconds')}
                  htmlFor={keepaliveInputId}
                  hint={t('config_management.visual.sections.streaming.keepalive_hint')}
                  hintId={keepaliveHintId}
                  error={keepaliveError}
                  errorId={keepaliveErrorId}
                >
                  <div className={styles.fieldControl}>
                    <input
                      id={keepaliveInputId}
                      className="input"
                      type="number"
                      placeholder="0"
                      value={values.streaming.keepaliveSeconds}
                      onChange={(e) =>
                        onChange({
                          streaming: {
                            ...values.streaming,
                            keepaliveSeconds: e.target.value,
                          },
                        })
                      }
                      disabled={disabled}
                    />
                    {isKeepaliveDisabled ? (
                      <span className={styles.inlinePill}>
                        {t('config_management.visual.sections.streaming.disabled')}
                      </span>
                    ) : null}
                  </div>
                </FieldShell>

                <Input
                  label={t('config_management.visual.sections.streaming.bootstrap_retries')}
                  type="number"
                  placeholder="1"
                  value={values.streaming.bootstrapRetries}
                  onChange={(e) =>
                    onChange({
                      streaming: {
                        ...values.streaming,
                        bootstrapRetries: e.target.value,
                      },
                    })
                  }
                  disabled={disabled}
                  hint={t('config_management.visual.sections.streaming.bootstrap_hint')}
                  error={bootstrapRetriesError}
                />
              </SectionGrid>

              <SectionGrid>
                <FieldShell
                  label={t('config_management.visual.sections.streaming.nonstream_keepalive')}
                  htmlFor={nonstreamKeepaliveInputId}
                  hint={t('config_management.visual.sections.streaming.nonstream_keepalive_hint')}
                  hintId={nonstreamKeepaliveHintId}
                  error={nonstreamKeepaliveError}
                  errorId={nonstreamKeepaliveErrorId}
                >
                  <div className={styles.fieldControl}>
                    <input
                      id={nonstreamKeepaliveInputId}
                      className="input"
                      type="number"
                      placeholder="0"
                      value={values.streaming.nonstreamKeepaliveInterval}
                      onChange={(e) =>
                        onChange({
                          streaming: {
                            ...values.streaming,
                            nonstreamKeepaliveInterval: e.target.value,
                          },
                        })
                      }
                      disabled={disabled}
                    />
                    {isNonstreamKeepaliveDisabled ? (
                      <span className={styles.inlinePill}>
                        {t('config_management.visual.sections.streaming.disabled')}
                      </span>
                    ) : null}
                  </div>
                </FieldShell>
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="payload"
            ref={(node) => {
              sectionRefs.current.payload = node;
            }}
            indexLabel="09"
            icon={<IconCode size={16} />}
            title={t('config_management.visual.sections.payload.title')}
            description={t('config_management.visual.sections.payload.description')}
          >
            <SectionStack>
              <SectionSubsection
                title={t('config_management.visual.sections.payload.default_rules')}
                description={t('config_management.visual.sections.payload.default_rules_desc')}
              >
                <PayloadRulesEditor
                  value={values.payloadDefaultRules}
                  disabled={disabled}
                  onChange={handlePayloadDefaultRulesChange}
                />
              </SectionSubsection>

              <SectionSubsection
                title={t('config_management.visual.sections.payload.default_raw_rules')}
                description={t('config_management.visual.sections.payload.default_raw_rules_desc')}
              >
                <PayloadRulesEditor
                  value={values.payloadDefaultRawRules}
                  disabled={disabled}
                  rawJsonValues
                  onChange={handlePayloadDefaultRawRulesChange}
                />
              </SectionSubsection>

              <SectionSubsection
                title={t('config_management.visual.sections.payload.override_rules')}
                description={t('config_management.visual.sections.payload.override_rules_desc')}
              >
                <PayloadRulesEditor
                  value={values.payloadOverrideRules}
                  disabled={disabled}
                  protocolFirst
                  onChange={handlePayloadOverrideRulesChange}
                />
              </SectionSubsection>

              <SectionSubsection
                title={t('config_management.visual.sections.payload.override_raw_rules')}
                description={t('config_management.visual.sections.payload.override_raw_rules_desc')}
              >
                <PayloadRulesEditor
                  value={values.payloadOverrideRawRules}
                  disabled={disabled}
                  protocolFirst
                  rawJsonValues
                  onChange={handlePayloadOverrideRawRulesChange}
                />
              </SectionSubsection>

              <SectionSubsection
                title={t('config_management.visual.sections.payload.filter_rules')}
                description={t('config_management.visual.sections.payload.filter_rules_desc')}
              >
                <PayloadFilterRulesEditor
                  value={values.payloadFilterRules}
                  disabled={disabled}
                  onChange={handlePayloadFilterRulesChange}
                />
              </SectionSubsection>
            </SectionStack>
          </ConfigSection>
        </div>
      </div>

      {shouldRenderFloatingSidebar && typeof document !== 'undefined'
        ? createPortal(
            <div ref={floatingSidebarRef} className={styles.floatingSidebarContainer}>
              <div className={styles.floatingSidebarRail}>{navContent}</div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
