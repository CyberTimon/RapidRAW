import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Loader2, Users, Trash2, Star, Tag } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { CullingSettings, CullingSuggestions, Invokes, Progress } from '../ui/AppProperties';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Slider from '../ui/Slider';
import Dropdown from '../ui/Dropdown';

interface CullingModalProps {
  isOpen: boolean;
  onClose(): void;
  progress: Progress | null;
  suggestions: CullingSuggestions | null;
  error: string | null;
  imagePaths: string[];
  thumbnails: Record<string, string>;
  onApply(action: 'reject' | 'rate_zero' | 'delete', paths: string[]): void;
  onError(error: string): void;
}

type CullAction = 'reject' | 'rate_zero' | 'delete';

const CULL_ACTIONS: {
  value: CullAction;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: 'reject', label: 'Mark as Rejected (Red Label)', icon: <Tag size={16} className="text-red-500" /> },
  { value: 'rate_zero', label: 'Set Rating to 1 Stars', icon: <Star size={16} /> },
  { value: 'delete', label: 'Move to Trash', icon: <Trash2 size={16} /> },
];

function ImageThumbnail({ path, thumbnails, isSelected, onToggle, children }: any) {
  const thumbnailUrl = thumbnails[path];
  return (
    <div
      className={`relative group rounded-md overflow-hidden border-2 transition-colors cursor-pointer ${
        isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
      }`}
      onClick={onToggle}
    >
      <img
        src={thumbnailUrl}
        alt={path}
        className={`w-full h-full object-cover transition-opacity ${isSelected ? 'opacity-100' : 'opacity-75 group-hover:opacity-100'}`}
      />
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${
          isSelected ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'
        }`}
      />
      <div className="absolute top-2 right-2 w-5 h-5 bg-bg-primary rounded-sm border border-surface flex items-center justify-center">
        {isSelected && <CheckCircle size={16} className="text-accent" />}
      </div>
      {children && <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/60 text-white text-xs">{children}</div>}
    </div>
  );
}

export default function CullingModal({
  isOpen,
  onClose,
  progress,
  suggestions,
  error,
  imagePaths,
  thumbnails,
  onApply,
  onError,
}: CullingModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [stage, setStage] = useState<'settings' | 'progress' | 'results'>('settings');

  const [settings, setSettings] = useState<CullingSettings>({
    groupSimilar: true,
    similarityThreshold: 28,
    filterBlurry: true,
    blurThreshold: 100.0,
  });

  const [selectedRejects, setSelectedRejects] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<CullAction>('reject');
  const [activeTab, setActiveTab] = useState<'similar' | 'blurry'>('similar');

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setStage('settings');
        setSelectedRejects(new Set());
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (suggestions || error) {
      setStage('results');
    } else if (progress) {
      setStage('progress');
    } else if (isOpen) {
      setStage('settings');
    }
  }, [progress, suggestions, error, isOpen]);

  useEffect(() => {
    if (stage === 'results' && suggestions) {
      const initialRejects = new Set<string>();
      suggestions.similarGroups.forEach((group) => {
        group.duplicates.forEach((dup) => initialRejects.add(dup.path));
      });
      suggestions.blurryImages.forEach((img) => initialRejects.add(img.path));
      setSelectedRejects(initialRejects);
    }
  }, [stage, suggestions]);

  const handleStartCulling = useCallback(async () => {
    try {
      await invoke(Invokes.CullImages, { paths: imagePaths, settings });
    } catch (err) {
      console.error('Culling failed to start:', err);
      onError(String(err));
    }
  }, [imagePaths, settings, onError]);

  const handleToggleReject = (path: string) => {
    setSelectedRejects((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const handleApply = () => {
    onApply(action, Array.from(selectedRejects));
  };

  const numSimilar = suggestions?.similarGroups.reduce((acc, group) => acc + group.duplicates.length, 0) || 0;
  const numBlurry = suggestions?.blurryImages.length || 0;

  const renderSettings = () => (
    <>
      <div className="flex items-center justify-center mb-4">
        <Users className="w-12 h-12 text-accent" />
      </div>
      <h3 className="text-lg font-semibold text-text-primary mb-6 text-center">Cull Images</h3>
      <div className="space-y-6 text-sm">
        <div>
          <Switch label="Group Similar Images" checked={settings.groupSimilar} onChange={(v) => setSettings((s) => ({ ...s, groupSimilar: v }))} />
          {settings.groupSimilar && (
            <div className="mt-3 pl-6">
              <Slider
                label="Similarity Threshold"
                min={1}
                max={64}
                step={1}
                value={settings.similarityThreshold}
                defaultValue={28}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, similarityThreshold: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-text-secondary mt-1">
                Lower is stricter (exact duplicates). Higher is looser (near duplicates). A value of 24-32 is recommended.
              </p>
            </div>
          )}
        </div>
        <div>
          <Switch label="Filter Blurry Images" checked={settings.filterBlurry} onChange={(v) => setSettings((s) => ({ ...s, filterBlurry: v }))} />
          {settings.filterBlurry && (
            <div className="mt-3 pl-6">
              <Slider
                label="Blur Threshold"
                min={25}
                max={500}
                step={25}
                value={settings.blurThreshold}
                defaultValue={100.0}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, blurThreshold: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-text-secondary mt-1">
                Images with a sharpness score below this value are flagged. Higher is stricter.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-3 mt-8">
        <button className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors" onClick={onClose}>Cancel</button>
        <Button onClick={handleStartCulling}>Start Culling</Button>
      </div>
    </>
  );

  const renderProgress = () => (
    <div className="flex flex-col items-center justify-center h-48">
      <Loader2 className="w-16 h-16 text-accent animate-spin" />
      <p className="mt-4 text-text-primary">{progress?.stage || 'Starting...'}</p>
      {progress && progress.total > 0 && (
        <div className="w-full bg-surface rounded-full h-2.5 mt-2">
          <div className="bg-accent h-2.5 rounded-full" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
        </div>
      )}
    </div>
  );

  const renderResults = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <XCircle className="w-16 h-16 text-red-500" />
          <p className="mt-4 text-text-primary text-center">Culling Failed</p>
          <p className="text-sm text-text-secondary text-center mt-1">{error}</p>
          <div className="mt-6">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      );
    }

    if (!suggestions) return null;

    const totalSuggestions = numSimilar + numBlurry;
    if (totalSuggestions === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <CheckCircle className="w-16 h-16 text-green-500" />
          <p className="mt-4 text-text-primary">No issues found!</p>
          <p className="text-sm text-text-secondary">All images seem to be unique and sharp.</p>
          <div className="mt-6">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      );
    }

    return (
      <>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Culling Suggestions</h3>
        <div className="border-b border-surface mb-4">
          <nav className="-mb-px flex space-x-4" aria-label="Tabs">
            {numSimilar > 0 && (
              <button
                onClick={() => setActiveTab('similar')}
                className={`${
                  activeTab === 'similar'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Similar Groups <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numSimilar}</span>
              </button>
            )}
            {numBlurry > 0 && (
              <button
                onClick={() => setActiveTab('blurry')}
                className={`${
                  activeTab === 'blurry'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Blurry Images <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numBlurry}</span>
              </button>
            )}
          </nav>
        </div>

        <div className="bg-bg-primary rounded-lg p-2 h-[50vh] overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'similar' && (
                <div className="space-y-4">
                  {suggestions.similarGroups.map((group, index) => (
                    <div key={index} className="bg-surface rounded-lg p-3">
                      <p className="text-sm font-semibold mb-2">Group {index + 1}</p>
                      <div className="grid grid-cols-[1fr_3fr] gap-3">
                        <div>
                          <p className="text-xs text-text-secondary mb-1 text-center">Best Image</p>
                          <div className="relative rounded-md overflow-hidden border-2 border-green-500">
                            <img src={thumbnails[group.representative.path]} alt="Representative" className="w-full h-full object-cover" />
                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/60 text-white text-xs">
                              Score: {group.representative.qualityScore.toFixed(2)}
                            </div>
                          </div>
                        </div>
                        <div>
                          <p className="text-xs text-text-secondary mb-1">Duplicates ({group.duplicates.length})</p>
                          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                            {group.duplicates.map((dup) => (
                              <ImageThumbnail
                                key={dup.path}
                                path={dup.path}
                                thumbnails={thumbnails}
                                isSelected={selectedRejects.has(dup.path)}
                                onToggle={() => handleToggleReject(dup.path)}
                              >
                                Score: {dup.qualityScore.toFixed(2)}
                              </ImageThumbnail>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {activeTab === 'blurry' && (
                <div className="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                  {suggestions.blurryImages.map((img) => (
                    <ImageThumbnail
                      key={img.path}
                      path={img.path}
                      thumbnails={thumbnails}
                      isSelected={selectedRejects.has(img.path)}
                      onToggle={() => handleToggleReject(img.path)}
                    >
                      Sharpness: {img.sharpnessMetric.toFixed(0)}
                    </ImageThumbnail>
                  ))}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex justify-between items-center gap-3 mt-6">
          <div className="flex-1">
            <Dropdown
              options={CULL_ACTIONS.map(({ value, label }) => ({ value, label }))}
              value={action}
              onChange={(newValue: CullAction) => setAction(newValue)}
              className="w-full"
            />
          </div>
          <div className="flex gap-3">
            <button className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors" onClick={onClose}>Cancel</button>
            <Button onClick={handleApply} disabled={selectedRejects.size === 0}>
              Apply to {selectedRejects.size} image{selectedRejects.size !== 1 && 's'}
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderContent = () => {
    switch (stage) {
      case 'settings': return renderSettings();
      case 'progress': return renderProgress();
      case 'results': return renderResults();
      default: return null;
    }
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-3xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {renderContent()}
      </div>
    </div>
  );
}