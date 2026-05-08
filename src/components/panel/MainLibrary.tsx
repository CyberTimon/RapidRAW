import React, { useState, useEffect, useMemo } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  AlertTriangle,
  Check,
  Folder,
  FolderInput,
  Home,
  Loader2,
  RefreshCw,
  Settings,
  Search,
  Users,
  SlidersHorizontal,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '../ui/Button';
import SettingsPanel from './SettingsPanel';
import { ThemeProps, THEMES, DEFAULT_THEME_ID } from '../../utils/themes';
import {
  AppSettings,
  ImageFile,
  Invokes,
  LibraryViewMode,
  Progress,
  SupportedTypes,
  ThumbnailSize,
  ThumbnailAspectRatio,
  RawStatus,
  SortDirection,
} from '../ui/AppProperties';
import { ImportState, Status } from '../ui/ExportImportProperties';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useLibraryStore } from '../../store/useLibraryStore';

import LibraryGrid from './library/LibraryGrid';
import { SearchInput, ViewOptionsDropdown } from './library/LibraryHeader';

interface MainLibraryProps {
  activePath: string | null;
  aiModelDownloadStatus: string | null;
  appSettings: AppSettings | null;
  currentFolderPath: string | null;
  imageList: Array<ImageFile>;
  imageRatings: Record<string, number>;
  importState: ImportState;
  indexingProgress: Progress;
  isLoading: boolean;
  isIndexing: boolean;
  isAndroid: boolean;
  isTreeLoading: boolean;
  libraryViewMode: LibraryViewMode;
  multiSelectedPaths: Array<string>;
  onClearSelection(): void;
  onContextMenu(event: any, path: string): void;
  onContinueSession(): void;
  onEmptyAreaContextMenu(event: any): void;
  onGoHome(): void;
  onImageClick(path: string, event: any): void;
  onImageDoubleClick(path: string): void;
  onImportClick(): void;
  onLibraryRefresh(): void;
  onOpenFolder(): void;
  onSettingsChange(settings: AppSettings): Promise<void>;
  onThumbnailAspectRatioChange(aspectRatio: ThumbnailAspectRatio): void;
  onThumbnailSizeChange(size: ThumbnailSize): void;
  onRequestThumbnails?(paths: string[]): void;
  rootPath: string | null;
  setLibraryViewMode(mode: LibraryViewMode): void;
  theme: string;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnailProgress: Progress;
  thumbnailSize: ThumbnailSize;
  onNavigateToCommunity(): void;
}

const ratingFilterOptions = [
  { value: 0, label: 'Show All' },
  { value: 1, label: '1 & up' },
  { value: 2, label: '2 & up' },
  { value: 3, label: '3 & up' },
  { value: 4, label: '4 & up' },
  { value: 5, label: '5 only' },
];

const rawStatusOptions = [
  { key: RawStatus.All, label: 'All Types' },
  { key: RawStatus.RawOnly, label: 'RAW Only' },
  { key: RawStatus.NonRawOnly, label: 'Non-RAW Only' },
  { key: RawStatus.RawOverNonRaw, label: 'Prefer RAW' },
];

const thumbnailSizeOptions = [
  { id: ThumbnailSize.Small, label: 'Small', size: 160 },
  { id: ThumbnailSize.Medium, label: 'Medium', size: 240 },
  { id: ThumbnailSize.Large, label: 'Large', size: 320 },
  { id: ThumbnailSize.List, label: 'List', size: 48 },
];

const thumbnailAspectRatioOptions = [
  { id: ThumbnailAspectRatio.Cover, label: 'Fill Square' },
  { id: ThumbnailAspectRatio.Contain, label: 'Original Ratio' },
];

