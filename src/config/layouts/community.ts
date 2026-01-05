import type { LayoutConfig } from '../../types/layout';

/**
 * Community View Layout
 * 
 * Legacy pixel values:
 * - Left Panel (FolderTree): 256px default, 200-500px range (same as other views)
 * - Main Content: Full width community preset browser
 * - Bottom Bar: 40px fixed height (only when rootPath exists)
 * - No Right Panel in community view
 * - No Filmstrip in community view
 */
export const communityLayout: LayoutConfig = {
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
            id: 'community-content',
            flex: 1,
            modules: ['community-browser'],
          },
          {
            id: 'bottom-bar',
            size: 40,
            modules: ['bottom-bar'],
          },
        ],
      },
    },
  ],
};
