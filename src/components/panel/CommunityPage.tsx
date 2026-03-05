import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Search,
  Users,
  Github,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Invokes, SupportedTypes, ImageFile } from '../ui/AppProperties';
import { INITIAL_ADJUSTMENTS } from '../../utils/adjustments';

const DEFAULT_PREVIEW_IMAGE_URL = 'https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/sample-image.jpg';

interface CommunityPreset {
  name: string;
  creator: string;
  adjustments: Record<string, any>;
}

const containerVariants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
    },
  },
};

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
  },
};

interface CommunityPageProps {
  onBackToLibrary: () => void;
  supportedTypes: SupportedTypes | null;
  imageList: ImageFile[];
  currentFolderPath: string | null;
}

// More robust shuffle algorithm
const shuffleArray = (array: any[]) => {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
};

const CommunityPage = ({ onBackToLibrary, imageList, currentFolderPath }: CommunityPageProps) => {
  const [presets, setPresets] = useState<CommunityPreset[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [previewImagePaths, setPreviewImagePaths] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [downloadStatus, setDownloadStatus] = useState<Record<string, 'idle' | 'downloading' | 'success'>>({});
  const [allPreviewsLoaded, setAllPreviewsLoaded] = useState(false);

  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const fetchDefaultPreviewImage = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch(DEFAULT_PREVIEW_IMAGE_URL);
      const blob = await response.blob();
      const tempPath: string = await invoke(Invokes.SaveTempFile, { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
      return tempPath;
    } catch (error) {
      console.error("Failed to fetch default preview image:", error);
      return null;
    }
  }, []);

  useEffect(() => {
    const fetchPresets = async () => {
      setIsLoading(true);
      try {
        const communityPresets: CommunityPreset[] = await invoke(Invokes.FetchCommunityPresets);
        setPresets(communityPresets);
      } catch (error) {
        console.error("Failed to fetch community presets:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPresets();

    return () => {
      Object.values(previewsRef.current).forEach(url => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, []);

  useEffect(() => {
    const setupPreviewImages = async () => {
      setPreviews({});

      if (!currentFolderPath || imageList.length === 0) {
        const defaultPath = await fetchDefaultPreviewImage();
        if (defaultPath) {
          setPreviewImagePaths([defaultPath]);
        }
        return;
      }

      const shuffled = shuffleArray(imageList);

      if (imageList.length === 1) {
        setPreviewImagePaths([imageList[0].path]);
      } else if (imageList.length >= 2 && imageList.length <= 3) {
        setPreviewImagePaths(shuffled.slice(0, 2).map(img => img.path));
      } else if (imageList.length >= 4) {
        setPreviewImagePaths(shuffled.slice(0, 4).map(img => img.path));
      }
    };

    setupPreviewImages();
  }, [imageList, currentFolderPath, fetchDefaultPreviewImage]);

  useEffect(() => {
    if (presets.length === 0 || previewImagePaths.length === 0) {
      return;
    }

    const generateAllPreviews = async () => {
      setAllPreviewsLoaded(false);
      try {
        const previewDataMap: Record<string, number[]> = await invoke(Invokes.GenerateAllCommunityPreviews, {
          imagePaths: previewImagePaths,
          presets: presets.map(p => ({
            ...p,
            adjustments: { ...INITIAL_ADJUSTMENTS, ...p.adjustments }
          })),
        });

        const newPreviews: Record<string, string | null> = {};
        for (const [presetName, imageData] of Object.entries(previewDataMap)) {
          const blob = new Blob([new Uint8Array(imageData)], { type: 'image/jpeg' });
          newPreviews[presetName] = URL.createObjectURL(blob);
        }

        setPreviews(prev => {
          Object.values(prev).forEach(url => url?.startsWith('blob:') && URL.revokeObjectURL(url));
          return newPreviews;
        });

      } catch (error) {
        console.error(`Failed to generate previews:`, error);
      } finally {
        setAllPreviewsLoaded(true);
      }
    };

    generateAllPreviews();

  }, [presets, previewImagePaths]);

  const handleDownloadPreset = async (preset: CommunityPreset) => {
    setDownloadStatus(prev => ({ ...prev, [preset.name]: 'downloading' }));
    try {
      if (!preset.adjustments) {
          throw new Error("Preset adjustments are missing.");
      }

      await invoke(Invokes.SaveCommunityPreset, {
        name: preset.name,
        adjustments: preset.adjustments,
      });
      setDownloadStatus(prev => ({ ...prev, [preset.name]: 'success' }));
    } catch (error) {
      console.error(`Failed to download preset ${preset.name}:`, error);
      setDownloadStatus(prev => ({ ...prev, [preset.name]: 'idle' }));
    }
  };

  const filteredAndSortedPresets = useMemo(() => {
    return presets
      .filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        if (sortBy === 'name') {
          return a.name.localeCompare(b.name);
        }
        return 0;
      });
  }, [presets, searchTerm, sortBy]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-bg-secondary rounded-lg overflow-hidden p-4">
      <header className="flex-shrink-0 flex items-center justify-between mb-4 flex-wrap gap-4">
        <div className="flex items-center">
          <Button
            className="mr-4 hover:bg-surface text-text-primary rounded-full"
            onClick={onBackToLibrary}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
              <Users /> Community Presets
            </h1>
            <p className="text-sm text-text-secondary">Discover presets created by the community.</p>
          </div>
        </div>
      </header>

      <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
        <div className="relative">
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search presets..."
            className="pl-10 w-64"
          />
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary" />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-secondary">Sort by:</span>
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-surface border border-border-color rounded-md py-1.5 pl-3 pr-8 text-sm appearance-none focus:ring-accent focus:border-accent"
            >
              <option value="name">Name (A-Z)</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary pointer-events-none" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 -mr-2">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-text-secondary">
            <Loader2 className="h-8 w-8 animate-spin mr-2" />
            Fetching presets from GitHub...
          </div>
        ) : (
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            <AnimatePresence>
              {filteredAndSortedPresets.map(preset => {
                const previewUrl = previews[preset.name];
                const status = downloadStatus[preset.name] || 'idle';
                
                return (
                  <motion.div
                    key={preset.name}
                    layout
                    variants={itemVariants}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="bg-surface rounded-lg overflow-hidden group border border-border-color flex flex-col"
                  >
                    <div className="relative w-full aspect-square bg-bg-primary flex items-center justify-center text-text-secondary">
                      {previewUrl ? (
                        <img 
                          src={previewUrl} 
                          alt={preset.name} 
                          className="w-full h-full object-cover transition-all duration-300 group-hover:blur-sm group-hover:brightness-75" 
                        />
                      ) : (
                        <Loader2 className="h-6 w-6 animate-spin" />
                      )}
                      
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleDownloadPreset(preset)}
                          disabled={status !== 'idle'}
                          className="shadow-lg"
                        >
                          {status === 'idle' && <>Save</>}
                          {status === 'downloading' && <><Loader2 size={14} className="mr-2 animate-spin" /> Saving...</>}
                          {status === 'success' && <><CheckCircle2 size={14} className="mr-2" /> Saved</>}
                        </Button>
                      </div>
                    </div>
                    <div className="p-3 text-center">
                      <h4 className="font-semibold truncate text-text-primary">{preset.name}</h4>
                      <p className="text-xs text-text-secondary font-['cursive'] italic mt-1">by {preset.creator}</p>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )}
        {allPreviewsLoaded && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="text-center mt-8 py-4 text-sm text-text-secondary"
          >
            <p>Want to get your preset featured?</p>
            <a
              href="https://github.com/CyberTimon/RapidRAW-Presets/issues/new?assignees=&labels=preset-submission&template=preset_submission.md&title=Preset+Submission%3A+%5BYour+Preset+Name%5D"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline inline-flex items-center gap-2"
            >
              <Github size={14} />
              Create an issue on GitHub
            </a>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default CommunityPage;