export default function MainLibrary(props: MainLibraryProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [isBusyDelayed, setIsBusyDelayed] = useState(false);
  const [isProgressHovered, setIsProgressHovered] = useState(false);

  const searchCriteria = useLibraryStore((state) => state.searchCriteria);

  const sortOptions = useMemo(() => {
    const exifEnabled = props.appSettings?.enableExifReading ?? false;
    return [
      { key: 'name', label: 'File Name' },
      { key: 'date', label: 'Date Modified' },
      { key: 'rating', label: 'Rating' },
      { key: 'date_taken', label: 'Date Taken', disabled: !exifEnabled },
      { key: 'focal_length', label: 'Focal Length', disabled: !exifEnabled },
      { key: 'iso', label: 'ISO', disabled: !exifEnabled },
      { key: 'shutter_speed', label: 'Shutter Speed', disabled: !exifEnabled },
      { key: 'aperture', label: 'Aperture', disabled: !exifEnabled },
    ];
  }, [props.appSettings?.enableExifReading]);

  const isBusy =
    props.isLoading ||
    ((props.thumbnailProgress?.total ?? 0) > 0 &&
      (props.thumbnailProgress?.current ?? 0) < (props.thumbnailProgress?.total ?? 0));

  useEffect(() => {
    let timer: number | undefined;

    if (isBusy) {
      timer = window.setTimeout(() => setIsBusyDelayed(true), 1000);
    } else {
      timer = window.setTimeout(() => setIsBusyDelayed(false), 500);
    }

    return () => clearTimeout(timer);
  }, [isBusy]);

  useEffect(() => {
    const compareVersions = (v1: string, v2: string) => {
      const parts1 = v1.split('.').map(Number);
      const parts2 = v2.split('.').map(Number);
      const len = Math.max(parts1.length, parts2.length);
      for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
      }
      return 0;
    };

    const checkVersion = async () => {
      try {
        const currentVersion = await getVersion();
        setAppVersion(currentVersion);

        const response = await fetch('https://api.github.com/repos/CyberTimon/RapidRAW/releases/latest');
        if (!response.ok) {
          console.error('Failed to fetch latest release info from GitHub.');
          return;
        }
        const data = await response.json();
        const latestTag = data.tag_name;
        if (!latestTag) return;

        const latestVersionStr = latestTag.startsWith('v') ? latestTag.substring(1) : latestTag;
        setLatestVersion(latestVersionStr);

        if (compareVersions(currentVersion, latestVersionStr) < 0) {
          setIsUpdateAvailable(true);
        }
      } catch (error) {
        console.error('Error checking for updates:', error);
      }
    };

    checkVersion();
  }, []);

  if (!props.rootPath) {
    if (!props.appSettings) {
      return null;
    }
    const hasLastPath = !!props.appSettings.lastRootPath;
    const currentThemeId = props.theme || DEFAULT_THEME_ID;
    const selectedTheme: ThemeProps | undefined =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    const splashImage = selectedTheme?.splashImage;

    return (
      <div className="flex-1 flex h-full p-2 bg-transparent">
        <div className="flex w-full h-full bg-bg-secondary rounded-lg border border-border-color/25 overflow-hidden">
          <div className="w-1/2 hidden md:block relative overflow-hidden bg-black">
            <AnimatePresence>
              <motion.img
                alt="Splash screen background"
                className="absolute inset-0 w-full h-full object-cover"
                key={splashImage}
                src={splashImage}
              />
            </AnimatePresence>
          </div>

          <div className="w-full md:w-1/2 relative overflow-hidden isolate">
            <div className="absolute inset-0 -z-10 pointer-events-none">
              <AnimatePresence>
                {splashImage && (
                  <motion.img
                    key={splashImage + '-ambient'}
                    src={splashImage}
                    className="absolute inset-0 w-full h-full object-cover blur-2xl opacity-50 pointer-events-none"
                    aria-hidden="true"
                  />
                )}
              </AnimatePresence>
              <div className="absolute inset-0 bg-bg-secondary/90"></div>
            </div>

            <div className="w-full h-full flex flex-col p-8 lg:p-16 overflow-y-auto custom-scrollbar relative z-10">
              {showSettings ? (
                <SettingsPanel
                  appSettings={props.appSettings}
                  onBack={() => setShowSettings(false)}
                  onLibraryRefresh={props.onLibraryRefresh}
                  onSettingsChange={props.onSettingsChange}
                  rootPath={props.rootPath}
                />
              ) : (
                <>
                  <div className="my-auto text-left relative z-10">
                    <Text variant={TextVariants.displayLarge}>RapidRAW</Text>
                    <Text
                      variant={TextVariants.heading}
                      color={TextColors.secondary}
                      weight={TextWeights.normal}
                      className="mb-10 max-w-md drop-shadow-sm"
                    >
                      {hasLastPath ? (
                        <>
                          Welcome back!
                          <br />
                          Continue where you left off or start a new session.
                        </>
                      ) : (
                        `A blazingly fast, GPU-accelerated RAW image editor. ${
                          props.isAndroid ? 'Open the library to begin.' : 'Open a folder to begin.'
                        }`
                      )}
                    </Text>
                    <div className="flex flex-col w-full max-w-xs gap-4 relative z-10">
                      {hasLastPath && (
                        <Button
                          className="rounded-md h-11 w-full flex justify-center items-center shadow-md"
                          onClick={props.onContinueSession}
                          size="lg"
                        >
                          <RefreshCw size={20} className="mr-2" /> Continue Session
                        </Button>
                      )}
                      <div className="flex items-center gap-2">
                        <Button
                          className={`rounded-md grow flex justify-center items-center shadow-md h-11 ${
                            hasLastPath ? 'bg-surface text-text-primary' : ''
                          }`}
                          onClick={props.onOpenFolder}
                          size="lg"
                        >
                          <Folder size={20} className="mr-2" />
                          {props.isAndroid ? 'Open Library' : hasLastPath ? 'Change Folder' : 'Open Folder'}
                        </Button>
                        <Button
                          className="px-3 bg-surface text-text-primary shadow-md h-11"
                          onClick={() => setShowSettings(true)}
                          size="lg"
                          data-tooltip="Go to Settings"
                          variant="ghost"
                        >
                          <Settings size={20} />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <Text
                    variant={TextVariants.small}
                    as="div"
                    className="absolute bottom-8 left-8 lg:left-16 space-y-1 z-10 drop-shadow-sm"
                  >
                    <p>
                      Images by{' '}
                      <a
                        href="https://instagram.com/timonkaech.photography"
                        className="hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Timon Käch
                      </a>
                    </p>
                    {appVersion && (
                      <div className="flex items-center space-x-2">
                        <p>
                          <span
                            className={`group transition-all duration-300 ease-in-out rounded-md py-1 ${
                              isUpdateAvailable
                                ? 'cursor-pointer border border-yellow-500 px-2 hover:bg-yellow-500/20'
                                : ''
                            }`}
                            onClick={() => {
                              if (isUpdateAvailable) {
                                open('https://github.com/CyberTimon/RapidRAW/releases/latest');
                              }
                            }}
                            data-tooltip={
                              isUpdateAvailable
                                ? `Click to download version ${latestVersion}`
                                : `You are on the latest version`
                            }
                          >
                            <span className={isUpdateAvailable ? 'group-hover:hidden' : ''}>Version {appVersion}</span>
                            {isUpdateAvailable && (
                              <span className="hidden group-hover:inline text-yellow-400">New version available!</span>
                            )}
                          </span>
                        </p>
                        <span>-</span>
                        <p>
                          <a
                            href="https://ko-fi.com/cybertimon"
                            className="hover:underline"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Donate on Ko-Fi
                          </a>
                          <span className="mx-1">or</span>
                          <a
                            href="https://github.com/CyberTimon/RapidRAW"
                            className="hover:underline"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Contribute on GitHub
                          </a>
                        </p>
                      </div>
                    )}
                  </Text>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-bg-secondary rounded-lg overflow-hidden">
      <header
        className="p-4 shrink-0 flex justify-between items-center border-b border-surface gap-4"
        onMouseEnter={() => setIsProgressHovered(true)}
        onMouseLeave={() => setIsProgressHovered(false)}
      >
        <div className="min-w-0">
          <Text variant={TextVariants.headline}>Library</Text>
          {!props.isAndroid && (
            <div className="flex items-center gap-2">
              {props.currentFolderPath ? (
                <Text className="truncate">{props.currentFolderPath}</Text>
              ) : (
                <p className="text-sm invisible select-none pointer-events-none h-5 overflow-hidden"></p>
              )}
              <div
                className={`flex items-center gap-2 overflow-hidden transition-all duration-300 whitespace-nowrap ${
                  isBusyDelayed ? 'max-w-xs opacity-100' : 'max-w-0 opacity-0'
                }`}
              >
                <Loader2 size={14} className="animate-spin text-text-secondary shrink-0" />
                <div
                  className={`flex items-center transition-all duration-300 ease-out overflow-hidden ${
                    isProgressHovered && isBusyDelayed && (props.thumbnailProgress?.total ?? 0) > 0
                      ? 'max-w-xs opacity-100'
                      : 'max-w-0 opacity-0'
                  }`}
                >
                  <Text variant={TextVariants.small} color={TextColors.secondary} className="whitespace-nowrap">
                    ({props.thumbnailProgress?.current ?? 0}/{props.thumbnailProgress?.total ?? 0})
                  </Text>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {props.importState.status === Status.Importing && (
            <Text as="div" color={TextColors.accent} className="flex items-center gap-2 animate-pulse">
              <FolderInput size={16} />
              <span>
                Importing... ({props.importState.progress?.current}/{props.importState.progress?.total})
              </span>
            </Text>
          )}
          {props.importState.status === Status.Success && (
            <Text as="div" color={TextColors.success} className="flex items-center gap-2">
              <Check size={16} />
              <span>Import Complete!</span>
            </Text>
          )}
          {props.importState.status === Status.Error && (
            <Text as="div" color={TextColors.error} className="flex items-center gap-2">
              <AlertTriangle size={16} />
              <span>Import Failed!</span>
            </Text>
          )}
          <SearchInput indexingProgress={props.indexingProgress} isIndexing={props.isIndexing} />
          <ViewOptionsDropdown
            libraryViewMode={props.libraryViewMode}
            onSelectSize={props.onThumbnailSizeChange}
            onSelectAspectRatio={props.onThumbnailAspectRatioChange}
            setLibraryViewMode={props.setLibraryViewMode}
            thumbnailSize={props.thumbnailSize}
            thumbnailAspectRatio={props.thumbnailAspectRatio}
            thumbnailSizeOptions={thumbnailSizeOptions}
            thumbnailAspectRatioOptions={thumbnailAspectRatioOptions}
            ratingFilterOptions={ratingFilterOptions}
            rawStatusOptions={rawStatusOptions}
            sortOptions={sortOptions}
          />
          {!props.isAndroid && (
            <>
              <Button
                className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
                onClick={props.onNavigateToCommunity}
                data-tooltip="Community Presets"
              >
                <Users className="w-8 h-8" />
              </Button>
              <Button
                className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
                onClick={props.onOpenFolder}
                data-tooltip="Open another folder"
              >
                <Folder className="w-8 h-8" />
              </Button>
            </>
          )}
          <Button
            className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
            onClick={props.onGoHome}
            data-tooltip="Go to Home"
          >
            <Home className="w-8 h-8" />
          </Button>
        </div>
      </header>

      {props.imageList.length > 0 ? (
        <LibraryGrid {...props} thumbnailSizeOptions={thumbnailSizeOptions} />
      ) : props.isIndexing || props.aiModelDownloadStatus || props.importState.status === Status.Importing ? (
        <div className="flex-1 flex flex-col items-center justify-center" onContextMenu={props.onEmptyAreaContextMenu}>
          <Loader2 className="h-12 w-12 text-secondary animate-spin mb-4" />
          <Text variant={TextVariants.heading} color={TextColors.secondary}>
            {props.aiModelDownloadStatus
              ? `Downloading ${props.aiModelDownloadStatus}...`
              : props.isIndexing && props.indexingProgress.total > 0
                ? `Indexing images... (${props.indexingProgress.current}/${props.indexingProgress.total})`
                : props.importState.status === Status.Importing &&
                    props.importState?.progress?.total &&
                    props.importState.progress.total > 0
                  ? `Importing images... (${props.importState.progress?.current}/${props.importState.progress?.total})`
                  : 'Processing images...'}
          </Text>
          <Text className="mt-2">This may take a moment.</Text>
        </div>
      ) : searchCriteria.tags.length > 0 || searchCriteria.text ? (
        <div
          className="flex-1 flex flex-col items-center justify-center text-text-secondary text-center"
          onContextMenu={props.onEmptyAreaContextMenu}
        >
          <Search className="h-12 w-12 text-secondary mb-4" />
          <Text variant={TextVariants.heading} color={TextColors.secondary}>
            No Results Found
          </Text>
          <Text className="mt-2 max-w-sm">
            Could not find an image based on filename or tags.
            {!props.appSettings?.enableAiTagging &&
              ' For a more comprehensive search, enable automatic tagging in Settings.'}
          </Text>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center" onContextMenu={props.onEmptyAreaContextMenu}>
          <SlidersHorizontal className="h-12 w-12 mb-4 text-text-secondary" />
          <Text>No images found that match your filter.</Text>
        </div>
      )}
      {props.isAndroid && (
        <Button
          className="absolute bottom-18 right-8 h-12 w-12 bg-accent text-button-text shadow-lg p-0 flex items-center justify-center z-50 border border-border-color/50"
          onClick={(e) => {
            e.stopPropagation();
            props.onImportClick();
          }}
          data-tooltip="Import Images"
        >
          <FolderInput className="w-6 h-6" />
        </Button>
      )}
    </div>
  );
}
