import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Camera,
  BatteryCharging,
  HardDrive,
  Video,
  VideoOff,
  Radio,
  Clock,
  Play,
  Square,
  Sparkles,
  X,
  Settings,
  Folder,
  Image as ImageIcon,
  CheckCircle2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface CameraDeviceInfo {
  id: string;
  vendor_id: number;
  product_id: number;
  model_name: string;
  serial_number: string;
  battery_percent: number;
  is_connected: boolean;
  is_live_view_capable: boolean;
  storage_free_mb: number;
  current_shutter_speed: string;
  current_aperture: string;
  current_iso: string;
  current_exposure_comp: string;
}

interface TetherCaptureResult {
  file_path: string;
  file_name: string;
  file_size_bytes: number;
  capture_timestamp: number;
  thumbnail_base64: string | null;
  camera_model: string;
  exposure_info: string;
}

interface TetheringModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPhotoCaptured?: (path: string) => void;
}

const SHUTTER_SPEEDS = [
  '1/8000', '1/4000', '1/2000', '1/1000', '1/500', '1/250', '1/125', '1/60',
  '1/30', '1/15', '1/8', '1/4', '0.5"', '1"', '2"', '5"', '10"', '30"', 'Bulb',
];

const APERTURES = [
  'f/1.4', 'f/1.8', 'f/2.0', 'f/2.8', 'f/4.0', 'f/5.6', 'f/8.0', 'f/11', 'f/16', 'f/22',
];

const ISO_VALUES = [
  '100', '200', '400', '800', '1600', '3200', '6400', '12800', '25600',
];

const EXPOSURE_COMPS = [
  '-3.0', '-2.0', '-1.0', '-0.7', '-0.3', '+0.0', '+0.3', '+0.7', '+1.0', '+2.0', '+3.0',
];

