import React, { useEffect, useCallback, useState, useRef } from 'react';
import {
  Camera,
  RefreshCw,
  Image as ImageIcon,
  Grid3x3,
  RotateCw,
  FlipHorizontal,
  Layers,
  Loader,
  Power,
  Battery,
  BatteryCharging,
  BatteryLow,
  BatteryMedium,
  BatteryFull,
  BatteryWarning,
  Focus,
  Gauge,
  Sliders,
  Folder as FolderIcon,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';

import Text from '../../ui/Text';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import { TextVariants, TextColors, TextWeights } from '../../../types/typography';
import { Invokes, Preset } from '../../ui/AppProperties';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useEditorStore } from '../../../store/useEditorStore';
import { usePresets } from '../../../hooks/usePresets';
import { useContextMenu } from '../../../context/ContextMenuContext';

import CompositionOverlays from '../editor/overlays/CompositionOverlays';
import type { OverlayMode } from '../right/CropPanel';
import { IconAperture, IconShutter, IconIso } from '../editor/ExifIcons';
import { useTetheringStore, CameraSetting } from '../../../store/useTetheringStore';

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const IconColorTemp = (props: React.SVGProps<SVGSVGElement>) => (
  <svg {...iconProps} {...props}>
    <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
  </svg>
);

const IconExposureComp = (props: React.SVGProps<SVGSVGElement>) => (
  <svg {...iconProps} {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12h8" />
    <path d="M12 8v8" />
  </svg>
);

const parseSettingToNumber = (val: string): number => {
  let clean = val.toLowerCase().replace(/^f\/?/, '').trim();

  if (clean.includes('/')) {
    const parts = clean.split('/');
    if (parts.length === 2) {
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (!isNaN(num) && !isNaN(den) && den !== 0) {
        return num / den;
      }
    }
  }

  clean = clean.replace(/[^0-9.]/g, '');
  return parseFloat(clean) || 0;
};

function SettingInput({
  setting,
  onUpdate,
  placeholder,
}: {
  setting: CameraSetting;
  onUpdate: (val: string) => void;
  placeholder: string;
}) {
  const [localVal, setLocalVal] = useState(setting.current_value);

  useEffect(() => {
    setLocalVal(setting.current_value);
  }, [setting.current_value]);

  const commitValue = () => {
    if (!localVal.trim()) {
      setLocalVal(setting.current_value);
      return;
    }

    if (setting.choices.length === 0) {
      if (localVal !== setting.current_value) {
        onUpdate(localVal);
      }
      return;
    }

    const inputNum = parseSettingToNumber(localVal);

    let closestChoice = setting.choices[0];
    let minDiff = Infinity;

    for (const choice of setting.choices) {
      const choiceNum = parseSettingToNumber(choice);
      const diff = Math.abs(choiceNum - inputNum);
      if (diff < minDiff) {
        minDiff = diff;
        closestChoice = choice;
      }
    }

    setLocalVal(closestChoice);
    if (closestChoice !== setting.current_value) {
      onUpdate(closestChoice);
    }
  };

  return (
    <input
      type="text"
      value={localVal}
      onChange={(e) => setLocalVal(e.target.value)}
      onBlur={commitValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className="w-full bg-bg-primary border border-surface rounded-md px-2 py-1.5 text-xs text-text-primary focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
    />
  );
}

function BatteryIndicator({ value }: { value: string }) {
  const cleanVal = value.replace('%', '').trim().toLowerCase();
  const num = parseInt(cleanVal, 10);

  let Icon = Battery;
  let color = 'text-text-secondary';
  let displayText = value;

  if (!isNaN(num)) {
    displayText = `${num}%`;
    if (num > 80) {
      Icon = BatteryFull;
      color = 'text-green-500';
    } else if (num > 40) {
      Icon = BatteryMedium;
      color = 'text-yellow-500';
    } else if (num > 15) {
      Icon = BatteryLow;
      color = 'text-orange-500';
    } else {
      Icon = BatteryWarning;
      color = 'text-red-500';
    }
  } else if (cleanVal.includes('charge')) {
    Icon = BatteryCharging;
    color = 'text-green-400';
  } else if (cleanVal.includes('good') || cleanVal.includes('ok') || cleanVal.includes('full')) {
    Icon = BatteryFull;
    color = 'text-green-500';
    displayText = '100%';
  }

  return (
    <div className="flex items-center gap-1.5 text-xs font-medium" data-tooltip={`Battery: ${displayText}`}>
      <Icon size={14} className={color} />
      <span className={color}>{displayText}</span>
    </div>
  );
}

interface TetheringPanelProps {
  onLibraryRefresh: () => Promise<void>;
  onImageSelect: (path: string, openInEditor?: boolean) => void;
}

export default function TetheringPanel({ onLibraryRefresh, onImageSelect }: TetheringPanelProps) {
  const { t } = useTranslation();
  const currentFolderPath = useLibraryStore((s) => s.currentFolderPath);
  const adjustments = useEditorStore((s) => s.adjustments);
  const { presets } = usePresets(adjustments);
  const { showContextMenu } = useContextMenu();

  const [liveViewEnabled, setLiveViewEnabled] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [ghostBlobUrl, setGhostBlobUrl] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [isFocusing, setIsFocusing] = useState(false);
  const [autoApplyPreset, setAutoApplyPreset] = useState<Preset | null>(null);

  const presetSelectBtnRef = useRef<HTMLButtonElement>(null);

  const OVERLAYS: OverlayMode[] = [
    'none',
    'thirds',
    'diagonal',
    'goldenTriangle',
    'goldenSpiral',
    'phiGrid',
    'armature',
  ];
  const [overlayIndex, setOverlayIndex] = useState(0);
  const activeOverlay = OVERLAYS[overlayIndex];

  const liveViewContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!liveViewContainerRef.current || !liveViewEnabled) return;

    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerSize({
          width: entries[0].contentRect.width,
          height: entries[0].contentRect.height,
        });
      }
    });

    observer.observe(liveViewContainerRef.current);
    return () => observer.disconnect();
  }, [liveViewEnabled]);

  const {
    cameras,
    isConnected,
    isDetecting,
    isCapturing,
    autoOpenCaptured,
    settings,
    lastCapturedPath,
    showGhostImage,
    liveViewRotation,
    liveViewFlipped,
    setTethering,
  } = useTetheringStore(
    useShallow((state) => ({
      cameras: state.cameras,
      isConnected: state.isConnected,
      isDetecting: state.isDetecting,
      isCapturing: state.isCapturing,
      autoOpenCaptured: state.autoOpenCaptured,
      settings: state.settings,
      lastCapturedPath: state.lastCapturedPath,
      showGhostImage: state.showGhostImage,
      liveViewRotation: state.liveViewRotation,
      liveViewFlipped: state.liveViewFlipped,
      setTethering: state.setTethering,
    })),
  );

  const handleDisconnect = useCallback(
    (reason?: string) => {
      setTethering({
        isConnected: false,
        isCapturing: false,
        settings: {},
      });
      setLiveViewEnabled(false);
      if (reason) {
        toast.error(reason);
      }
    },
    [setTethering],
  );

  useEffect(() => {
    if (cameras.length > 0 && !selectedCamera) {
      setSelectedCamera(cameras[0]);
    } else if (cameras.length === 0) {
      setSelectedCamera(null);
    }
  }, [cameras, selectedCamera]);

  useEffect(() => {
    let active = true;
    let currentUrl: string | null = null;

    if (showGhostImage && lastCapturedPath) {
      invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
        path: lastCapturedPath,
        jsAdjustments: {},
      })
        .then((bytes) => {
          if (active) {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            currentUrl = URL.createObjectURL(blob);
            setGhostBlobUrl(currentUrl);
          }
        })
        .catch(() => {});
    } else {
      setGhostBlobUrl(null);
    }

    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [showGhostImage, lastCapturedPath]);

  const detectCameras = useCallback(
    async (silent = false) => {
      setTethering({ isDetecting: true });
      try {
        const cams: string[] = await invoke(Invokes.TetherListCameras);
        setTethering({ cameras: cams });
        if (cams.length === 0) {
          if (!silent) {
            toast.info(t('tethering.toasts.noCamerasFound'));
          }
          if (isConnected) {
            handleDisconnect();
          }
        }
      } catch (e) {
        if (!silent) {
          toast.error(t('tethering.toasts.detectionFailed', { err: String(e) }));
        }
      } finally {
        setTethering({ isDetecting: false });
      }
    },
    [setTethering, isConnected, handleDisconnect, t],
  );

  const fetchSettings = useCallback(async () => {
    try {
      const config = await invoke<Record<string, any>>(Invokes.TetherGetSettings);
      setTethering({ settings: config });
    } catch (e) {
      handleDisconnect(t('tethering.toasts.communicationFailed'));
    }
  }, [setTethering, handleDisconnect, t]);

  const connectCamera = async () => {
    try {
      await invoke(Invokes.TetherConnect);
      setTethering({ isConnected: true });
      fetchSettings();
    } catch (e) {
      handleDisconnect(t('tethering.toasts.connectionFailed', { err: String(e) }));
    }
  };

  const updateSetting = async (key: string, value: string) => {
    setTethering((s) => ({
      settings: { ...s.settings, [key]: { ...s.settings[key], current_value: value } },
    }));
    try {
      await invoke(Invokes.TetherSetSetting, { settingName: key, value });
    } catch (e) {
      toast.error(t('tethering.toasts.setFailed', { key, err: String(e) }));
      fetchSettings();
    }
  };

  const triggerAutoFocus = async () => {
    if (isFocusing || !isConnected) return;
    setIsFocusing(true);
    try {
      await invoke('tether_autofocus');
    } catch (e) {
      toast.error(t('tethering.toasts.afFailed'));
    } finally {
      setIsFocusing(false);
    }
  };

  const captureImage = async () => {
    if (!currentFolderPath || currentFolderPath.startsWith('Album: ')) {
      toast.warn(t('tethering.toasts.selectFolderFirst'));
      return;
    }

    setTethering({ isCapturing: true });
    try {
      const filePath: string = await invoke(Invokes.TetherCapture, { destinationFolder: currentFolderPath });

      setTethering({ lastCapturedPath: filePath });

      if (autoApplyPreset) {
        try {
          await invoke(Invokes.ApplyAdjustmentsToPaths, {
            paths: [filePath],
            adjustments: autoApplyPreset.adjustments,
          });
        } catch (presetErr) {
          toast.error(t('tethering.toasts.presetApplyFailed'));
        }
      }

      await onLibraryRefresh();

      if (autoOpenCaptured) {
        onImageSelect(filePath, true);
      }
    } catch (e) {
      toast.error(t('tethering.toasts.captureFailed', { err: String(e) }));
      fetchSettings();
    } finally {
      setTethering({ isCapturing: false });
    }
  };

  useEffect(() => {
    if (isConnected || cameras.length > 0) return;

    detectCameras(true);

    const interval = setInterval(() => {
      const state = useTetheringStore.getState();
      if (!state.isConnected && state.cameras.length === 0 && !state.isDetecting) {
        detectCameras(true);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isConnected, cameras.length, detectCameras]);

  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(async () => {
      if (useTetheringStore.getState().isCapturing || liveViewEnabled) return;
      try {
        const cams: string[] = await invoke(Invokes.TetherListCameras);
        setTethering({ cameras: cams });
        if (cams.length === 0 || (selectedCamera && !cams.includes(selectedCamera))) {
          handleDisconnect(t('tethering.toasts.cameraDisconnected'));
        }
      } catch {
        handleDisconnect(t('tethering.toasts.cameraDisconnected'));
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isConnected, liveViewEnabled, selectedCamera, handleDisconnect, setTethering, t]);

  useEffect(() => {
    let active = true;
    let currentUrl: string | null = null;
    let isFetching = false;
    let lastFrameTime = 0;
    let consecutiveErrors = 0;
    const frameInterval = 1000 / 24;

    const frameLoop = async (timestamp: number) => {
      if (!active || !liveViewEnabled || !isConnected) return;

      const elapsed = timestamp - lastFrameTime;

      if (elapsed >= frameInterval) {
        const currentlyCapturing = useTetheringStore.getState().isCapturing;

        if (!currentlyCapturing && !isFetching) {
          isFetching = true;
          lastFrameTime = timestamp - (elapsed % frameInterval);

          try {
            const buffer = await invoke<ArrayBuffer>(Invokes.TetherGetPreview);

            if (active && buffer && buffer.byteLength > 0) {
              consecutiveErrors = 0;
              const blob = new Blob([buffer], { type: 'image/jpeg' });
              const url = URL.createObjectURL(blob);

              if (imgRef.current) {
                imgRef.current.src = url;
              }

              if (currentUrl) URL.revokeObjectURL(currentUrl);
              currentUrl = url;
            }
          } catch {
            consecutiveErrors++;
            if (consecutiveErrors > 5) {
              handleDisconnect(t('tethering.toasts.cameraDisconnected'));
              return;
            }
          } finally {
            isFetching = false;
          }
        }
      }

      if (active && liveViewEnabled) {
        requestAnimationFrame(frameLoop);
      }
    };

    if (liveViewEnabled) {
      requestAnimationFrame(frameLoop);
    }

    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [liveViewEnabled, isConnected, handleDisconnect, t]);

  const generatePresetSubmenu = (presetList: any[]): any[] => {
    return presetList
      .map((item: any) => {
        if (item.folder) {
          return {
            label: item.folder.name,
            icon: FolderIcon,
            submenu: generatePresetSubmenu(item.folder.children),
          };
        }
        if (item.preset || item.adjustments) {
          const presetObj = item.preset || item;
          return {
            label: presetObj.name,
            onClick: () => setAutoApplyPreset(presetObj),
          };
        }
        return null;
      })
      .filter(Boolean);
  };

  const handleOpenPresetMenu = () => {
    if (presetSelectBtnRef.current) {
      const rect = presetSelectBtnRef.current.getBoundingClientRect();
      const presetSubmenu = generatePresetSubmenu(presets);
      const options =
        presetSubmenu.length > 0
          ? presetSubmenu
          : [{ label: t('editor.masks.settings.noPresetsFound'), disabled: true }];
      showContextMenu(rect.left, rect.bottom + 5, options);
    }
  };

  const renderInputSetting = (key: string, label: string, IconComponent: React.FC<any>, placeholder: string) => {
    const setting = settings[key];
    if (!setting) return null;

    return (
      <div className="flex flex-col gap-1 bg-surface p-2 rounded-lg border border-surface">
        <div className="flex items-center gap-1.5 text-text-secondary mb-1">
          <span className="text-text-secondary opacity-90 flex items-center justify-center shrink-0">
            <IconComponent />
          </span>
          <Text variant={TextVariants.small} weight={TextWeights.semibold}>
            {label}
          </Text>
        </div>
        <SettingInput setting={setting} onUpdate={(val) => updateSetting(key, val)} placeholder={placeholder} />
      </div>
    );
  };

  const renderDropdown = (key: string, label: string, icon: React.ReactNode) => {
    const setting = settings[key];
    if (!setting) return null;

    const options = setting.choices.map((choice) => ({
      label: choice,
      value: choice,
    }));

    return (
      <div className="flex flex-col gap-1 bg-surface p-2 rounded-lg border border-surface">
        <div className="flex items-center gap-1.5 text-text-secondary mb-1">
          {icon}
          <Text variant={TextVariants.small} weight={TextWeights.semibold}>
            {label}
          </Text>
        </div>
        <Dropdown
          options={options}
          value={setting.current_value}
          onChange={(val) => updateSetting(key, val as string)}
          triggerClassName="w-full bg-bg-primary py-1.5 px-2 text-xs border border-surface focus:border-accent"
        />
      </div>
    );
  };

  const isPortrait = liveViewRotation % 180 !== 0;
  const batterySetting = settings['batterylevel'];

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('tethering.title')}</Text>
        <div className="flex items-center gap-1">
          <button
            className={clsx('p-2 rounded-full hover:bg-surface transition-colors', isDetecting && 'animate-spin')}
            onClick={() => detectCameras(false)}
            data-tooltip={t('tethering.scanTooltip')}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      <div className="grow overflow-y-auto p-3 flex flex-col gap-5 custom-scrollbar">
        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('tethering.status')}
          </Text>
          <div className="bg-surface border border-surface rounded-xl p-3.5 flex flex-col gap-3 cursor-default relative transition-all">
            <div className="flex justify-between items-center gap-4 relative z-10">
              <Text weight={TextWeights.semibold} color={TextColors.primary} className="truncate drop-shadow-sm">
                {isConnected ? t('tethering.cameraConnected') : t('tethering.selectCamera')}
              </Text>
              {isConnected && !liveViewEnabled && (
                <button
                  onClick={() => setLiveViewEnabled(true)}
                  className="bg-bg-primary hover:bg-card-active text-text-primary text-xs font-medium px-2.5 py-1 rounded-md border border-surface/50 transition-colors shrink-0 shadow-xs"
                >
                  {t('tethering.startLiveView')}
                </button>
              )}
            </div>

            {isConnected && (
              <div className="flex flex-col gap-1.5 relative z-10">
                <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate drop-shadow-sm">
                  {selectedCamera || (cameras.length > 0 ? cameras[0] : t('tethering.noCameraDetected'))}
                </Text>
                {batterySetting && <BatteryIndicator value={batterySetting.current_value} />}
              </div>
            )}

            {isConnected && liveViewEnabled && (
              <div
                ref={liveViewContainerRef}
                className={clsx(
                  'group relative w-full bg-black rounded-lg overflow-hidden flex items-center justify-center border border-surface shadow-inner transition-all mt-1',
                  isPortrait ? 'aspect-[2/3]' : 'aspect-[3/2]',
                )}
              >
                <div
                  className="absolute top-1/2 left-1/2 flex items-center justify-center pointer-events-none"
                  style={{
                    width: isPortrait ? '150%' : '100%',
                    height: isPortrait ? '66.666667%' : '100%',
                    transform: `translate(-50%, -50%) rotate(${liveViewRotation}deg) scaleX(${liveViewFlipped ? -1 : 1})`,
                    transformOrigin: 'center center',
                  }}
                >
                  <img ref={imgRef} alt={t('tethering.liveViewAlt')} className="w-full h-full object-contain" />

                  {showGhostImage && ghostBlobUrl && (
                    <img
                      src={ghostBlobUrl}
                      alt={t('tethering.ghostOverlayAlt')}
                      className="absolute inset-0 w-full h-full object-contain opacity-50 mix-blend-screen"
                    />
                  )}
                </div>

                <div className="absolute inset-0 z-10 pointer-events-none">
                  <CompositionOverlays
                    width={containerSize.width}
                    height={containerSize.height}
                    mode={activeOverlay}
                    rotation={0}
                    color="rgba(255, 255, 255, 0.4)"
                    opacity={0.8}
                  />
                </div>

                <div
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/75 backdrop-blur-md p-1 rounded-full border border-white/15 shadow-xl z-20 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap select-none"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => setLiveViewEnabled(false)}
                    className="p-1.5 text-white/60 hover:text-white hover:bg-white/10 rounded-full transition-colors shrink-0"
                    data-tooltip={t('tethering.stopLiveView')}
                  >
                    <Power size={14} />
                  </button>

                  <div className="w-px h-5 bg-white/20 mx-0.5 shrink-0"></div>

                  <button
                    type="button"
                    onClick={() => setOverlayIndex(0)}
                    className={clsx(
                      'px-2.5 py-1 rounded-full text-xs font-medium transition-colors shrink-0',
                      activeOverlay === 'none'
                        ? 'bg-white/20 text-white shadow-xs'
                        : 'text-white/60 hover:text-white hover:bg-white/10',
                    )}
                  >
                    {t('tethering.overlayOff')}
                  </button>

                  <button
                    type="button"
                    onClick={() => setOverlayIndex((prev) => (prev === 0 ? 1 : (prev % (OVERLAYS.length - 1)) + 1))}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors shrink-0',
                      activeOverlay !== 'none'
                        ? 'bg-accent text-button-text shadow-xs'
                        : 'text-white/60 hover:text-white hover:bg-white/10',
                    )}
                  >
                    <Grid3x3 size={13} className="shrink-0" />
                  </button>

                  <div className="w-px h-5 bg-white/20 mx-0.5 shrink-0"></div>

                  <button
                    onClick={() => setTethering((s) => ({ liveViewRotation: (s.liveViewRotation + 90) % 360 }))}
                    className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
                    data-tooltip={t('tethering.rotate90')}
                  >
                    <RotateCw size={14} />
                  </button>

                  <button
                    onClick={() => setTethering((s) => ({ liveViewFlipped: !s.liveViewFlipped }))}
                    className={clsx(
                      'p-1.5 rounded-full transition-colors shrink-0',
                      liveViewFlipped
                        ? 'bg-accent text-button-text'
                        : 'text-white/60 hover:bg-white/10 hover:text-white',
                    )}
                    data-tooltip={t('tethering.flipHorizontal')}
                  >
                    <FlipHorizontal size={14} />
                  </button>

                  <button
                    onClick={() => setTethering((s) => ({ showGhostImage: !s.showGhostImage }))}
                    disabled={!lastCapturedPath}
                    className={clsx(
                      'p-1.5 rounded-full transition-colors shrink-0 disabled:opacity-30',
                      showGhostImage && lastCapturedPath
                        ? 'bg-accent text-button-text'
                        : 'text-white/60 hover:bg-white/10 hover:text-white',
                    )}
                    data-tooltip={t('tethering.overlayLastShot')}
                  >
                    <Layers size={14} />
                  </button>
                </div>
              </div>
            )}

            {!isConnected && (
              <div className="flex flex-col gap-2">
                {cameras.length > 0 ? (
                  <Dropdown
                    options={cameras.map((cam) => ({ label: cam, value: cam }))}
                    value={selectedCamera}
                    onChange={(val) => setSelectedCamera(val as string)}
                    placeholder={t('tethering.selectCameraPlaceholder')}
                    triggerClassName="w-full bg-bg-primary py-2 text-xs border border-surface focus:border-accent"
                  />
                ) : (
                  <Text variant={TextVariants.small} color={TextColors.secondary}>
                    {t('tethering.noCamerasFound')}
                  </Text>
                )}
                <button
                  disabled={cameras.length === 0}
                  onClick={connectCamera}
                  className="w-full bg-accent text-button-text text-sm font-medium py-1.5 rounded-md hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('tethering.connectCamera')}
                </button>
              </div>
            )}
          </div>
        </div>

        {isConnected && (
          <>
            <div className="flex flex-col gap-2.5">
              <Text variant={TextVariants.heading} className="flex items-center gap-2">
                {t('tethering.exposureSettings')}
              </Text>
              <div className="grid grid-cols-2 gap-2">
                {renderDropdown(
                  'meteringmode',
                  t('tethering.metering'),
                  <Gauge size={14} className="text-text-secondary" />,
                )}
                {renderInputSetting(
                  'shutterspeed',
                  t('tethering.shutter'),
                  IconShutter,
                  t('tethering.shutterPlaceholder'),
                )}
                {renderInputSetting(
                  'aperture',
                  t('tethering.aperture'),
                  IconAperture,
                  t('tethering.aperturePlaceholder'),
                )}
                {renderInputSetting('iso', t('tethering.iso'), IconIso, t('tethering.isoPlaceholder'))}
                {renderInputSetting(
                  'colortemperature',
                  t('tethering.wbTemp'),
                  IconColorTemp,
                  t('tethering.wbTempPlaceholder'),
                )}
                {renderDropdown(
                  'whitebalance',
                  t('tethering.whiteBalance'),
                  <ImageIcon size={14} className="text-text-secondary" />,
                )}
                {renderInputSetting(
                  'exposurecompensation',
                  t('tethering.expComp'),
                  IconExposureComp,
                  t('tethering.expCompPlaceholder'),
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <Text variant={TextVariants.heading} className="flex items-center gap-2">
                {t('tethering.generalSettings')}
              </Text>

              <div className="flex flex-col gap-1 bg-surface p-2.5 rounded-lg border border-surface">
                <div className="flex justify-between items-center">
                  <Text variant={TextVariants.label} className="select-none">
                    {t('tethering.autoApplyPreset')}
                  </Text>
                  <button
                    ref={presetSelectBtnRef}
                    onClick={handleOpenPresetMenu}
                    className="text-xs text-text-primary hover:text-accent font-medium transition-colors cursor-pointer"
                  >
                    {autoApplyPreset ? t('tethering.changePreset') : t('editor.masks.settings.select')}
                  </button>
                </div>

                {autoApplyPreset && (
                  <div className="flex items-center justify-between bg-bg-primary px-2.5 py-1.5 rounded-md border border-surface mt-1">
                    <Text variant={TextVariants.small} color={TextColors.primary} className="truncate font-medium">
                      {autoApplyPreset.name}
                    </Text>
                    <button
                      onClick={() => setAutoApplyPreset(null)}
                      className="p-1 hover:text-red-500 text-text-secondary transition-colors"
                      data-tooltip={t('tethering.clearPreset')}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-surface p-2.5 rounded-lg border border-surface">
                <Switch
                  label={t('tethering.autoOpenCaptured')}
                  checked={autoOpenCaptured}
                  onChange={(checked) => setTethering({ autoOpenCaptured: checked })}
                  trackClassName="bg-bg-primary"
                  className="w-full"
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="p-3 border-t border-surface shrink-0 flex items-center gap-2 w-full">
        <Button
          variant="secondary"
          className="h-11 px-3.5 flex items-center justify-center shrink-0 rounded-md"
          disabled={!isConnected || isFocusing || isCapturing}
          onClick={triggerAutoFocus}
          data-tooltip={t('tethering.triggerAutofocus')}
        >
          {isFocusing ? <Loader size={18} className="animate-spin" /> : <Focus size={18} />}
        </Button>

        <Button
          className="group rounded-md h-11 grow flex items-center text-md font-bold! justify-center"
          disabled={isCapturing || !isConnected}
          onClick={captureImage}
          size="lg"
        >
          {isCapturing ? (
            <>
              <Loader size={18} className="animate-spin mr-2" />
              {t('tethering.capturing')}
            </>
          ) : (
            <>
              <Camera size={18} className="mr-2" />
              {t('tethering.triggerCapture')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
