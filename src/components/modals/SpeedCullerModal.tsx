import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import {
  Zap,
  Star,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Loader2,
  Check,
  X,
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useShallow } from 'zustand/react/shallow';
import { Invokes } from '../ui/AppProperties';

interface FaceLoupeCrop {
  face_index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sharpness_score: number;
  is_eyes_open: boolean;
  is_sharp: boolean;
  crop_data_url: string;
}

interface CullingFrameAnalysis {
  file_path: string;
  sharpness_score: number;
  exposure_score: number;
  is_blurry: boolean;
  faces: FaceLoupeCrop[];
}

export interface BurstGroup {
  group_id: string;
  hero_path: string;
  member_paths: string[];
  hero_score: number;
  frame_count: number;
}

export default function SpeedCullerModal() {
  const { speedCullerModalState, setUI } = useUIStore(
    useShallow((state) => ({
      speedCullerModalState: state.speedCullerModalState,
      setUI: state.setUI,
    }))
  );
  const { imageList, imageRatings, setLibrary } = useLibraryStore(
    useShallow((state) => ({
      imageList: state.imageList,
      imageRatings: state.imageRatings,
      setLibrary: state.setLibrary,
    }))
  );
  const thumbnails = useProcessStore((state) => state.thumbnails);

  const isOpen = speedCullerModalState.isOpen;
  const paths = useMemo(() => {
    if (speedCullerModalState.selectedPaths && speedCullerModalState.selectedPaths.length > 0) {
      return speedCullerModalState.selectedPaths;
    }
    return imageList.map((img) => img.path);
  }, [speedCullerModalState.selectedPaths, imageList]);

  const [currentIndex, setCurrentIndex] = useState(speedCullerModalState.initialIndex || 0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [is100Zoom, setIs100Zoom] = useState(false);
  const [focusPeaking, setFocusPeaking] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [analysis, setAnalysis] = useState<CullingFrameAnalysis | null>(null);
  const [, setIsAnalyzing] = useState(false);
  const [isTriaging, setIsTriaging] = useState(false);
  const [triageReport, setTriageReport] = useState<string | null>(null);
  const [rawPreviewCache, setRawPreviewCache] = useState<Record<string, string>>({});
  const [burstGroups, setBurstGroups] = useState<BurstGroup[]>([]);
  const [isBurstGrouping, setIsBurstGrouping] = useState(false);
  const requestedPathsRef = useRef<Set<string>>(new Set());

  const currentPath = paths[currentIndex] || '';
  const nextComparePath = paths[currentIndex + 1] || paths[currentIndex - 1] || '';
  const currentImageObj = useMemo(
    () => imageList.find((img) => img.path === currentPath),
    [imageList, currentPath]
  );

  const currentBurstGroup = useMemo(() => {
    return burstGroups.find((g) => g.member_paths.includes(currentPath));
  }, [burstGroups, currentPath]);

  // Auto-Burst & Hero Pick Detection
  const isHeroPick = useMemo(() => {
    if (currentBurstGroup && currentBurstGroup.hero_path === currentPath) {
      return true;
    }
    if (!analysis) return false;
    return analysis.sharpness_score > 40.0 && !analysis.is_blurry;
  }, [currentBurstGroup, currentPath, analysis]);

  // Sync initial index
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(speedCullerModalState.initialIndex || 0);
      setTriageReport(null);
    }
  }, [isOpen, speedCullerModalState.initialIndex]);

  // Load active frame preview (from cache, thumbnails, or fast embedded extractor)
  useEffect(() => {
    if (!isOpen || !currentPath) return;

    if (rawPreviewCache[currentPath] || thumbnails[currentPath]) {
      return;
    }

    if (requestedPathsRef.current.has(currentPath)) return;
    requestedPathsRef.current.add(currentPath);

    let isMounted = true;
    invoke<string>(Invokes.ExtractEmbeddedRawPreview, { path: currentPath })
      .then((dataUrl) => {
        if (isMounted && dataUrl) {
          setRawPreviewCache((prev) => ({ ...prev, [currentPath]: dataUrl }));
        }
      })
      .catch(() => {
        const fallback = convertFileSrc(currentPath.replace(/\\/g, '/'));
        if (isMounted) {
          setRawPreviewCache((prev) => ({ ...prev, [currentPath]: fallback }));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, currentPath, thumbnails]);

  // Pre-load lookahead ring buffer (previous 1, next 2 images) with request deduplication
  useEffect(() => {
    if (!isOpen || paths.length === 0) return;
    const preloadIndices = [
      currentIndex + 1,
      currentIndex + 2,
      currentIndex - 1,
    ].filter((i) => i >= 0 && i < paths.length);

    preloadIndices.forEach((i) => {
      const p = paths[i];
      if (p && !thumbnails[p] && !requestedPathsRef.current.has(p)) {
        requestedPathsRef.current.add(p);
        invoke<string>(Invokes.ExtractEmbeddedRawPreview, { path: p })
          .then((dataUrl) => {
            if (dataUrl) {
              setRawPreviewCache((prev) => ({ ...prev, [p]: dataUrl }));
            }
          })
          .catch(() => {});
      }
    });
  }, [isOpen, currentIndex, paths, thumbnails]);

  // Background face analysis for active frame with 120ms debounce
  useEffect(() => {
    if (!isOpen || !currentPath) {
      setAnalysis(null);
      return;
    }

    let isMounted = true;
    const timer = setTimeout(() => {
      setIsAnalyzing(true);
      invoke<CullingFrameAnalysis>('analyze_culling_frame', { path: currentPath })
        .then((res) => {
          if (isMounted) {
            setAnalysis(res);
            setIsAnalyzing(false);
          }
        })
        .catch((err) => {
          if (isMounted) {
            console.warn('Frame analysis failed:', err);
            setIsAnalyzing(false);
          }
        });
    }, 120);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [isOpen, currentPath]);

  const handleNext = useCallback(() => {
    setCurrentIndex((prev: number) => (prev < paths.length - 1 ? prev + 1 : prev));
  }, [paths.length]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((prev: number) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const handleRate = useCallback(
    (rating: number) => {
      if (!currentPath) return;
      setLibrary((s) => ({
        imageRatings: { ...s.imageRatings, [currentPath]: rating },
        imageList: s.imageList.map((img) => (img.path === currentPath ? { ...img, rating } : img)),
      }));
      invoke(Invokes.SetRatingForPaths, { paths: [currentPath], rating }).catch(console.error);

      if (autoAdvance) {
        handleNext();
      }
    },
    [currentPath, setLibrary, autoAdvance, handleNext]
  );

  const handleColorLabel = useCallback(
    (color: string | null) => {
      if (!currentPath) return;
      invoke(Invokes.SetColorLabelForPaths, { paths: [currentPath], color: color || null }).catch(console.error);
      if (autoAdvance) {
        handleNext();
      }
    },
    [currentPath, autoAdvance, handleNext]
  );

  const handlePick = useCallback(() => {
    handleRate(5);
    handleColorLabel('green');
  }, [handleRate, handleColorLabel]);

  const handleReject = useCallback(() => {
    handleRate(1);
    handleColorLabel('red');
  }, [handleRate, handleColorLabel]);

  const handleGroupBursts = useCallback(async () => {
    if (paths.length === 0) return;
    setIsBurstGrouping(true);
    try {
      const groups = await invoke<BurstGroup[]>('group_burst_photos', {
        paths,
        timeWindowSecs: 2.0,
        maxHammingDist: 12,
      });
      setBurstGroups(groups);
      if (groups.length > 0) {
        setTriageReport(
          `Grouped ${groups.length} burst series (${groups.reduce((acc, g) => acc + g.frame_count, 0)} frames total)`
        );
      } else {
        setTriageReport('No multi-frame burst clusters detected');
      }
    } catch (err) {
      console.error('Burst grouping failed:', err);
    } finally {
      setIsBurstGrouping(false);
    }
  }, [paths]);

  // Keyboard navigation & blitz rating
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          handleNext();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          handlePrev();
          break;
        case '1':
          e.preventDefault();
          handleRate(1);
          break;
        case '2':
          e.preventDefault();
          handleRate(2);
          break;
        case '3':
          e.preventDefault();
          handleRate(3);
          break;
        case '4':
          e.preventDefault();
          handleRate(4);
          break;
        case '5':
          e.preventDefault();
          handleRate(5);
          break;
        case '0':
        case 'u':
        case 'U':
          e.preventDefault();
          handleRate(0);
          handleColorLabel(null);
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          handlePick();
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          handleReject();
          break;
        case '6':
          e.preventDefault();
          handleColorLabel('red');
          break;
        case '7':
          e.preventDefault();
          handleColorLabel('yellow');
          break;
        case '8':
          e.preventDefault();
          handleColorLabel('green');
          break;
        case '9':
          e.preventDefault();
          handleColorLabel('blue');
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          setFocusPeaking((prev) => !prev);
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          setCompareMode((prev) => !prev);
          break;
        case 'b':
        case 'B':
          e.preventDefault();
          handleGroupBursts();
          break;
        case ' ':
          e.preventDefault();
          setIs100Zoom((z) => !z);
          break;
        case 'Escape':
          e.preventDefault();
          setUI({ speedCullerModalState: { isOpen: false, selectedPaths: [], initialIndex: 0 } });
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleNext, handlePrev, handleRate, handleColorLabel, handlePick, handleReject, setUI, handleGroupBursts]);

  const handleRunAiTriage = async () => {
    if (paths.length === 0) return;
    setIsTriaging(true);
    try {
      const res = await invoke<{
        total_scanned: number;
        rejected_blurry_count: number;
        rejected_blink_count: number;
        recommended_picks_count: number;
      }>('batch_auto_triage_cull', {
        paths,
        blurThreshold: 14.0,
        rejectBlinks: true,
      });

      setTriageReport(
        `Triaged ${res.total_scanned} photos: ${res.rejected_blurry_count} blurry rejected, ${res.rejected_blink_count} blinks rejected, ${res.recommended_picks_count} picks recommended.`
      );
    } catch (err) {
      console.error('Triage cull failed:', err);
    } finally {
      setIsTriaging(false);
    }
  };

  if (!isOpen) return null;

  const activeRating = (currentPath && imageRatings[currentPath]) || currentImageObj?.rating || 0;
  const fileName = currentPath.split(/[\\/]/).pop() || '';
  const currentImgUrl =
    rawPreviewCache[currentPath] ||
    thumbnails[currentPath] ||
    (currentPath ? convertFileSrc(currentPath.replace(/\\/g, '/')) : '');

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none overflow-hidden font-sans w-screen h-screen max-w-full max-h-full">
      {/* Top Header Bar */}
      <div className="h-12 shrink-0 bg-neutral-900/95 backdrop-blur-md border-b border-neutral-800 flex items-center justify-between px-3 md:px-4 z-20 gap-2 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase tracking-wider">
            <Zap size={13} className="fill-amber-400 text-amber-400" />
            <span className="hidden sm:inline">Speed Culler</span>
          </div>

          <div className="text-neutral-300 text-xs font-medium shrink-0">
            <span className="font-bold text-white">{currentIndex + 1}</span> / {paths.length}
          </div>

          <div className="text-neutral-400 text-xs truncate max-w-[120px] sm:max-w-[200px] md:max-w-[280px] font-mono">
            {fileName}
          </div>
        </div>

        {/* Center Quick Stats */}
        <div className="flex items-center gap-2 shrink-0 text-xs">
          {analysis && (
            <div className="flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-neutral-800/80 border border-neutral-700">
              <span className="flex items-center gap-1 text-neutral-300 text-[11px]">
                <span className="hidden md:inline">Sharpness:</span>
                <strong
                  className={
                    analysis.sharpness_score > 20
                      ? 'text-emerald-400'
                      : analysis.sharpness_score > 12
                      ? 'text-amber-400'
                      : 'text-rose-400'
                  }
                >
                  {Math.round(analysis.sharpness_score)}%
                </strong>
              </span>

              <span className="text-neutral-600 hidden sm:inline">•</span>

              <span className="hidden sm:flex items-center gap-1 text-neutral-300 text-[11px]">
                <span className="hidden md:inline">Exposure:</span>
                <strong className="text-sky-400">{Math.round(analysis.exposure_score)}%</strong>
              </span>

              {analysis.is_blurry && (
                <span className="px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold">
                  BLURRY
                </span>
              )}

              {isHeroPick && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-bold border border-amber-500/40 flex items-center gap-1 animate-pulse">
                  🌟 Hero Pick
                </span>
              )}

              {currentBurstGroup && (
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-orange-500/20 border border-orange-500/40 text-orange-300 text-[10px] font-bold">
                  <span>🔥 Burst ({currentBurstGroup.member_paths.indexOf(currentPath) + 1}/{currentBurstGroup.frame_count})</span>
                  {currentBurstGroup.hero_path !== currentPath && (
                    <button
                      type="button"
                      onClick={() => {
                        const hIdx = paths.indexOf(currentBurstGroup.hero_path);
                        if (hIdx !== -1) setCurrentIndex(hIdx);
                      }}
                      className="px-1.5 py-0.2 rounded bg-amber-500/30 hover:bg-amber-500/50 text-amber-200 text-[9px] font-semibold transition-colors cursor-pointer"
                      title="Jump directly to the sharpest Hero frame in this burst"
                    >
                      ⭐ Hero
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {triageReport && (
            <span className="text-emerald-400 text-xs animate-fade-in font-medium truncate max-w-[180px]">{triageReport}</span>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={handleGroupBursts}
            disabled={isBurstGrouping}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
              burstGroups.length > 0
                ? 'bg-orange-500/20 border-orange-500 text-orange-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Auto-group rapid bursts and identify sharpest Hero frame (B)"
          >
            {isBurstGrouping ? <Loader2 size={12} className="animate-spin text-orange-400" /> : <Zap size={12} className="text-orange-400" />}
            <span className="hidden sm:inline">{burstGroups.length > 0 ? `${burstGroups.length} Bursts` : 'Bursts'}</span>
            <span className="font-mono text-[10px] opacity-75">(B)</span>
          </button>

          <button
            type="button"
            onClick={() => setFocusPeaking(!focusPeaking)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
              focusPeaking
                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Toggle Focus Peaking overlay (F)"
          >
            <Sparkles size={12} className={focusPeaking ? 'text-emerald-400' : ''} />
            <span className="hidden sm:inline">Peaking</span> <span className="font-mono text-[10px] opacity-75">(F)</span>
          </button>

          <button
            type="button"
            onClick={() => setCompareMode(!compareMode)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
              compareMode
                ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Toggle 2-Up Side-by-Side Burst Comparison View (C)"
          >
            <span className="hidden sm:inline">2-Up</span> <span className="font-mono text-[10px] opacity-75">(C)</span>
          </button>

          <button
            type="button"
            onClick={() => setAutoAdvance(!autoAdvance)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
              autoAdvance
                ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Auto-advance immediately upon pressing rating (1-5, P, X)"
          >
            <Zap size={11} className={autoAdvance ? 'fill-amber-400' : ''} />
            <span className="hidden sm:inline">Auto-Advance</span>
          </button>

          <button
            type="button"
            onClick={handleRunAiTriage}
            disabled={isTriaging}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 text-xs font-medium transition-colors cursor-pointer"
            title="Automatically scan shoot and mark severe blinks and blurry misses as rejected"
          >
            {isTriaging ? <Loader2 size={12} className="animate-spin text-amber-400" /> : <Sparkles size={12} className="text-amber-400" />}
            <span className="hidden md:inline">AI Auto-Triage</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setUI({ speedCullerModalState: { isOpen: false, selectedPaths: [], initialIndex: 0 } })
            }
            className="p-1 rounded-full hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors cursor-pointer shrink-0"
            title="Close Speed Culler (Esc)"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Main Viewport */}
      <div className="flex-1 relative flex items-center justify-center bg-neutral-950 overflow-hidden min-h-0">
        {compareMode ? (
          <div className="w-full h-full flex divide-x divide-neutral-800">
            <div className="flex-1 relative flex items-center justify-center bg-neutral-950 p-2 overflow-hidden">
              <span className="absolute top-3 left-3 px-2 py-0.5 rounded bg-black/70 text-amber-400 text-xs font-mono z-10">
                Primary (A): #{currentIndex + 1}
              </span>
              {currentImgUrl && (
                <img
                  src={currentImgUrl}
                  alt="Primary"
                  className={`max-h-full max-w-full object-contain transition-transform ${
                    is100Zoom ? 'scale-250 cursor-zoom-out' : 'cursor-zoom-in'
                  } ${focusPeaking ? 'filter contrast-150 drop-shadow-[0_0_2px_#00ff66]' : ''}`}
                  onClick={() => setIs100Zoom(!is100Zoom)}
                />
              )}
            </div>
            <div className="flex-1 relative flex items-center justify-center bg-neutral-950 p-2 overflow-hidden">
              <span className="absolute top-3 left-3 px-2 py-0.5 rounded bg-black/70 text-sky-400 text-xs font-mono z-10">
                Compare (B): #{currentIndex + 2}
              </span>
              {nextComparePath && (
                <img
                  src={rawPreviewCache[nextComparePath] || thumbnails[nextComparePath] || convertFileSrc(nextComparePath.replace(/\\/g, '/'))}
                  alt="Compare"
                  className={`max-h-full max-w-full object-contain transition-transform ${
                    is100Zoom ? 'scale-250 cursor-zoom-out' : 'cursor-zoom-in'
                  } ${focusPeaking ? 'filter contrast-150 drop-shadow-[0_0_2px_#00ff66]' : ''}`}
                  onClick={() => setIs100Zoom(!is100Zoom)}
                />
              )}
            </div>
          </div>
        ) : currentImgUrl ? (
          <img
            src={currentImgUrl}
            alt={fileName}
            className={`max-h-full max-w-full object-contain transition-transform duration-150 ${
              is100Zoom ? 'scale-250 cursor-zoom-out' : 'cursor-zoom-in'
            } ${focusPeaking ? 'filter contrast-150 drop-shadow-[0_0_2px_#00ff66]' : ''}`}
            onClick={() => setIs100Zoom(!is100Zoom)}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-neutral-500">
            <Loader2 size={28} className="animate-spin text-amber-400" />
            <span className="text-xs">Extracting RAW preview...</span>
          </div>
        )}

        {focusPeaking && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-emerald-500/20 border border-emerald-500/60 backdrop-blur-md px-3 py-1 rounded-full text-emerald-300 font-mono text-xs z-20 flex items-center gap-1.5 shadow-lg pointer-events-none">
            <Sparkles size={12} className="text-emerald-400 animate-pulse" />
            <span>FastRaw Focus Peaking Active (Press F to toggle)</span>
          </div>
        )}

        {/* Previous / Next Arrow Floaters */}
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentIndex === 0}
          className="absolute left-3 md:left-4 top-1/2 -translate-y-1/2 p-2.5 md:p-3 rounded-full bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-700/50 text-white backdrop-blur-md transition-all disabled:opacity-20 disabled:pointer-events-none cursor-pointer z-10"
        >
          <ChevronLeft size={22} />
        </button>

        <button
          type="button"
          onClick={handleNext}
          disabled={currentIndex === paths.length - 1}
          className="absolute right-3 md:right-4 top-1/2 -translate-y-1/2 p-2.5 md:p-3 rounded-full bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-700/50 text-white backdrop-blur-md transition-all disabled:opacity-20 disabled:pointer-events-none cursor-pointer z-10"
        >
          <ChevronRight size={22} />
        </button>

        {/* Floating Multi-Face & Eye Loupe Strip */}
        <AnimatePresence>
          {analysis && analysis.faces && analysis.faces.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-16 left-1/2 -translate-x-1/2 max-w-[92vw] overflow-x-auto bg-neutral-900/90 backdrop-blur-md border border-neutral-700/80 rounded-2xl p-2 shadow-2xl flex items-center gap-2.5 z-30"
            >
              <div className="text-[9px] uppercase font-bold text-neutral-400 tracking-wider px-1 shrink-0">
                AI Eye Loupe
              </div>

              {analysis.faces.map((face, fIdx) => (
                <div
                  key={fIdx}
                  className="flex flex-col items-center gap-1 group relative cursor-pointer shrink-0"
                  onClick={() => setIs100Zoom(true)}
                >
                  <div
                    className={`w-14 h-14 rounded-xl overflow-hidden border-2 relative shadow-md transition-all group-hover:scale-105 ${
                      face.is_sharp && face.is_eyes_open
                        ? 'border-emerald-500 shadow-emerald-500/20'
                        : !face.is_eyes_open
                        ? 'border-rose-500 shadow-rose-500/20'
                        : 'border-amber-500 shadow-amber-500/20'
                    }`}
                  >
                    <img
                      src={face.crop_data_url}
                      alt={`Face ${fIdx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-0 inset-x-0 bg-black/60 backdrop-blur-xs py-0.5 text-center text-[9px] font-mono text-white">
                      {Math.round(face.sharpness_score)}%
                    </div>
                  </div>

                  <span
                    className={`text-[9px] font-bold uppercase tracking-tight ${
                      face.is_sharp && face.is_eyes_open
                        ? 'text-emerald-400'
                        : !face.is_eyes_open
                        ? 'text-rose-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {!face.is_eyes_open ? 'Blink' : face.is_sharp ? 'Sharp' : 'Soft'}
                  </span>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Rating & Filmstrip Dock */}
      <div className="h-14 shrink-0 bg-neutral-900 border-t border-neutral-800 flex items-center justify-between px-3 md:px-6 z-20 gap-2">
        {/* Rating Blitz Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <div className="flex items-center bg-neutral-800/80 rounded-lg p-0.5 border border-neutral-700">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => handleRate(star)}
                className={`p-1 rounded transition-colors cursor-pointer ${
                  activeRating >= star ? 'text-amber-400' : 'text-neutral-500 hover:text-neutral-300'
                }`}
                title={`Set ${star} Stars (${star})`}
              >
                <Star size={15} className={activeRating >= star ? 'fill-amber-400' : ''} />
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-neutral-800 mx-0.5" />

          {/* Quick Pick (P) & Reject (X) */}
          <button
            type="button"
            onClick={handlePick}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-emerald-400 hover:border-emerald-500/50 shrink-0"
            title="Mark as Pick / Winner (P)"
          >
            <Check size={13} className="text-emerald-400" />
            <span className="hidden sm:inline">Pick</span> <span>(P)</span>
          </button>

          <button
            type="button"
            onClick={handleReject}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-rose-400 hover:border-rose-500/50 shrink-0"
            title="Mark as Rejected / Blurry (X)"
          >
            <X size={13} className="text-rose-400" />
            <span className="hidden sm:inline">Reject</span> <span>(X)</span>
          </button>
        </div>

        {/* Mini Filmstrip */}
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-[200px] sm:max-w-[340px] md:max-w-[500px] py-1 no-scrollbar">
          {paths.slice(Math.max(0, currentIndex - 4), Math.min(paths.length, currentIndex + 5)).map((p: string, idx: number) => {
            const actualIdx = Math.max(0, currentIndex - 4) + idx;
            const thumbUrl = rawPreviewCache[p] || thumbnails[p] || (p ? convertFileSrc(p.replace(/\\/g, '/')) : '');
            const isSelected = actualIdx === currentIndex;
            const burstMeta = burstGroups.find((g) => g.member_paths.includes(p));
            const isHeroOfBurst = burstMeta?.hero_path === p;
            const starRating = (p && imageRatings[p]) || 0;

            return (
              <div
                key={p}
                onClick={() => setCurrentIndex(actualIdx)}
                className={`h-9 w-9 sm:h-10 sm:w-10 rounded-md overflow-hidden relative cursor-pointer border-2 transition-all shrink-0 ${
                  isSelected ? 'border-amber-400 scale-105 shadow-md' : 'border-neutral-700 opacity-60 hover:opacity-100'
                }`}
              >
                {thumbUrl ? (
                  <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-neutral-800" />
                )}
                {burstMeta && (
                  <div className="absolute top-0 left-0 px-0.5 bg-black/75 rounded-br text-[7px] font-bold text-orange-400">
                    🔥{isHeroOfBurst ? '⭐' : ''}
                  </div>
                )}
                {starRating > 0 && (
                  <div className="absolute bottom-0 right-0 px-1 bg-black/70 text-[8px] font-bold text-amber-400">
                    ★{starRating}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Keyboard Cheat Sheet */}
        <div className="hidden xl:flex items-center gap-2 text-[10px] text-neutral-400 font-mono shrink-0">
          <span><kbd className="bg-neutral-800 px-1 py-0.5 rounded border border-neutral-700 text-white">1-5</kbd> Rate</span>
          <span><kbd className="bg-neutral-800 px-1 py-0.5 rounded border border-neutral-700 text-white">P</kbd> Pick</span>
          <span><kbd className="bg-neutral-800 px-1 py-0.5 rounded border border-neutral-700 text-white">X</kbd> Reject</span>
          <span><kbd className="bg-neutral-800 px-1 py-0.5 rounded border border-neutral-700 text-white">Space</kbd> Zoom</span>
        </div>
      </div>
    </div>
  );
}
