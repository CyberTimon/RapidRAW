import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Import, LogOut, Save } from 'lucide-react';
import SearchField from '../ui/SearchField';
import PanelHeader from '../ui/PanelHeader';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { useShortcut } from '../../hooks/useShortcuts';
import {
  exitProject,
  getVideo,
  importMediaDialog,
  renameProject,
  saveOpenProject,
  useDraftProject,
  useVideoStore,
} from '../../store/useVideoStore';
import ProjectMedia from './mediaPool/ProjectMedia';
import ProjectSettings from './mediaPool/ProjectSettings';
import PoolViewMenu from './mediaPool/PoolViewMenu';
import { currentPoolBin } from './mediaPool/poolView';

type ProjectView = 'media' | 'settings';

let rememberedView: ProjectView = 'media';

const HEADER_BUTTON_CLASS = 'p-2 rounded-full hover:bg-surface transition-colors';

function ProjectName({ name }: { name: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (next && next !== name) void renameProject(next);
  };

  if (draft === null) {
    return (
      <button
        type="button"
        className="min-w-0 flex-1 -ml-1.5 px-1.5 py-0.5 rounded-md text-left transition-colors hover:bg-surface focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setDraft(name)}
        data-tooltip={t('video.project.rename')}
      >
        <Text variant={TextVariants.title} as="span" className="block truncate -m-5 p-5">
          {name || t('video.project.namePlaceholder')}
        </Text>
      </button>
    );
  }

  return (
    <input
      autoFocus
      className="min-w-0 flex-1 -ml-1.5 px-1.5 py-0.5 rounded-md bg-surface text-xl font-bold text-text-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      value={draft}
      placeholder={t('video.project.namePlaceholder')}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ProjectPanel() {
  const { t } = useTranslation();
  const name = useVideoStore((state) => state.project?.name);
  const hasMedia = useVideoStore((state) => (state.project?.media.length ?? 0) > 0);
  const isDraft = useDraftProject();
  const saveShortcut = useShortcut('video_save_project');
  const [view, setView] = useState<ProjectView>(rememberedView);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const views = useMemo(
    () => [
      { id: 'media' as const, label: t('video.project.media') },
      { id: 'settings' as const, label: t('video.project.settings') },
    ],
    [t],
  );

  const changeView = useCallback((next: ProjectView) => {
    rememberedView = next;
    setView(next);
  }, []);

  const handleImport = useCallback(async () => {
    const before = getVideo().project?.media.length ?? 0;
    await importMediaDialog(currentPoolBin());
    if ((getVideo().project?.media.length ?? 0) > before) changeView('media');
  }, [changeView]);

  if (name === undefined) return null;

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={<ProjectName name={name} />}>
        {isDraft && (
          <>
            <Text
              as="span"
              variant={TextVariants.small}
              color={TextColors.secondary}
              className="mr-1 whitespace-nowrap"
            >
              {t('video.project.unsaved')}
            </Text>
            <button
              className={HEADER_BUTTON_CLASS}
              onClick={() => void saveOpenProject()}
              data-tooltip={t('video.project.save')}
              aria-label={t('video.project.save')}
              {...saveShortcut}
            >
              <Save size={18} />
            </button>
          </>
        )}
        <button
          className={HEADER_BUTTON_CLASS}
          onClick={() => void handleImport()}
          data-tooltip={t('video.mediaPool.import')}
          aria-label={t('video.mediaPool.import')}
        >
          <Import size={18} />
        </button>
        <button
          className={HEADER_BUTTON_CLASS}
          onClick={() => void exitProject()}
          data-tooltip={t('video.project.exit')}
          aria-label={t('video.project.exit')}
        >
          <LogOut size={18} />
        </button>
      </PanelHeader>
      <div className="p-3 flex flex-col gap-2 shrink-0">
        <SegmentedControl variant="outlined" options={views} value={view} onChange={changeView} />
        {view === 'media' && hasMedia && (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <SearchField value={query} onChange={setQuery} placeholder={t('video.mediaPool.search')} />
            </div>
            <PoolViewMenu />
          </div>
        )}
      </div>
      {view === 'media' ? (
        <ProjectMedia query={deferredQuery} onImport={() => void handleImport()} />
      ) : (
        <ProjectSettings />
      )}
    </div>
  );
}

export default memo(ProjectPanel);
