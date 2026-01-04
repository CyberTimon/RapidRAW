import { Cubit } from '@blac/core';
import type { Adjustments } from '../../types/adjustments';

export interface CommunityPreset {
  id: string;
  name: string;
  description: string;
  author: string;
  authorAvatar?: string;
  thumbnailUrl?: string;
  previewUrls: string[];
  adjustments: Partial<Adjustments>;
  downloads: number;
  likes: number;
  createdAt: string;
  tags: string[];
  category: PresetCategory;
}

export type PresetCategory =
  | 'all'
  | 'portrait'
  | 'landscape'
  | 'street'
  | 'film'
  | 'moody'
  | 'bright'
  | 'vintage'
  | 'minimal'
  | 'cinematic';

export type SortOption = 'popular' | 'newest' | 'downloads' | 'name';

interface CommunityState {
  presets: CommunityPreset[];
  filteredPresets: CommunityPreset[];
  selectedPreset: CommunityPreset | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  selectedCategory: PresetCategory;
  sortBy: SortOption;
  viewMode: 'grid' | 'list';
}

const MOCK_PRESETS: CommunityPreset[] = [
  {
    id: '1',
    name: 'Golden Hour Glow',
    description: 'Warm tones perfect for sunset and golden hour photos',
    author: 'PhotoMaster',
    thumbnailUrl: '/splash-sepia.jpg',
    previewUrls: ['/splash-sepia.jpg'],
    adjustments: { temperature: 20, exposure: 0.3, vibrance: 15 },
    downloads: 12500,
    likes: 890,
    createdAt: '2024-01-15',
    tags: ['warm', 'sunset', 'golden'],
    category: 'landscape',
  },
  {
    id: '2',
    name: 'Moody Blues',
    description: 'Cool, desaturated look with lifted shadows',
    author: 'FilmLover',
    thumbnailUrl: '/splash-blue.jpg',
    previewUrls: ['/splash-blue.jpg'],
    adjustments: { temperature: -15, contrast: 20, shadows: 30 },
    downloads: 8900,
    likes: 654,
    createdAt: '2024-02-20',
    tags: ['moody', 'cool', 'film'],
    category: 'moody',
  },
  {
    id: '3',
    name: 'Clean Portrait',
    description: 'Natural skin tones with subtle enhancement',
    author: 'PortraitPro',
    thumbnailUrl: '/splash-light.jpg',
    previewUrls: ['/splash-light.jpg'],
    adjustments: { exposure: 0.2, clarity: -10, vibrance: 8 },
    downloads: 15600,
    likes: 1200,
    createdAt: '2024-03-05',
    tags: ['portrait', 'natural', 'clean'],
    category: 'portrait',
  },
  {
    id: '4',
    name: 'Vintage Film',
    description: 'Classic film emulation with grain and faded blacks',
    author: 'RetroShots',
    thumbnailUrl: '/splash-green.jpg',
    previewUrls: ['/splash-green.jpg'],
    adjustments: { contrast: -10, blacks: 15, saturation: -10 },
    downloads: 9800,
    likes: 780,
    createdAt: '2024-01-28',
    tags: ['vintage', 'film', 'retro'],
    category: 'vintage',
  },
  {
    id: '5',
    name: 'Arctic Minimal',
    description: 'High-key, clean aesthetic with cool undertones',
    author: 'MinimalArt',
    thumbnailUrl: '/splash-arctic.jpg',
    previewUrls: ['/splash-arctic.jpg'],
    adjustments: { exposure: 0.4, highlights: -20, temperature: -8 },
    downloads: 7200,
    likes: 520,
    createdAt: '2024-02-10',
    tags: ['minimal', 'clean', 'bright'],
    category: 'minimal',
  },
  {
    id: '6',
    name: 'Street Dark',
    description: 'High contrast, dramatic shadows for urban photography',
    author: 'UrbanEye',
    thumbnailUrl: '/splash-dark.jpg',
    previewUrls: ['/splash-dark.jpg'],
    adjustments: { contrast: 30, blacks: -20, clarity: 20 },
    downloads: 11200,
    likes: 890,
    createdAt: '2024-03-12',
    tags: ['street', 'urban', 'dramatic'],
    category: 'street',
  },
];

export class CommunityBloc extends Cubit<CommunityState> {
  constructor() {
    super({
      presets: [],
      filteredPresets: [],
      selectedPreset: null,
      isLoading: false,
      error: null,
      searchQuery: '',
      selectedCategory: 'all',
      sortBy: 'popular',
      viewMode: 'grid',
    });
  }

  loadPresets = async () => {
    this.patch({ isLoading: true, error: null });

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.patch({
        presets: MOCK_PRESETS,
        isLoading: false,
      });
      this.applyFilters();
    } catch (error) {
      this.patch({
        error: `Failed to load presets: ${error}`,
        isLoading: false,
      });
    }
  };

  setSearchQuery = (query: string) => {
    this.patch({ searchQuery: query });
    this.applyFilters();
  };

  setCategory = (category: PresetCategory) => {
    this.patch({ selectedCategory: category });
    this.applyFilters();
  };

  setSortBy = (sort: SortOption) => {
    this.patch({ sortBy: sort });
    this.applyFilters();
  };

  setViewMode = (mode: 'grid' | 'list') => {
    this.patch({ viewMode: mode });
  };

  selectPreset = (preset: CommunityPreset | null) => {
    this.patch({ selectedPreset: preset });
  };

  downloadPreset = async (preset: CommunityPreset): Promise<void> => {
    const updatedPresets = this.state.presets.map((p) =>
      p.id === preset.id ? { ...p, downloads: p.downloads + 1 } : p
    );
    this.patch({ presets: updatedPresets });
    this.applyFilters();
  };

  likePreset = async (presetId: string): Promise<void> => {
    const updatedPresets = this.state.presets.map((p) =>
      p.id === presetId ? { ...p, likes: p.likes + 1 } : p
    );
    this.patch({ presets: updatedPresets });
    this.applyFilters();
  };

  private applyFilters = () => {
    let filtered = [...this.state.presets];

    if (this.state.searchQuery) {
      const query = this.state.searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.author.toLowerCase().includes(query) ||
          p.tags.some((t) => t.toLowerCase().includes(query))
      );
    }

    if (this.state.selectedCategory !== 'all') {
      filtered = filtered.filter((p) => p.category === this.state.selectedCategory);
    }

    switch (this.state.sortBy) {
      case 'popular':
        filtered.sort((a, b) => b.likes - a.likes);
        break;
      case 'newest':
        filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'downloads':
        filtered.sort((a, b) => b.downloads - a.downloads);
        break;
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    this.patch({ filteredPresets: filtered });
  };
}
