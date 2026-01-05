import { useState, useEffect, useCallback } from 'react';
import { useBloc } from '@blac/react';
import { CheckCircle, XCircle, Loader2, Users, Trash2, Star, Tag } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { Switch } from '../../primitives/Switch';
import { Slider } from '../../primitives/Slider';
import { Dropdown } from '../../primitives/Dropdown';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import type { CullingSettings, CullingSuggestions, ImageAnalysisResult, Progress } from '../../types/constants';

type CullAction = 'reject' | 'rate_zero' | 'delete';

const CULL_ACTIONS = [
  { value: 'reject', label: 'Mark as Rejected (Red Label)' },
  { value: 'rate_zero', label: 'Set Rating to 1 Star' },
  { value: 'delete', label: 'Move to Trash' },
];

interface ImageThumbnailProps {
  path: string;
  thumbnails: Record<string, string>;
  isSelected: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}

function ImageThumbnail({ path, thumbnails, isSelected, onToggle, children }: ImageThumbnailProps) {
  const thumbnailUrl = thumbnails[path];
  return (
    <div
      className={`relative group rounded-md overflow-hidden border-2 cursor-pointer ${
        isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
      }`}
      onClick={onToggle}
    >
      <img
        src={thumbnailUrl}
        alt={path}
        className={`w-full h-full object-cover ${isSelected ? 'opacity-100' : 'opacity-75 group-hover:opacity-100'}`}
      />
      <div className={`absolute inset-0 bg-black/50 ${isSelected ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'}`} />
      <div className="absolute top-2 right-2 w-5 h-5 bg-bg-primary rounded-sm border border-surface flex items-center justify-center">
        {isSelected && <CheckCircle size={16} className="text-accent" />}
      </div>
      {children && <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/60 text-white text-xs">{children}</div>}
    </div>
  );
}

export interface CullingModalData {
  imagePaths: string[];
  thumbnails: Record<string, string>;
  progress: Progress | null;
  suggestions: CullingSuggestions | null;
  error: string | null;
  onStartCulling: (settings: CullingSettings) => void;
  onApply: (action: CullAction, paths: string[]) => void;
}

export function CullingModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('culling');
  const data = state.modalData['culling'] as CullingModalData | undefined;

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
      setStage('settings');
      setSelectedRejects(new Set());
      setSettings({
        groupSimilar: true,
        similarityThreshold: 28,
        filterBlurry: true,
        blurThreshold: 100.0,
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!data) return;
    if (data.suggestions || data.error) {
      setStage('results');
    } else if (data.progress) {
      setStage('progress');
    }
  }, [data?.progress, data?.suggestions, data?.error]);

  useEffect(() => {
    if (stage === 'results' && data?.suggestions) {
      const initialRejects = new Set<string>();
      data.suggestions.similarGroups.forEach((group) => {
        group.duplicates.forEach((dup) => initialRejects.add(dup.path));
      });
      data.suggestions.blurryImages.forEach((img) => initialRejects.add(img.path));
      setSelectedRejects(initialRejects);
    }
  }, [stage, data?.suggestions]);

  const handleClose = () => modalBloc.close('culling');

  const handleStartCulling = useCallback(() => {
    if (!data) return;
    data.onStartCulling(settings);
  }, [data, settings]);

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
    if (!data) return;
    data.onApply(action, Array.from(selectedRejects));
    handleClose();
  };

  if (!isOpen || !data) return null;

  const numSimilar = data.suggestions?.similarGroups.reduce((acc, group) => acc + group.duplicates.length, 0) || 0;
  const numBlurry = data.suggestions?.blurryImages.length || 0;

  const renderSettings = () => (
    <>
      <div className="flex items-center justify-center mb-4">
        <Users className="w-12 h-12 text-accent" />
      </div>
      <h3 className="text-lg font-semibold text-text-primary mb-6 text-center">Cull Images</h3>
      <div className="space-y-6 text-sm">
        <div>
          <Switch
            label="Group Similar Images"
            checked={settings.groupSimilar}
            onChange={(v) => setSettings((s) => ({ ...s, groupSimilar: v }))}
          />
          {settings.groupSimilar && (
            <div className="mt-3 pl-6">
              <Slider
                label="Similarity Threshold"
                min={1}
                max={64}
                step={1}
                value={settings.similarityThreshold}
                onChange={(v) => setSettings((s) => ({ ...s, similarityThreshold: v }))}
              />
              <p className="text-xs text-text-secondary mt-1">
                Lower is stricter (exact duplicates). Higher is looser (near duplicates). 24-32 recommended.
              </p>
            </div>
          )}
        </div>
        <div>
          <Switch
            label="Filter Blurry Images"
            checked={settings.filterBlurry}
            onChange={(v) => setSettings((s) => ({ ...s, filterBlurry: v }))}
          />
          {settings.filterBlurry && (
            <div className="mt-3 pl-6">
              <Slider
                label="Blur Threshold"
                min={25}
                max={500}
                step={25}
                value={settings.blurThreshold}
                onChange={(v) => setSettings((s) => ({ ...s, blurThreshold: v }))}
              />
              <p className="text-xs text-text-secondary mt-1">
                Images with sharpness below this value are flagged. Higher is stricter.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-3 mt-8">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button onClick={handleStartCulling}>Start Culling</Button>
      </div>
    </>
  );

  const renderProgress = () => (
    <div className="flex flex-col items-center justify-center h-48">
      <Loader2 className="w-16 h-16 text-accent animate-spin" />
      <p className="mt-4 text-text-primary">Processing...</p>
      {data.progress && data.progress.total > 0 && (
        <div className="w-full bg-surface rounded-full h-2.5 mt-2">
          <div
            className="bg-accent h-2.5 rounded-full"
            style={{ width: `${((data.progress.current ?? 0) / data.progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );

  const renderResults = () => {
    if (data.error) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <XCircle className="w-16 h-16 text-red-500" />
          <p className="mt-4 text-text-primary text-center">Culling Failed</p>
          <p className="text-sm text-text-secondary text-center mt-1">{data.error}</p>
          <div className="mt-6">
            <Button onClick={handleClose}>Close</Button>
          </div>
        </div>
      );
    }

    if (!data.suggestions) return null;

    const totalSuggestions = numSimilar + numBlurry;
    if (totalSuggestions === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <CheckCircle className="w-16 h-16 text-green-500" />
          <p className="mt-4 text-text-primary">No issues found!</p>
          <p className="text-sm text-text-secondary">All images seem unique and sharp.</p>
          <div className="mt-6">
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      );
    }

    return (
      <>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Culling Suggestions</h3>
        <div className="border-b border-surface mb-4">
          <nav className="-mb-px flex space-x-4">
            {numSimilar > 0 && (
              <button
                onClick={() => setActiveTab('similar')}
                className={`${
                  activeTab === 'similar' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Similar Groups <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numSimilar}</span>
              </button>
            )}
            {numBlurry > 0 && (
              <button
                onClick={() => setActiveTab('blurry')}
                className={`${
                  activeTab === 'blurry' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Blurry Images <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numBlurry}</span>
              </button>
            )}
          </nav>
        </div>

        <div className="bg-bg-primary rounded-lg p-2 h-[50vh] overflow-y-auto">
          {activeTab === 'similar' && (
            <div className="space-y-4">
              {data.suggestions.similarGroups.map((group, index) => (
                <div key={index} className="bg-surface rounded-lg p-3">
                  <p className="text-sm font-semibold mb-2">Group {index + 1}</p>
                  <div className="grid grid-cols-[1fr_3fr] gap-3">
                    <div>
                      <p className="text-xs text-text-secondary mb-1 text-center">Best Image</p>
                      <div className="relative rounded-md overflow-hidden border-2 border-green-500">
                        <img src={data.thumbnails[group.representative.path]} alt="Representative" className="w-full h-full object-cover" />
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
                            thumbnails={data.thumbnails}
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
              {data.suggestions.blurryImages.map((img) => (
                <ImageThumbnail
                  key={img.path}
                  path={img.path}
                  thumbnails={data.thumbnails}
                  isSelected={selectedRejects.has(img.path)}
                  onToggle={() => handleToggleReject(img.path)}
                >
                  Sharpness: {img.sharpnessMetric.toFixed(0)}
                </ImageThumbnail>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center gap-3 mt-6">
          <div className="flex-1">
            <Dropdown
              options={CULL_ACTIONS}
              value={action}
              onChange={(v) => setAction(v as CullAction)}
            />
          </div>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
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
      case 'settings':
        return renderSettings();
      case 'progress':
        return renderProgress();
      case 'results':
        return renderResults();
      default:
        return null;
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Cull Images" size="lg">
      {renderContent()}
    </Modal>
  );
}
