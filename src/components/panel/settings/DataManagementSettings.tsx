import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import clsx from 'clsx';
import { FolderOpen, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import Text from '../../ui/Text';
import { TooltipLabel } from './SettingItem';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { AppSettings } from '../../../types/settings';
import { Invokes } from '../../../types/invokes';
import { useUIStore, workspaceSettingsKey } from '../../../store/useUIStore';
import { formatBytes } from '../../../utils/formatBytes';
import { DEFAULT_IMMICH_SETTINGS } from '../../../utils/immichApi';
import { useImmichStore } from '../../../store/useImmichStore';
import { VideoCachePart, restoreAfterCacheClear } from '../../../store/videoIntegration';

interface StorageUsage {
  thumbnails: number;
  aiDenoise: number;
  aiUpscale: number;
  aiMaps: number;
  metadata: number;
  immich: number;
  immichProjects: number;
  models: number;
  logs: number;
  videoProxies: number;
  videoReversed: number;
  videoAnalysis: number;
  videoTimelapses: number;
}

type StorageKey = Exclude<keyof StorageUsage, 'immichProjects'>;

interface CacheLimit {
  get(settings: AppSettings | null): number;
  set(settings: AppSettings, gb: number): AppSettings;
}

interface StorageItem {
  key: StorageKey;
  color: string;
  limit?: CacheLimit;
}

interface StorageGroup {
  key: 'video';
  limit: CacheLimit;
  parts: StorageItem[];
}

const videoCache: StorageGroup = {
  key: 'video',
  limit: {
    get: (settings) => settings?.videoCacheLimitGb ?? 50,
    set: (settings, gb) => ({ ...settings, videoCacheLimitGb: gb }),
  },
  parts: [
    { key: 'videoProxies', color: 'bg-[#a8978a]' },
    { key: 'videoReversed', color: 'bg-[#9aa08c]' },
    { key: 'videoAnalysis', color: 'bg-[#8c9cb0]' },
    { key: 'videoTimelapses', color: 'bg-[#b48a8a]' },
  ],
};

const storageEntries: Array<StorageItem | StorageGroup> = [
  {
    key: 'thumbnails',
    color: 'bg-[#8796a8]',
    limit: {
      get: (settings) => settings?.thumbnailCacheLimitGb ?? 10,
      set: (settings, gb) => ({ ...settings, thumbnailCacheLimitGb: gb }),
    },
  },
  {
    key: 'aiDenoise',
    color: 'bg-[#9d93ad]',
    limit: {
      get: (settings) => settings?.aiCacheLimitGb ?? 25,
      set: (settings, gb) => ({ ...settings, aiCacheLimitGb: gb }),
    },
  },
  {
    key: 'aiUpscale',
    color: 'bg-[#a49ab8]',
    limit: {
      get: (settings) => settings?.aiUpscaleCacheLimitGb ?? 25,
      set: (settings, gb) => ({ ...settings, aiUpscaleCacheLimitGb: gb }),
    },
  },
  {
    key: 'aiMaps',
    color: 'bg-[#ad94a2]',
    limit: {
      get: (settings) => settings?.aiMapsCacheLimitGb ?? 4,
      set: (settings, gb) => ({ ...settings, aiMapsCacheLimitGb: gb }),
    },
  },
  { key: 'models', color: 'bg-[#b0a189]' },
  {
    key: 'immich',
    color: 'bg-[#8fa597]',
    limit: {
      get: (settings) => settings?.immich?.cacheLimitGb ?? DEFAULT_IMMICH_SETTINGS.cacheLimitGb,
      set: (settings, gb) => ({
        ...settings,
        immich: { ...DEFAULT_IMMICH_SETTINGS, ...settings.immich, cacheLimitGb: gb },
      }),
    },
  },
  videoCache,
  { key: 'metadata', color: 'bg-[#8aa3a4]' },
  { key: 'logs', color: 'bg-[#8e8e8e]' },
];

const storageItems = storageEntries.flatMap((entry) => ('parts' in entry ? entry.parts : [entry]));

const VIDEO_CACHE_PARTS: Partial<Record<StorageKey, VideoCachePart>> = {
  videoProxies: 'proxies',
  videoReversed: 'reversed',
  videoAnalysis: 'analysis',
  videoTimelapses: 'timelapses',
};

type ClearableKey = Exclude<StorageKey, 'logs'>;

export interface DataConfirmRequest {
  confirmText: string;
  message: string;
  onConfirm(): void;
  title: string;
}

interface DataManagementSettingsProps {
  appSettings: AppSettings | null;
  onLibraryRefresh(): void;
  onRequestConfirm(request: DataConfirmRequest): void;
  onSettingsChange(settings: AppSettings): void | Promise<void>;
  rootPaths: string[];
}

type Status = { text: string; error?: boolean } | null;

function ActionButton({
  busy,
  children,
  danger = false,
  disabled,
  icon,
  onClick,
}: {
  busy?: boolean;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={clsx(
        'flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium shrink-0 transition-colors',
        'text-text-secondary bg-bg-primary border border-border-color',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'enabled:hover:text-red-400 enabled:hover:border-red-400/40 enabled:hover:bg-red-500/10'
          : 'enabled:hover:text-text-primary enabled:hover:border-text-secondary/40',
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

function LimitBar({
  color,
  limitGb,
  onCommit,
  usedBytes,
}: {
  color: string;
  limitGb: number;
  onCommit(limitGb: number): void;
  usedBytes: number | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(limitGb));

  useEffect(() => setDraft(String(limitGb)), [limitGb]);

  const commit = () => {
    const parsed = Math.round(Number(draft));
    const limit = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 1024) : limitGb;
    setDraft(String(limit));
    if (limit !== limitGb) onCommit(limit);
  };

  const fill = usedBytes === null ? 0 : Math.min(100, (usedBytes / (limitGb * 1024 ** 3)) * 100);

  return (
    <div className="flex items-center gap-3 mt-2.5 pl-5.5">
      <div className="flex-1 h-1 rounded-full bg-bg-primary overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-500', color)}
          style={{ width: `${fill}%` }}
        />
      </div>
      <label className="flex items-center gap-1.5 shrink-0">
        <Text as="span" variant={TextVariants.small}>
          {t('settings.data.limit')}
        </Text>
        <input
          type="number"
          min={1}
          max={1024}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className={clsx(
            'w-14 h-7 px-2 rounded-md text-xs text-right tabular-nums',
            'bg-bg-primary border border-border-color text-text-primary',
            'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-accent',
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
          )}
        />
        <Text as="span" variant={TextVariants.small}>
          {t('export.bytes.gb')}
        </Text>
      </label>
    </div>
  );
}

function Row({
  action,
  children,
  color,
  description,
  size,
  status,
  title,
  tooltip,
}: {
  action?: ReactNode;
  children?: ReactNode;
  color?: string;
  description?: ReactNode;
  size?: ReactNode;
  status?: Status;
  title: string;
  tooltip?: string;
}) {
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        {color && <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0', color)} />}
        <div className="flex-1 min-w-0">
          <Text variant={TextVariants.label} color={TextColors.primary} weight={TextWeights.medium}>
            <TooltipLabel tooltip={tooltip}>{title}</TooltipLabel>
          </Text>
          {description && (
            <Text variant={TextVariants.small} className="mt-0.5">
              {description}
            </Text>
          )}
        </div>
        {size !== undefined && (
          <Text
            variant={TextVariants.label}
            color={TextColors.primary}
            weight={TextWeights.medium}
            className="tabular-nums text-right shrink-0"
          >
            {size}
          </Text>
        )}
        {size !== undefined ? <div className="flex justify-end min-w-24 shrink-0">{action}</div> : action}
      </div>
      {children}
      {status && (
        <Text
          variant={TextVariants.small}
          color={status.error ? TextColors.error : TextColors.success}
          className={clsx('mt-1.5', color && 'pl-5.5')}
        >
          {status.text}
        </Text>
      )}
    </div>
  );
}

export default function DataManagementSettings({
  appSettings,
  onLibraryRefresh,
  onRequestConfirm,
  onSettingsChange,
  rootPaths,
}: DataManagementSettingsProps) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [logPath, setLogPath] = useState<string | null>(null);
  const statusTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refreshUsage = useCallback(async () => {
    setIsRefreshing(true);
    try {
      setUsage(await invoke<StorageUsage>(Invokes.GetStorageUsage));
    } catch (err) {
      console.error('Failed to get storage usage:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshUsage();
    invoke<string>(Invokes.GetLogFilePath)
      .then(setLogPath)
      .catch((err) => console.error('Failed to get log file path:', err));
  }, [refreshUsage]);

  const showStatus = (key: string, status: Status) => {
    clearTimeout(statusTimers.current[key]);
    setStatuses((prev) => ({ ...prev, [key]: status }));
    statusTimers.current[key] = setTimeout(() => setStatuses((prev) => ({ ...prev, [key]: null })), 3000);
  };

  useEffect(() => {
    const timers = statusTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      showStatus(key, { text: await action() });
    } catch (err) {
      console.error(`Failed to run data action "${key}":`, err);
      showStatus(key, { text: `Error: ${err}`, error: true });
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      refreshUsage();
    }
  };

  const clearActions: Record<
    ClearableKey,
    { invoke: Invokes; args?: Record<string, unknown>; message: string; success: string }
  > = {
    thumbnails: {
      invoke: Invokes.ClearThumbnailCache,
      message: t('settings.data.modals.cacheMessage'),
      success: t('settings.data.statuses.cacheSuccess'),
    },
    aiDenoise: {
      invoke: Invokes.ClearAiDenoiseCache,
      message: t('settings.data.modals.aiDenoiseMessage'),
      success: t('settings.data.statuses.aiDenoiseSuccess'),
    },
    aiUpscale: {
      invoke: Invokes.ClearAiUpscaleCache,
      message: t('settings.data.modals.aiUpscaleMessage'),
      success: t('settings.data.statuses.aiUpscaleSuccess'),
    },
    aiMaps: {
      invoke: Invokes.ClearAiMapsCache,
      message: t('settings.data.modals.aiMapsMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    models: {
      invoke: Invokes.ClearAiModels,
      message: t('settings.data.modals.modelsMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    immich: {
      invoke: Invokes.ClearImmichCache,
      message: t('settings.data.modals.immichMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    metadata: {
      invoke: Invokes.ClearMetadataCache,
      message: t('settings.data.modals.metadataMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    videoProxies: {
      invoke: Invokes.VideoClearCache,
      args: { part: VIDEO_CACHE_PARTS.videoProxies },
      message: t('settings.data.modals.videoProxiesMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    videoReversed: {
      invoke: Invokes.VideoClearCache,
      args: { part: VIDEO_CACHE_PARTS.videoReversed },
      message: t('settings.data.modals.videoReversedMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    videoAnalysis: {
      invoke: Invokes.VideoClearCache,
      args: { part: VIDEO_CACHE_PARTS.videoAnalysis },
      message: t('settings.data.modals.videoAnalysisMessage'),
      success: t('settings.data.statuses.cleared'),
    },
    videoTimelapses: {
      invoke: Invokes.VideoClearCache,
      args: { part: VIDEO_CACHE_PARTS.videoTimelapses },
      message: t('settings.data.modals.videoTimelapsesMessage'),
      success: t('settings.data.statuses.cleared'),
    },
  };

  const clearStorage = (key: ClearableKey) =>
    onRequestConfirm({
      confirmText: t('settings.data.modals.confirmClear'),
      message: clearActions[key].message,
      title: t(`settings.data.storage.${key}` as const),
      onConfirm: () =>
        run(key, async () => {
          await invoke(clearActions[key].invoke, clearActions[key].args);
          const videoPart = VIDEO_CACHE_PARTS[key];
          if (videoPart) restoreAfterCacheClear(videoPart);
          if (key === 'thumbnails') onLibraryRefresh();
          return clearActions[key].success;
        }),
    });

  const clearSidecars = () =>
    onRequestConfirm({
      confirmText: t('settings.data.modals.confirmDeleteAllEdits'),
      message: `${t('settings.data.modals.sidecarMessage')}\n\n${rootPaths.join('\n')}`,
      title: t('settings.data.modals.confirmTitle'),
      onConfirm: () =>
        run('sidecars', async () => {
          let total = 0;
          for (const root of rootPaths) {
            total += await invoke<number>(Invokes.ClearAllSidecars, { rootPath: root });
          }
          onLibraryRefresh();
          return t('settings.data.statuses.sidecarSuccess', { count: total });
        }),
    });

  const clearTags = (key: 'aiTags' | 'allTags') =>
    onRequestConfirm({
      confirmText: t(key === 'aiTags' ? 'settings.data.modals.confirmClearAi' : 'settings.data.modals.confirmClearAll'),
      message: t(key === 'aiTags' ? 'settings.data.modals.aiMessage' : 'settings.data.modals.allMessage'),
      title: t(key === 'aiTags' ? 'settings.data.modals.confirmAiTitle' : 'settings.data.modals.confirmAllTitle'),
      onConfirm: () =>
        run(key, async () => {
          let total = 0;
          for (const root of rootPaths) {
            total += await invoke<number>(key === 'aiTags' ? Invokes.ClearAiTags : Invokes.ClearAllTags, {
              rootPath: root,
            });
          }
          onLibraryRefresh();
          return t(key === 'aiTags' ? 'settings.data.statuses.aiSuccess' : 'settings.data.statuses.allSuccess', {
            count: total,
          });
        }),
    });

  const resetLayout = () =>
    onRequestConfirm({
      confirmText: t('settings.data.modals.confirmResetLayout'),
      message: t('settings.data.modals.resetLayoutMessage'),
      title: t('settings.data.modals.confirmResetLayoutTitle'),
      onConfirm: () =>
        run('layout', async () => {
          const { resetWorkspaceLayout, workspaceMode } = useUIStore.getState();
          const workspace = resetWorkspaceLayout(false);
          await onSettingsChange({ ...appSettings, [workspaceSettingsKey(workspaceMode)]: workspace } as AppSettings);
          return t('settings.data.statuses.layoutResetSuccess');
        }),
    });

  const setLimit = async (key: string, limit: CacheLimit, limitGb: number) => {
    if (!appSettings) return;
    try {
      await onSettingsChange(limit.set(appSettings, limitGb));
      if (key === 'immich') await useImmichStore.getState().refresh();
    } catch (err) {
      console.error(`Failed to set the ${key} cache limit:`, err);
      showStatus(key, { text: `Error: ${err}`, error: true });
    }
    setTimeout(refreshUsage, 1000);
  };

  const total = usage ? storageItems.reduce((sum, { key }) => sum + usage[key], 0) : 0;
  const sizeOf = (key: StorageKey) => (usage ? formatBytes(usage[key], t, 1) : '…');

  const immichConfigured = !!appSettings?.immich?.serverUrl?.trim();
  const visibleEntries = storageEntries.filter(
    ({ key }) => key !== 'immich' || immichConfigured || (usage?.immich ?? 0) > 0,
  );

  const tooltipOf = (key: StorageKey) => {
    const description = t(`settings.data.storage.${key}Desc` as const);
    if (key !== 'immich' || !usage?.immichProjects) return description;
    const kept = t('settings.data.storage.immichProjects', { size: formatBytes(usage.immichProjects, t, 1) });
    return `${description} ${kept}`;
  };

  const renderItem = (item: StorageItem) => {
    const { key, color, limit } = item;
    const limitGb = limit?.get(appSettings);
    return (
      <Row
        key={key}
        action={
          key === 'logs' ? (
            <ActionButton
              disabled={!logPath}
              icon={<FolderOpen size={13} />}
              onClick={() => logPath && invoke(Invokes.ShowInFinder, { path: logPath })}
            >
              {t('settings.data.show')}
            </ActionButton>
          ) : (
            <ActionButton
              danger
              busy={busy[key]}
              disabled={!usage?.[key]}
              icon={<Trash2 size={13} />}
              onClick={() => clearStorage(key)}
            >
              {t('settings.data.clear')}
            </ActionButton>
          )
        }
        color={color}
        size={limitGb !== undefined && usage ? `${sizeOf(key)} / ${limitGb} ${t('export.bytes.gb')}` : sizeOf(key)}
        status={statuses[key]}
        title={t(`settings.data.storage.${key}` as const)}
        tooltip={tooltipOf(key)}
      >
        {limit && limitGb !== undefined && (
          <LimitBar
            color={color}
            limitGb={limitGb}
            onCommit={(newLimitGb) => setLimit(key, limit, newLimitGb)}
            usedBytes={usage?.[key] ?? null}
          />
        )}
      </Row>
    );
  };

  const renderGroup = ({ key, limit, parts }: StorageGroup) => {
    const limitGb = limit.get(appSettings);
    const used = usage ? parts.reduce((sum, part) => sum + usage[part.key], 0) : null;
    return (
      <Row
        key={key}
        color="bg-text-secondary"
        size={used === null ? '…' : `${formatBytes(used, t, 1)} / ${limitGb} ${t('export.bytes.gb')}`}
        status={statuses[key]}
        title={t(`settings.data.storage.${key}` as const)}
        tooltip={t('settings.data.storage.videoDesc')}
      >
        <LimitBar
          color="bg-text-secondary"
          limitGb={limitGb}
          onCommit={(newLimitGb) => setLimit(key, limit, newLimitGb)}
          usedBytes={used}
        />
        <div className="divide-y divide-border-color mt-3.5 pl-5.5">{parts.map(renderItem)}</div>
      </Row>
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <Text variant={TextVariants.heading} className="mb-2">
              {t('settings.data.storageTitle')}
            </Text>
            <Text variant={TextVariants.small}>
              {t('settings.data.totalUsed', { size: usage ? formatBytes(total, t, 1) : '…' })}
            </Text>
          </div>
          <button
            onClick={refreshUsage}
            disabled={isRefreshing}
            data-tooltip={t('settings.data.refresh')}
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-primary transition-colors"
          >
            <RefreshCw size={14} className={clsx(isRefreshing && 'animate-spin')} />
          </button>
        </div>
        <div className="flex h-2 w-full gap-0.5 rounded-full overflow-hidden bg-bg-primary">
          {usage &&
            total > 0 &&
            storageItems
              .filter(({ key }) => usage[key] > 0)
              .map(({ key, color }) => (
                <div
                  key={key}
                  className={clsx('h-full transition-[width] duration-500', color)}
                  style={{ width: `${(usage[key] / total) * 100}%`, minWidth: 3 }}
                />
              ))}
        </div>

        <div className="divide-y divide-border-color mt-5">
          {visibleEntries.map((entry) => ('parts' in entry ? renderGroup(entry) : renderItem(entry)))}
        </div>
      </div>

      <div>
        <Text variant={TextVariants.heading} className="mb-2">
          {t('settings.data.libraryAndWorkspace')}
        </Text>
        <div className="divide-y divide-border-color">
          <Row
            title={t('settings.data.deleteEdits')}
            tooltip={t('settings.data.deleteEditsDesc')}
            description={rootPaths.length > 0 ? null : t('settings.data.noFolders')}
            status={statuses.sidecars}
            action={
              <ActionButton
                danger
                busy={busy.sidecars}
                disabled={rootPaths.length === 0}
                icon={<Trash2 size={13} />}
                onClick={clearSidecars}
              >
                {t('settings.data.delete')}
              </ActionButton>
            }
          />
          {(['aiTags', 'allTags'] as const).map((key) => (
            <Row
              key={key}
              title={t(`settings.data.${key}` as const)}
              tooltip={t(`settings.data.${key}Desc` as const)}
              status={statuses[key]}
              action={
                <ActionButton
                  danger
                  busy={busy[key]}
                  disabled={rootPaths.length === 0}
                  icon={<Trash2 size={13} />}
                  onClick={() => clearTags(key)}
                >
                  {t('settings.data.clear')}
                </ActionButton>
              }
            />
          ))}
          <Row
            title={t('settings.data.resetLayoutTitle')}
            tooltip={t('settings.data.resetLayoutDesc')}
            status={statuses.layout}
            action={
              <ActionButton busy={busy.layout} icon={<RotateCcw size={13} />} onClick={resetLayout}>
                {t('settings.data.reset')}
              </ActionButton>
            }
          />
        </div>
      </div>
    </div>
  );
}
