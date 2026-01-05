import type { LayoutConfig } from '../../types/layout';

/**
 * Edit View Layout
 * 
 * Legacy pixel values:
 * - Left Panel (FolderTree): 256px default, 200-500px range, 32px collapsed
 * - Right Panel: 368px default (320px content + 48px tabs), 280-600px range
 * - Bottom Panel (Filmstrip): 144px default, 100-400px range
 * - Bottom Toolbar: 40px fixed height
 */
export const editLayout: LayoutConfig = {
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
      id: 'editor-main',
      flex: 1,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'editor-canvas',
            flex: 1,
            modules: ['image-preview'],
          },
          {
            id: 'filmstrip-area',
            size: 144,
            minSize: 100,
            maxSize: 400,
            collapsible: true,
            layout: {
              type: 'stack',
              direction: 'vertical',
              children: [
                {
                  id: 'filmstrip',
                  flex: 1,
                  modules: ['filmstrip'],
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
      },
    },
    {
      id: 'right-panel',
      size: 368,
      minSize: 280,
      maxSize: 600,
      collapsible: true,
      modules: ['panel-switcher'],
    },
  ],
};
