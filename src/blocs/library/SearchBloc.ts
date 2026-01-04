import { Cubit } from '@blac/core';
import type { SearchCriteria, SearchTag, SearchMode } from '../../types/library.js';

interface SearchState {
  query: string;
  tags: SearchTag[];
  mode: SearchMode;
  isSearching: boolean;
  resultCount: number | null;
  recentSearches: string[];
}

export class SearchBloc extends Cubit<SearchState> {
  private static MAX_RECENT_SEARCHES = 10;

  constructor() {
    super({
      query: '',
      tags: [],
      mode: 'simple',
      isSearching: false,
      resultCount: null,
      recentSearches: [],
    });
  }

  setQuery = (query: string) => {
    this.patch({ query });
  };

  setMode = (mode: SearchMode) => {
    this.patch({ mode });
  };

  addTag = (tag: SearchTag) => {
    this.patch({
      tags: [...this.state.tags, tag],
    });
  };

  removeTag = (index: number) => {
    this.patch({
      tags: this.state.tags.filter((_, i) => i !== index),
    });
  };

  updateTag = (index: number, tag: SearchTag) => {
    const tags = [...this.state.tags];
    tags[index] = tag;
    this.patch({ tags });
  };

  clearTags = () => {
    this.patch({ tags: [] });
  };

  search = async () => {
    const { query, tags } = this.state;
    if (!query && tags.length === 0) {
      this.patch({ resultCount: null });
      return;
    }

    this.patch({ isSearching: true });

    try {
      // TODO: Wire up with TauriService
      // const tauri = borrow(TauriService);
      // const results = await tauri.searchImages(this.getSearchCriteria());

      if (query && !this.state.recentSearches.includes(query)) {
        const recentSearches = [query, ...this.state.recentSearches].slice(
          0,
          SearchBloc.MAX_RECENT_SEARCHES
        );
        this.patch({ recentSearches });
      }

      this.patch({
        isSearching: false,
        resultCount: 0, // Will be populated by actual search
      });
    } catch {
      this.patch({
        isSearching: false,
        resultCount: null,
      });
    }
  };

  clearSearch = () => {
    this.emit({
      query: '',
      tags: [],
      mode: this.state.mode,
      isSearching: false,
      resultCount: null,
      recentSearches: this.state.recentSearches,
    });
  };

  selectRecentSearch = (query: string) => {
    this.patch({ query });
    this.search();
  };

  clearRecentSearches = () => {
    this.patch({ recentSearches: [] });
  };

  getSearchCriteria = (): SearchCriteria => ({
    query: this.state.query,
    tags: this.state.tags,
    mode: this.state.mode,
  });

  get hasActiveSearch(): boolean {
    return this.state.query.length > 0 || this.state.tags.length > 0;
  }

  get isAdvancedMode(): boolean {
    return this.state.mode === 'advanced';
  }
}
