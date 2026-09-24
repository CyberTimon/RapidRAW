import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, AlertTriangle, CheckCircle2, Sparkles, X, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

export interface ExposureBracketGroup {
  positionIndex: number;
  paths: string[];
}

export interface HdrPanoGroupingReport {
  totalFiles: number;
  panels: ExposureBracketGroup[];
  excludedOutliers: string[];
  isConsistentBracketSize: boolean;
  detectedBracketSize: number;
}

interface HdrPanoPreflightModalProps {
  isOpen: boolean;
  paths: string[];
  onClose: () => void;
  onProceed: (projection: 'cylindrical' | 'spherical' | 'planar' | 'panini' | 'stereographic', boundaryWarp: number) => void;
}

export const HdrPanoPreflightModal: React.FC<HdrPanoPreflightModalProps> = ({
  isOpen,
  paths,
  onClose,
  onProceed,
}) => {
  const { t } = useTranslation();
  const [report, setReport] = useState<HdrPanoGroupingReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [projection, setProjection] = useState<'cylindrical' | 'spherical' | 'planar' | 'panini' | 'stereographic'>('cylindrical');
  const [boundaryWarp, setBoundaryWarp] = useState<number>(0.5);

  useEffect(() => {
    if (!isOpen || paths.length === 0) {
      setReport(null);
      return;
    }

    setIsLoading(true);
    invoke<HdrPanoGroupingReport>('inspect_hdr_pano_grouping', { paths })
      .then((data) => {
        setReport(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to inspect HDR pano grouping:', err);
        setIsLoading(false);
      });
  }, [isOpen, paths]);

  if (!isOpen) return null;

  const formatFilename = (p: string) => {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Sparkles size={18} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-neutral-100 flex items-center gap-2">
                  HDR Panorama Pre-Flight Verification
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    Quality Shield Active
                  </span>
                </h3>
                <p className="text-xs text-neutral-400">
                  Verify detected exposure brackets and panoramic angle positions before rendering.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-neutral-400 gap-3">
                <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs font-mono">Analyzing physical exposure scales and timestamps...</span>
              </div>
            ) : report ? (
              <>
                {/* Summary Banner */}
                <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl bg-neutral-950 border border-neutral-800">
                  <div className="flex flex-col">
                    <span className="text-[10.5px] uppercase font-bold text-neutral-400">Total Selected</span>
                    <span className="text-lg font-bold text-neutral-100">{report.totalFiles} files</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10.5px] uppercase font-bold text-neutral-400">Pano Angles (Panels)</span>
                    <span className="text-lg font-bold text-amber-400">{report.panels.length} angles</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10.5px] uppercase font-bold text-neutral-400">Bracket Configuration</span>
                    <span className="text-lg font-bold text-emerald-400">
                      {report.isConsistentBracketSize
                        ? `${report.detectedBracketSize} exp / angle`
                        : 'Mixed Brackets'}
                    </span>
                  </div>
                </div>

                {/* Outliers Alert */}
                {report.excludedOutliers && report.excludedOutliers.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/30 flex items-start gap-3">
                    <AlertTriangle className="text-amber-400 shrink-0 mt-0.5" size={16} />
                    <div className="text-xs">
                      <span className="font-bold text-amber-300 block mb-0.5">
                        {report.excludedOutliers.length} Outlier Frame(s) Isolated & Excluded
                      </span>
                      <p className="text-neutral-300 text-[11.5px] leading-relaxed">
                        To preserve geometric alignment and prevent stitch corruption, disconnected shots separated
                        by &gt;60 seconds have been excluded:
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {report.excludedOutliers.map((outlier, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 text-[11px] font-mono rounded bg-amber-950/60 border border-amber-500/40 text-amber-200"
                          >
                            {formatFilename(outlier)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Bracket Positions Grid */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-neutral-300">
                      Angle Panels ({report.panels.length})
                    </span>
                    <span className="text-[11px] text-neutral-400">
                      Fuses to 32-bit linear radiance before 2D Graph-Cut stitch
                    </span>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {report.panels.map((panel, pIdx) => (
                      <div
                        key={pIdx}
                        className="flex items-center justify-between p-2 rounded-lg bg-neutral-950/70 border border-neutral-800 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-md bg-neutral-800 flex items-center justify-center font-mono font-bold text-neutral-300 text-[11px]">
                            {pIdx + 1}
                          </span>
                          <span className="font-semibold text-neutral-200">
                            Angle {pIdx + 1}
                          </span>
                          <span className="text-neutral-400 text-[11px]">
                            ({panel.paths.length} brackets)
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {panel.paths.map((pth, bIdx) => (
                            <span
                              key={bIdx}
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-neutral-900 border border-neutral-700 text-neutral-300"
                            >
                              {formatFilename(pth)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Projection & Warp */}
                <div className="grid grid-cols-2 gap-4 pt-2 border-t border-neutral-800">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-neutral-300 block">3D Projection</label>
                    <select
                      value={projection}
                      onChange={(e) => setProjection(e.target.value as any)}
                      className="w-full bg-neutral-950 border border-neutral-800 text-neutral-200 text-xs rounded-lg px-2.5 py-2 cursor-pointer outline-none focus:border-amber-500"
                    >
                      <option value="cylindrical">Cylindrical (Landscape Standard)</option>
                      <option value="panini">Panini (Architectural Lines)</option>
                      <option value="spherical">Spherical (360° Sphere)</option>
                      <option value="stereographic">Stereographic (Little Planet)</option>
                      <option value="planar">Planar (Perspective)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="font-bold text-neutral-300">Boundary Warp</span>
                      <span className="font-mono text-amber-400">{(boundaryWarp * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={boundaryWarp}
                      onChange={(e) => setBoundaryWarp(parseFloat(e.target.value))}
                      className="w-full accent-amber-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer mt-2"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="py-8 text-center text-xs text-neutral-400">
                Could not analyze image brackets. Please check source paths.
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-800 bg-neutral-950/60">
            <Button variant="secondary" onClick={onClose} size="sm">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onProceed(projection, boundaryWarp);
                onClose();
              }}
              disabled={isLoading || !report || report.panels.length < 2}
              className="bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold flex items-center gap-1.5"
              size="sm"
            >
              <span>Merge &amp; Stitch HDR Panorama</span>
              <ChevronRight size={15} />
            </Button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default HdrPanoPreflightModal;
