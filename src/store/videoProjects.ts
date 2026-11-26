import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import i18n from 'i18next';
import { Clapperboard, Folder, Trash2 } from 'lucide-react';
import { Invokes } from '../types/invokes';
import { OPTION_SEPARATOR, Option } from '../types/ui';
import { PROJECT_EXTENSION } from '../types/video';
import { revealPath } from '../components/video/mediaPool/media';
import { useLibraryStore } from './useLibraryStore';
import { useUIStore } from './useUIStore';
import {
  createEmptyVideoProject,
  createVideoProject,
  currentProjectPath,
  isProjectSession,
  openProjectFile,
  projectMedia,
  refreshRecentProjects,
  videoUnavailable,
} from './useVideoStore';

export const useProjectSwitcher = create<{ isOpen: boolean }>(() => ({ isOpen: false }));

export const openProjectSwitcher = () => {
  if (!videoUnavailable()) useProjectSwitcher.setState({ isOpen: true });
};

export const closeProjectSwitcher = () => useProjectSwitcher.setState({ isOpen: false });

const projectFolder = () => {
  const { activeAlbumId, currentFolderPath } = useLibraryStore.getState();
  return activeAlbumId ? null : currentFolderPath;
};

export const openProjectDialog = async () => {
  if (videoUnavailable()) return;
  const selected = await open({
    defaultPath: projectFolder() ?? undefined,
    filters: [
      {
        name: i18n.t('video.project.projects'),
        extensions: [PROJECT_EXTENSION, PROJECT_EXTENSION.toUpperCase()],
      },
    ],
  });
  if (typeof selected === 'string') await openProjectFile(selected);
};

const selectedPaths = () =>
  useUIStore.getState().activeView === 'library' || !isProjectSession()
    ? useLibraryStore.getState().multiSelectedPaths
    : [];

export const canCreateFrom = (paths: Array<string>) => projectMedia(paths).length > 0 || !!projectFolder();

export const newVideoProjectFrom = (paths: Array<string>) => {
  if (videoUnavailable()) return;
  const media = projectMedia(paths);
  const folder = projectFolder();
  if (media.length > 0) void createVideoProject(media);
  else if (folder) void createEmptyVideoProject(folder);
};

export const newVideoProject = () => newVideoProjectFrom(selectedPaths());

const removeRecentProject = async (path: string) => {
  await invoke(Invokes.VideoRemoveRecentProject, { path }).catch(console.error);
  await refreshRecentProjects();
};

export const recentProjectMenu = (path: string): Array<Option> => [
  {
    icon: Clapperboard,
    label: i18n.t('contextMenus.thumbnail.openVideoProject'),
    onClick: () => void openProjectFile(path),
  },
  { type: OPTION_SEPARATOR },
  { icon: Folder, label: i18n.t('contextMenus.thumbnail.showExplorer'), onClick: () => void revealPath(path) },
  {
    icon: Trash2,
    label: i18n.t('video.project.removeFromRecent'),
    isDestructive: true,
    disabled: path === currentProjectPath(),
    onClick: () => void removeRecentProject(path),
  },
];
