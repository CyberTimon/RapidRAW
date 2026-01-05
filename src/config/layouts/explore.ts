import type { LayoutConfig } from '../../types/layout';

/**
 * Explore/Library View Layout
 * 
 * Legacy pixel values:
 * - Left Panel (FolderTree): 256px default, 200-500px range, 32px collapsed
 * - Right Panel (LibraryExport): 320px default, 280-600px range (hidden by default)
 * - Bottom Bar: 40px fixed height (no filmstrip in library view)
 * - Gallery Controls: ~60px header height
 */
export const exploreLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'left-sidebar',
      size: 256,
      minSize: 200,
      maxSize: 500,
      collapsible: true,
      modules: ['folder-tree'],
    },
    {
      id: 'main-content',
      flex: 1,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'gallery-area',
            flex: 1,
            layout: {
              type: 'stack',
              direction: 'vertical',
              children: [
                {
                  id: 'toolbar',
                  size: 60,
                  modules: ['gallery-controls'],
                },
                {
                  id: 'gallery',
                  flex: 1,
                  modules: ['gallery-grid'],
                },
              ],
            },
          },
          {
            id: 'bottom-bar',
            size: 40,
            modules: ['bottom-bar'],
          },
        ],
      },
    },
    {
      id: 'right-sidebar',
      size: 320,
      minSize: 280,
      maxSize: 600,
      collapsible: true,
      visible: false,
      modules: ['library-export-panel'],
    },
  ],
};
