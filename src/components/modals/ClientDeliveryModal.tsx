import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Package, Check, Folder, Sparkles, X, Loader2, Smartphone, Film, Image as ImageIcon, Globe, Shield, FileText, Grid } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface ClientDeliveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPaths: string[];
}

interface DeliverySummary {
  total_photos: number;
  files_generated: number;
  output_directory: string;
  elapsed_ms: number;
}

export const ClientDeliveryModal: React.FC<ClientDeliveryModalProps> = ({
  isOpen,
  onClose,
  selectedPaths,
}) => {
  const [activeTab, setActiveTab] = useState<'delivery_pack' | 'contact_sheet'>('delivery_pack');
  const [outputDir, setOutputDir] = useState<string>('D:\\RapidRAW_Client_Delivery');
  const [watermarkText, setWatermarkText] = useState<string>('© CYBERTIMON PHOTOGRAPHY - PROOF');

  const [exportMasterPrint, setExportMasterPrint] = useState<boolean>(true);
  const [exportInstagram, setExportInstagram] = useState<boolean>(true);
  const [exportStories, setExportStories] = useState<boolean>(true);
  const [exportProofs, setExportProofs] = useState<boolean>(true);
  const [exportWebp, setExportWebp] = useState<boolean>(true);

  // Proof Contact Sheet State
  const [sheetColumns, setSheetColumns] = useState<number>(4);
  const [sheetCellWidth, setSheetCellWidth] = useState<number>(480);
  const [sheetIncludeExif, setSheetIncludeExif] = useState<boolean>(true);
  const [sheetIncludeCheckboxes, setSheetIncludeCheckboxes] = useState<boolean>(true);
  const [sheetDarkTheme, setSheetDarkTheme] = useState<boolean>(true);
  const [sheetTitle, setSheetTitle] = useState<string>('CLIENT PROOF SHEET');
  const [sheetOutputPath, setSheetOutputPath] = useState<string>('D:\\RapidRAW_Client_Delivery\\Contact_Proof_Sheet.jpg');
  const [isGeneratingSheet, setIsGeneratingSheet] = useState<boolean>(false);
  const [sheetResultMsg, setSheetResultMsg] = useState<string | null>(null);

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ current: number; total: number; percentage: number } | null>(null);
  const [result, setResult] = useState<DeliverySummary | null>(null);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    if (isOpen) {
      setResult(null);
      setProgress(null);
      setIsExporting(false);

      listen<{ current: number; total: number; percentage: number }>('delivery-pack-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => (unlistenProgress = un));

      listen<DeliverySummary>('delivery-pack-complete', (event) => {
        setResult(event.payload);
        setIsExporting(false);
      }).then((un) => (unlistenComplete = un));
    }

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
    };
  }, [isOpen]);

  const handleStartExport = async () => {
    if (selectedPaths.length === 0) return;
    setIsExporting(true);
    setResult(null);

    try {
      await invoke('export_client_delivery_pack', {
        config: {
          paths: selectedPaths,
          output_dir: outputDir,
          export_master_print: exportMasterPrint,
          export_instagram_4x5: exportInstagram,
          export_stories_9x16: exportStories,
          export_watermarked_proofs: exportProofs,
          export_webp_gallery: exportWebp,
          watermark_text: watermarkText,
        },
      });
    } catch (err) {
      console.error('Delivery export failed:', err);
      setIsExporting(false);
    }
  };

  const handleGenerateContactSheet = async () => {
    if (selectedPaths.length === 0) return;
    setIsGeneratingSheet(true);
    setSheetResultMsg(null);

    try {
      const res = await invoke<string>('generate_contact_sheet', {
        config: {
          paths: selectedPaths,
          output_path: sheetOutputPath,
          columns: sheetColumns,
          cell_width: sheetCellWidth,
          include_exif: sheetIncludeExif,
          include_checkboxes: sheetIncludeCheckboxes,
          custom_title: sheetTitle,
          dark_theme: sheetDarkTheme,
          picked_paths: [],
        },
      });
      setSheetResultMsg(res);
    } catch (err) {
      console.error('Failed to generate contact sheet:', err);
    } finally {
      setIsGeneratingSheet(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative w-full max-w-[580px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header with Segmented Tab Switcher */}
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-border-color gap-2">
            <div className="flex items-center gap-1.5 p-0.5 bg-bg-secondary rounded-lg border border-border-color">
              <button
                type="button"
                onClick={() => setActiveTab('delivery_pack')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  activeTab === 'delivery_pack'
                    ? 'bg-surface text-emerald-400 shadow-xs border border-border-color'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Package size={14} />
                <span>Delivery Pack</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('contact_sheet')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  activeTab === 'contact_sheet'
                    ? 'bg-surface text-emerald-400 shadow-xs border border-border-color'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <FileText size={14} />
                <span>Proof Contact Sheet</span>
              </button>
            </div>

            {!isExporting && !isGeneratingSheet && (
              <button
                onClick={onClose}
                className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md cursor-pointer"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col gap-5 text-text-primary overflow-y-auto">
            {activeTab === 'delivery_pack' ? (
              <>
                {/* Description */}
                <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
                  <div className="p-2 rounded-md bg-emerald-500/10 text-emerald-400 mt-0.5 shrink-0">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                      1-Click Multi-Format Client Packages
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed">
                      Renders <b>{selectedPaths.length}</b> photos into dedicated subfolders for Print, Social Media (4:5 / 9:16), Watermarked Proofs, and WebP.
                    </Text>
                  </div>
                </div>

                {!result ? (
                  <div className="flex flex-col gap-3">
                    {/* Format Channels List */}
                    <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                      {/* Master Print */}
                      <div className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2.5">
                          <ImageIcon size={16} className="text-blue-400" />
                          <div>
                            <Text variant={TextVariants.small} weight={TextWeights.medium}>
                              Master Print (Full Resolution JPEG)
                            </Text>
                            <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                              100% Quality print-ready files in sRGB
                            </Text>
                          </div>
                        </div>
                        <Switch label="" checked={exportMasterPrint} onChange={setExportMasterPrint} />
                      </div>

                      {/* Instagram 4:5 */}
                      <div className="flex items-center justify-between py-1 border-t border-border-color/50">
                        <div className="flex items-center gap-2.5">
                          <Smartphone size={16} className="text-pink-400" />
                          <div>
                            <Text variant={TextVariants.small} weight={TextWeights.medium}>
                              Instagram 4:5 Crop (1080 × 1350)
                            </Text>
                            <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                              Subject-centered crop optimized for feed posts
                            </Text>
                          </div>
                        </div>
                        <Switch label="" checked={exportInstagram} onChange={setExportInstagram} />
                      </div>

                      {/* Stories 9:16 */}
                      <div className="flex items-center justify-between py-1 border-t border-border-color/50">
                        <div className="flex items-center gap-2.5">
                          <Film size={16} className="text-purple-400" />
                          <div>
                            <Text variant={TextVariants.small} weight={TextWeights.medium}>
                              Stories & Reels 9:16 (1080 × 1920)
                            </Text>
                            <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                              Vertical framing for mobile viewing
                            </Text>
                          </div>
                        </div>
                        <Switch label="" checked={exportStories} onChange={setExportStories} />
                      </div>

                      {/* Watermarked Proofs */}
                      <div className="flex items-center justify-between py-1 border-t border-border-color/50">
                        <div className="flex items-center gap-2.5">
                          <Shield size={16} className="text-amber-400" />
                          <div>
                            <Text variant={TextVariants.small} weight={TextWeights.medium}>
                              Watermarked Web Proofs (2048px)
                            </Text>
                            <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                              Client review previews with copyright watermark
                            </Text>
                          </div>
                        </div>
                        <Switch label="" checked={exportProofs} onChange={setExportProofs} />
                      </div>

                      {/* WebP Gallery */}
                      <div className="flex items-center justify-between py-1 border-t border-border-color/50">
                        <div className="flex items-center gap-2.5">
                          <Globe size={16} className="text-emerald-400" />
                          <div>
                            <Text variant={TextVariants.small} weight={TextWeights.medium}>
                              Optimized WebP Gallery (85%)
                            </Text>
                            <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                              Ultra-compact 2560px images for fast web portfolios
                            </Text>
                          </div>
                        </div>
                        <Switch label="" checked={exportWebp} onChange={setExportWebp} />
                      </div>
                    </div>

                    {/* Watermark Text Input */}
                    {exportProofs && (
                      <div className="flex flex-col gap-1">
                        <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                          Proof Watermark Text:
                        </Text>
                        <input
                          type="text"
                          value={watermarkText}
                          onChange={(e) => setWatermarkText(e.target.value)}
                          className="bg-bg-secondary text-text-primary px-3 py-1.5 rounded-md border border-border-color text-xs font-mono focus:border-accent outline-hidden"
                        />
                      </div>
                    )}

                    {/* Output Directory */}
                    <div className="flex flex-col gap-1">
                      <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                        Export Destination:
                      </Text>
                      <div className="flex items-center gap-2 bg-bg-secondary px-3 py-1.5 rounded-md border border-border-color text-xs font-mono text-text-secondary">
                        <Folder size={14} className="text-accent shrink-0" />
                        <span className="truncate">{outputDir}</span>
                      </div>
                    </div>

                    {/* Progress bar */}
                    {isExporting && progress && (
                      <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-text-secondary">Rendering delivery packages...</span>
                          <span className="font-mono text-accent font-medium">
                            {progress.current} / {progress.total} ({Math.round(progress.percentage)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-surface rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-400 transition-all duration-150"
                            style={{ width: `${progress.percentage}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                    <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                      <Check size={18} />
                      <span>Client Delivery Pack Complete!</span>
                    </div>
                    <div className="flex flex-col gap-1 text-xs text-text-secondary">
                      <span>Generated <b>{result.files_generated}</b> files across selected channels.</span>
                      <span className="font-mono truncate">Saved in: {result.output_directory}</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Contact Proof Sheet Tab View */
              <div className="flex flex-col gap-4">
                <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
                  <div className="p-2 rounded-md bg-emerald-500/10 text-emerald-400 mt-0.5 shrink-0">
                    <Grid size={20} />
                  </div>
                  <div>
                    <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                      Print-Ready Client Proof Contact Sheet
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed">
                      Renders <b>{selectedPaths.length}</b> photos into a structured multi-column vector grid preserving original uncropped aspect ratios, antialiased EXIF metadata badges, and review checkboxes.
                    </Text>
                  </div>
                </div>

                <div className="flex flex-col gap-3 p-3 bg-bg-secondary rounded-lg border border-border-color">
                  {/* Columns Count */}
                  <div className="flex items-center justify-between">
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        Grid Columns: <strong className="text-emerald-400 font-mono">{sheetColumns} Columns</strong>
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        2 to 8 columns with automatic aspect ratio preservation
                      </Text>
                    </div>
                    <div className="flex items-center gap-1">
                      {[2, 3, 4, 5, 6].map((col) => (
                        <button
                          key={col}
                          type="button"
                          onClick={() => setSheetColumns(col)}
                          className={`w-7 h-7 rounded text-xs font-bold transition-colors cursor-pointer ${
                            sheetColumns === col
                              ? 'bg-emerald-500 text-black'
                              : 'bg-surface text-neutral-400 hover:text-white border border-border-color'
                          }`}
                        >
                          {col}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Cell Resolution */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-color/50">
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        Cell Resolution
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        Individual cell pixel width for thumbnail sharpness
                      </Text>
                    </div>
                    <div className="flex items-center gap-1">
                      {[
                        { label: '360px', val: 360 },
                        { label: '480px', val: 480 },
                        { label: '720px', val: 720 },
                      ].map((res) => (
                        <button
                          key={res.val}
                          type="button"
                          onClick={() => setSheetCellWidth(res.val)}
                          className={`px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                            sheetCellWidth === res.val
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50'
                              : 'bg-surface text-neutral-400 hover:text-white border border-border-color'
                          }`}
                        >
                          {res.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* EXIF Metadata Badge Toggle */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-color/50">
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        EXIF Metadata Badges
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        Renders ISO, Aperture, Shutter Speed, and Date below each frame
                      </Text>
                    </div>
                    <Switch label="" checked={sheetIncludeExif} onChange={setSheetIncludeExif} />
                  </div>

                  {/* Review Checkboxes Toggle */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-color/50">
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        Client Review Checkboxes
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        Renders selection badges in corner of each frame for client signoff
                      </Text>
                    </div>
                    <Switch label="" checked={sheetIncludeCheckboxes} onChange={setSheetIncludeCheckboxes} />
                  </div>

                  {/* Dark Theme vs Light Gallery */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-color/50">
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        Dark Gallery Theme
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        Deep neutral slate background (turn off for white paper print)
                      </Text>
                    </div>
                    <Switch label="" checked={sheetDarkTheme} onChange={setSheetDarkTheme} />
                  </div>
                </div>

                {/* Sheet Title */}
                <div className="flex flex-col gap-1">
                  <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                    Contact Sheet Header Title:
                  </Text>
                  <input
                    type="text"
                    value={sheetTitle}
                    onChange={(e) => setSheetTitle(e.target.value)}
                    className="bg-bg-secondary text-text-primary px-3 py-1.5 rounded-md border border-border-color text-xs font-mono focus:border-accent outline-hidden"
                  />
                </div>

                {/* Sheet Output Destination */}
                <div className="flex flex-col gap-1">
                  <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                    Output Image File (.jpg / .png):
                  </Text>
                  <input
                    type="text"
                    value={sheetOutputPath}
                    onChange={(e) => setSheetOutputPath(e.target.value)}
                    className="bg-bg-secondary text-text-primary px-3 py-1.5 rounded-md border border-border-color text-xs font-mono focus:border-accent outline-hidden"
                  />
                </div>

                {sheetResultMsg && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium flex items-center gap-2">
                    <Check size={16} />
                    <span>{sheetResultMsg}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <button
              type="button"
              onClick={onClose}
              disabled={isExporting || isGeneratingSheet}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm disabled:opacity-50 cursor-pointer"
            >
              {result ? 'Done' : 'Cancel'}
            </button>

            {activeTab === 'delivery_pack' ? (
              !result && (
                <Button onClick={handleStartExport} disabled={isExporting || selectedPaths.length === 0}>
                  {isExporting ? (
                    <>
                      <Loader2 size={16} className="animate-spin mr-2" />
                      Exporting Packages...
                    </>
                  ) : (
                    <>
                      <Package size={16} className="mr-2 text-emerald-300" />
                      Export Delivery Pack ({selectedPaths.length})
                    </>
                  )}
                </Button>
              )
            ) : (
              <Button onClick={handleGenerateContactSheet} disabled={isGeneratingSheet || selectedPaths.length === 0}>
                {isGeneratingSheet ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Generating Contact Sheet...
                  </>
                ) : (
                  <>
                    <FileText size={16} className="mr-2 text-emerald-300" />
                    Generate Proof Sheet ({selectedPaths.length})
                  </>
                )}
              </Button>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default ClientDeliveryModal;