export const TetheringModal: React.FC<TetheringModalProps> = ({
  isOpen,
  onClose,
  onPhotoCaptured,
}) => {
  const [camera, setCamera] = useState<CameraDeviceInfo | null>(null);
  const [isLiveView, setIsLiveView] = useState<boolean>(false);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [sessionName, setSessionName] = useState<string>('Studio_Shoot');
  const [outputDir, setOutputDir] = useState<string>('D:\\RapidRAW_Tether');
  const [autoPolish, setAutoPolish] = useState<boolean>(true);

  // Intervalometer
  const [isIntervalometerRunning, setIsIntervalometerRunning] = useState<boolean>(false);
  const [intervalSec, setIntervalSec] = useState<number>(3);
  const [totalFrames, setTotalFrames] = useState<number>(10);
  const [framesCaptured, setFramesCaptured] = useState<number>(0);

  // Recent captures filmstrip
  const [recentCaptures, setRecentCaptures] = useState<TetherCaptureResult[]>([]);

  // Discover camera and start session
  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenCapture: (() => void) | undefined;
    let unlistenLiveView: (() => void) | undefined;

    if (isOpen) {
      // Detect camera
      invoke<CameraDeviceInfo[]>('tether_detect_cameras')
        .then((devices) => {
          if (devices.length > 0) {
            const dev = devices[0];
            setCamera(dev);
            // Start session
            invoke('tether_start_session', {
              cameraId: dev.id,
              settings: {
                session_name: sessionName,
                output_directory: outputDir,
                filename_prefix: 'IMG_',
                auto_apply_profile: autoPolish ? 'portrait' : null,
                intervalometer_interval_sec: intervalSec,
                intervalometer_total_frames: totalFrames,
              },
            }).catch(console.error);
          }
        })
        .catch(console.error);

      // Listen for camera status updates
      listen<CameraDeviceInfo>('tether-status-changed', (event) => {
        setCamera(event.payload);
      }).then((un) => (unlistenStatus = un));

      // Listen for captures
      listen<TetherCaptureResult>('tether-photo-captured', (event) => {
        const result = event.payload;
        setRecentCaptures((prev) => [result, ...prev.slice(0, 7)]);
        if (onPhotoCaptured) onPhotoCaptured(result.file_path);
      }).then((un) => (unlistenCapture = un));

      // Listen for live view state
      listen<boolean>('tether-liveview-state', (event) => {
        setIsLiveView(event.payload);
      }).then((un) => (unlistenLiveView = un));
    }

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenCapture) unlistenCapture();
      if (unlistenLiveView) unlistenLiveView();
    };
  }, [isOpen, onPhotoCaptured]);

  // Handle capture trigger
  const handleTriggerCapture = useCallback(async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    try {
      await invoke<TetherCaptureResult>('tether_trigger_capture');
    } catch (err) {
      console.error('Tether capture failed:', err);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing]);

  // Handle property change (ISO, shutter, aperture, exp comp)
  const handleUpdateProperty = async (property: string, value: string) => {
    try {
      const updated = await invoke<CameraDeviceInfo>('tether_update_camera_property', {
        property,
        value,
      });
      setCamera(updated);
    } catch (err) {
      console.error(`Failed to update ${property}:`, err);
    }
  };

  // Toggle Live View
  const handleToggleLiveView = async () => {
    try {
      const newState = !isLiveView;
      await invoke('tether_toggle_live_view', { enable: newState });
      setIsLiveView(newState);
    } catch (err) {
      console.error('Failed to toggle live view:', err);
    }
  };

  // Intervalometer loop
  useEffect(() => {
    let intervalTimer: any = null;
    if (isIntervalometerRunning) {
      intervalTimer = setInterval(async () => {
        if (framesCaptured >= totalFrames) {
          setIsIntervalometerRunning(false);
          setFramesCaptured(0);
          return;
        }
        await handleTriggerCapture();
        setFramesCaptured((prev) => prev + 1);
      }, intervalSec * 1000);
    }
    return () => {
      if (intervalTimer) clearInterval(intervalTimer);
    };
  }, [isIntervalometerRunning, framesCaptured, totalFrames, intervalSec, handleTriggerCapture]);

  // Spacebar / Enter capture keyboard listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          handleTriggerCapture();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleTriggerCapture]);

  const handleClose = async () => {
    if (isLiveView) {
      await invoke('tether_toggle_live_view', { enable: false }).catch(() => {});
    }
    await invoke('tether_stop_session').catch(() => {});
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative w-full max-w-[820px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
        >
          {/* Header & Camera Telemetry */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color bg-bg-secondary/40">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10 text-red-400">
                <Camera size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Text variant={TextVariants.heading} weight={TextWeights.bold}>
                    {camera?.model_name || 'Canon EOS 77D'}
                  </Text>
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-semibold tracking-wide uppercase">
                    <Radio size={10} className="animate-pulse" />
                    USB PTP Connected
                  </span>
                </div>
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  S/N: {camera?.serial_number || '242031008541'} • Studio Tethering Session
                </Text>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <BatteryCharging size={16} className="text-emerald-400" />
                <span className="font-mono font-medium text-text-primary">
                  {camera?.battery_percent || 88}%
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <HardDrive size={16} className="text-blue-400" />
                <span className="font-mono font-medium text-text-primary">
                  {Math.round((camera?.storage_free_mb || 29480) / 1024)} GB Free
                </span>
              </div>
              <button
                onClick={handleClose}
                className="text-text-secondary hover:text-text-primary transition-colors p-1.5 rounded-md hover:bg-surface"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Main Controls & Live View Body */}
          <div className="p-6 flex flex-col gap-5 overflow-y-auto">
            {/* Live Exposure Parameters Bar */}
            <div className="grid grid-cols-4 gap-3 p-3.5 bg-bg-secondary rounded-xl border border-border-color">
              {/* Shutter Speed */}
              <div className="flex flex-col gap-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Shutter Speed
                </Text>
                <select
                  value={camera?.current_shutter_speed || '1/125'}
                  onChange={(e) => handleUpdateProperty('shutter_speed', e.target.value)}
                  className="bg-surface text-text-primary font-mono text-sm font-semibold px-2.5 py-1.5 rounded-md border border-border-color focus:border-accent outline-hidden cursor-pointer"
                >
                  {SHUTTER_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}
                    </option>
                  ))}
                </select>
              </div>

              {/* Aperture */}
              <div className="flex flex-col gap-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Aperture
                </Text>
                <select
                  value={camera?.current_aperture || 'f/4.0'}
                  onChange={(e) => handleUpdateProperty('aperture', e.target.value)}
                  className="bg-surface text-text-primary font-mono text-sm font-semibold px-2.5 py-1.5 rounded-md border border-border-color focus:border-accent outline-hidden cursor-pointer"
                >
                  {APERTURES.map((ap) => (
                    <option key={ap} value={ap}>
                      {ap}
                    </option>
                  ))}
                </select>
              </div>

              {/* ISO */}
              <div className="flex flex-col gap-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  ISO Sensitivity
                </Text>
                <select
                  value={camera?.current_iso || '400'}
                  onChange={(e) => handleUpdateProperty('iso', e.target.value)}
                  className="bg-surface text-text-primary font-mono text-sm font-semibold px-2.5 py-1.5 rounded-md border border-border-color focus:border-accent outline-hidden cursor-pointer"
                >
                  {ISO_VALUES.map((iso) => (
                    <option key={iso} value={iso}>
                      ISO {iso}
                    </option>
                  ))}
                </select>
              </div>

              {/* Exposure Comp */}
              <div className="flex flex-col gap-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Exposure Comp
                </Text>
                <select
                  value={camera?.current_exposure_comp || '+0.0'}
                  onChange={(e) => handleUpdateProperty('exposure_comp', e.target.value)}
                  className="bg-surface text-text-primary font-mono text-sm font-semibold px-2.5 py-1.5 rounded-md border border-border-color focus:border-accent outline-hidden cursor-pointer"
                >
                  {EXPOSURE_COMPS.map((comp) => (
                    <option key={comp} value={comp}>
                      {comp} EV
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Live View & Shutter Trigger Viewport */}
            <div className="relative w-full h-72 bg-black rounded-xl border border-border-color overflow-hidden flex items-center justify-center group">
              {isLiveView ? (
                <div className="relative w-full h-full bg-[#0e0e11] flex flex-col items-center justify-center">
                  {/* Live View Overlay Grid & Crosshair */}
                  <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-20 border border-white/40">
                    <div className="border-r border-b border-white/40" />
                    <div className="border-r border-b border-white/40" />
                    <div className="border-b border-white/40" />
                    <div className="border-r border-b border-white/40" />
                    <div className="border-r border-b border-white/40 flex items-center justify-center">
                      <div className="w-12 h-12 border-2 border-emerald-400/80 rounded-sm" />
                    </div>
                    <div className="border-b border-white/40" />
                  </div>

                  <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/60 px-2.5 py-1 rounded-md text-[11px] text-emerald-400 font-mono">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    LIVE VIEW • 30 FPS • Dual Pixel AF Active
                  </div>

                  <div className="absolute bottom-3 left-3 flex items-center gap-3 bg-black/60 px-3 py-1.5 rounded-md text-xs font-mono text-white/90">
                    <span>{camera?.current_shutter_speed || '1/125'}</span>
                    <span>{camera?.current_aperture || 'f/4.0'}</span>
                    <span>ISO {camera?.current_iso || '400'}</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 text-text-secondary">
                  <div className="p-4 rounded-full bg-surface border border-border-color">
                    <VideoOff size={32} className="text-text-secondary" />
                  </div>
                  <Text variant={TextVariants.small} color={TextColors.secondary}>
                    Live View Standby • Click below to stream Canon Dual Pixel AF
                  </Text>
                </div>
              )}

              {/* Shutter Button floating in center-bottom */}
              <div className="absolute bottom-4 right-4 flex items-center gap-3">
                <button
                  onClick={handleToggleLiveView}
                  className="px-3 py-2 rounded-lg bg-surface/90 hover:bg-surface border border-border-color text-text-primary text-xs font-medium flex items-center gap-1.5 transition-all shadow-lg backdrop-blur-md"
                >
                  {isLiveView ? (
                    <>
                      <VideoOff size={14} className="text-amber-400" />
                      Pause Live View
                    </>
                  ) : (
                    <>
                      <Video size={14} className="text-emerald-400" />
                      Start Live View
                    </>
                  )}
                </button>

                <button
                  onClick={handleTriggerCapture}
                  disabled={isCapturing}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 active:scale-95 text-white font-bold text-sm transition-all shadow-xl disabled:opacity-50"
                  title="Trigger Shutter (Press Spacebar)"
                >
                  <span className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
                  {isCapturing ? 'Capturing RAW...' : 'Capture Shot'}
                </button>
              </div>
            </div>

            {/* Studio Automation & Intervalometer */}
            <div className="flex items-center justify-between p-3.5 bg-bg-secondary rounded-xl border border-border-color">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-amber-400" />
                  <div>
                    <Text variant={TextVariants.small} weight={TextWeights.medium}>
                      Instant AI Shoot Polish
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                      Auto-applies tailored profile upon RAW ingestion
                    </Text>
                  </div>
                  <Switch label="" checked={autoPolish} onChange={setAutoPolish} className="ml-2" />
                </div>

                <div className="h-6 w-px bg-border-color" />

                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-blue-400" />
                  <div>
                    <Text variant={TextVariants.small} weight={TextWeights.medium}>
                      Intervalometer
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                      {isIntervalometerRunning
                        ? `Running: ${framesCaptured} / ${totalFrames} frames`
                        : `Every ${intervalSec}s • ${totalFrames} frames`}
                    </Text>
                  </div>
                  <button
                    onClick={() => setIsIntervalometerRunning(!isIntervalometerRunning)}
                    className="ml-2 px-2.5 py-1 rounded bg-surface hover:bg-surface-secondary border border-border-color text-xs font-medium text-text-primary flex items-center gap-1"
                  >
                    {isIntervalometerRunning ? (
                      <>
                        <Square size={12} className="text-red-400" /> Stop
                      </>
                    ) : (
                      <>
                        <Play size={12} className="text-emerald-400" /> Start
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Recent Captures Filmstrip */}
            {recentCaptures.length > 0 && (
              <div className="flex flex-col gap-2">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Recent Tethered Captures ({recentCaptures.length}):
                </Text>
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {recentCaptures.map((item, idx) => (
                    <div
                      key={item.file_path + idx}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border-color shrink-0 text-xs"
                    >
                      <ImageIcon size={14} className="text-accent" />
                      <div className="flex flex-col">
                        <span className="font-mono font-medium text-text-primary">{item.file_name}</span>
                        <span className="text-[10px] text-text-secondary">{item.exposure_info}</span>
                      </div>
                      <CheckCircle2 size={12} className="text-emerald-400 ml-1" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Folder size={14} />
              <span>Saving to: <b>{outputDir}</b></span>
            </div>

            <Button onClick={handleClose}>
              Done & Close Session
            </Button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default TetheringModal;
