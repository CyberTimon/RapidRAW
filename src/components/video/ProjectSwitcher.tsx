import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { useModalGate } from '../../store/useUIStore';
import {
  folderOf,
  openProjectFile,
  recentProjectsForMenu,
  refreshRecentProjects,
  useCurrentProjectPath,
  useVideoStore,
} from '../../store/useVideoStore';
import { closeProjectSwitcher, openProjectDialog, useProjectSwitcher } from '../../store/videoProjects';

const STEP_KEYS: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

export default function ProjectSwitcher() {
  const { t } = useTranslation();
  const isOpen = useProjectSwitcher((state) => state.isOpen);
  useModalGate(isOpen);
  const [mounted, setMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState('');
  const [activePath, setActivePath] = useState<string | null>(null);
  const recentProjects = useVideoStore((state) => state.recentProjects);
  const openPath = useCurrentProjectPath();
  const search = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => (mounted ? recentProjectsForMenu(Infinity) : []), [mounted, recentProjects]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? projects.filter((project) => project.path.toLowerCase().includes(needle)) : projects;
  }, [projects, query]);

  const active =
    matches.find((project) => project.path === activePath) ??
    (query ? matches[0] : (matches.find((project) => project.path !== openPath) ?? matches[0]));

  useEffect(() => {
    if (!isOpen) {
      setShow(false);
      const timer = window.setTimeout(() => setMounted(false), 300);
      return () => window.clearTimeout(timer);
    }
    setMounted(true);
    setQuery('');
    setActivePath(null);
    refreshRecentProjects();
    const frame = requestAnimationFrame(() => {
      setShow(true);
      search.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const choose = (path: string) => {
    closeProjectSwitcher();
    void openProjectFile(path);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const step = STEP_KEYS[event.key];
      if (event.key === 'Escape') {
        closeProjectSwitcher();
      } else if (step && matches.length > 0) {
        const index = active ? matches.indexOf(active) : -1;
        setActivePath(matches[(index + step + matches.length) % matches.length].path);
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement) && active) {
        choose(active.path);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  });

  if (!mounted) return null;

  const browse = () => {
    closeProjectSwitcher();
    void openProjectDialog();
  };

  return createPortal(
    <div
      aria-modal="true"
      role="dialog"
      aria-labelledby="project-switcher-title"
      className={clsx(
        'fixed inset-0 flex items-center justify-center z-[9999] bg-black/30 backdrop-blur-xs transition-opacity duration-300',
        show ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
      onClick={closeProjectSwitcher}
    >
      <div
        className={clsx(
          'bg-surface rounded-lg shadow-xl p-6 w-full max-w-md text-text-primary transform transition-all duration-300 ease-out',
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <Text variant={TextVariants.title} id="project-switcher-title" className="mb-4">
          {t('video.project.openRecent')}
        </Text>
        <Input
          ref={search}
          bgClassName="bg-bg-primary"
          placeholder={t('video.mediaPool.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActivePath(null);
          }}
        />
        <div className="mt-3 max-h-80 overflow-y-auto custom-scrollbar -mx-2 px-2" role="listbox">
          {matches.map((project) => {
            const isActive = project === active;
            return (
              <button
                key={project.path}
                ref={isActive ? (row) => row?.scrollIntoView({ block: 'nearest' }) : undefined}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md flex items-center gap-3 transition-colors duration-150',
                  isActive && 'bg-bg-primary',
                )}
                onClick={() => choose(project.path)}
                onMouseMove={() => setActivePath(project.path)}
                role="option"
                aria-selected={isActive}
                tabIndex={-1}
              >
                <span className="min-w-0 flex-1">
                  <Text as="span" color={TextColors.primary} className="block truncate">
                    {project.name}
                  </Text>
                  <Text as="span" variant={TextVariants.small} className="block truncate">
                    {folderOf(project.path)}
                  </Text>
                </span>
                {project.path === openPath && <Check size={16} className="shrink-0 text-text-secondary" />}
              </button>
            );
          })}
          {matches.length === 0 && (
            <Text className="px-3 py-2">
              {projects.length === 0 ? t('video.project.noRecent') : t('video.mediaPool.noMatches')}
            </Text>
          )}
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <Button
            className="mr-auto bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none focus:outline-hidden focus:ring-0"
            onClick={browse}
            variant="ghost"
          >
            {t('video.project.openProject')}
          </Button>
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none focus:outline-hidden focus:ring-0"
            onClick={closeProjectSwitcher}
            variant="ghost"
          >
            {t('modals.confirm.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
