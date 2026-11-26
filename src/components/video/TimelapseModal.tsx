import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { getVideo, recentProjectsForMenu, useVideoStore } from '../../store/useVideoStore';
import {
  TIMELAPSE_RATES,
  closeTimelapseDialog,
  createTimelapse,
  mixesRaw,
  useTimelapse,
} from '../../store/videoTimelapse';
import { fpsValue, formatDuration, secondsToTicks } from '../../utils/video/time';
import { FieldRow } from './inspector/InspectorControls';
import { useModalGate } from '../../store/useUIStore';

const NEW_PROJECT = '';

export default function TimelapseModal() {
  const { t } = useTranslation();
  const requested = useTimelapse((state) => state.paths);
  useModalGate(requested !== null);
  const [paths, setPaths] = useState(requested);
  const [fps, setFps] = useState(TIMELAPSE_RATES[0]);
  const [deflicker, setDeflicker] = useState(true);
  const [target, setTarget] = useState(NEW_PROJECT);
  const [show, setShow] = useState(false);
  const recentProjects = useVideoStore((state) => state.recentProjects);
  const openRate = useVideoStore((state) =>
    state.session?.kind === 'project' && state.session.path === target && state.project
      ? fpsValue(state.project.settings.fps)
      : null,
  );

  const destinations = useMemo(() => {
    if (!paths) return [];
    const { project, session } = getVideo();
    const open = session?.kind === 'project' && project ? [{ value: session.path, label: project.name }] : [];
    return [
      { value: NEW_PROJECT, label: t('video.timelapse.newProject') },
      ...open,
      ...recentProjectsForMenu()
        .filter((recent) => !open.some((entry) => entry.value === recent.path))
        .map((recent) => ({ value: recent.path, label: recent.name })),
    ];
  }, [paths, recentProjects, t]);

  useEffect(() => {
    if (!requested) {
      setShow(false);
      const timer = window.setTimeout(() => setPaths(null), 300);
      return () => window.clearTimeout(timer);
    }
    const { project, session } = getVideo();
    const open = session?.kind === 'project' && project ? project : null;
    setPaths(requested);
    setTarget(open ? session!.path : NEW_PROJECT);
    const frame = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(frame);
  }, [requested]);

  if (!paths) return null;

  const isNew = target === NEW_PROJECT;
  const rate = isNew ? fps : openRate;
  const mixed = mixesRaw(paths);

  const create = () => {
    if (mixed || !requested) return;
    closeTimelapseDialog();
    void createTimelapse({ paths, fps, deflicker, project: target || null });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') create();
    else closeTimelapseDialog();
  };

  return createPortal(
    <div
      aria-modal="true"
      role="dialog"
      className={clsx(
        'fixed inset-0 flex items-center justify-center z-[9999] bg-black/30 backdrop-blur-xs transition-opacity duration-300',
        show ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
      onClick={closeTimelapseDialog}
    >
      <div
        className={clsx(
          'bg-surface rounded-lg shadow-xl p-6 w-full max-w-md text-text-primary transform transition-all duration-300 ease-out',
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4',
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <Text variant={TextVariants.title} className="mb-1">
          {t('video.timelapse.create')}
        </Text>
        <Text variant={TextVariants.small} color={TextColors.secondary} className="mb-5 block">
          {mixed
            ? t('video.timelapse.mixed')
            : rate
              ? t('video.timelapse.summary', {
                  count: paths.length,
                  duration: formatDuration(secondsToTicks(paths.length / rate)),
                })
              : t('video.timelapse.photoCount', { count: paths.length })}
        </Text>
        {isNew && (
          <FieldRow label={t('video.timelapse.frameRate')}>
            <SegmentedControl
              className="w-full max-w-56"
              options={TIMELAPSE_RATES.map((value) => ({ id: String(value), label: String(value) }))}
              value={String(fps)}
              onChange={(value) => setFps(Number(value))}
            />
          </FieldRow>
        )}
        <FieldRow label={t('video.timelapse.destination')}>
          <Dropdown<string> className="w-full max-w-56" options={destinations} value={target} onChange={setTarget} />
        </FieldRow>
        <Switch label={t('video.timelapse.deflicker')} checked={deflicker} onChange={setDeflicker} />
        <div className="flex justify-end gap-3 mt-6">
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none focus:outline-hidden focus:ring-0"
            onClick={closeTimelapseDialog}
            variant="ghost"
          >
            {t('modals.confirm.cancel')}
          </Button>
          <Button
            onClick={create}
            disabled={mixed}
            autoFocus
            className="focus:outline-hidden focus:ring-0 focus:ring-offset-0"
          >
            {t('video.timelapse.createButton')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
