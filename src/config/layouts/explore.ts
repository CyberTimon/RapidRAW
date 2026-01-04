import type { LayoutConfig } from '../../types/layout';

export const exploreLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'left-sidebar',
      size: 256,
      minSize: 200,
      maxSize: 400,
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
            id: 'toolbar',
            size: 80,
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
      id: 'right-sidebar',
      size: 320,
      minSize: 280,
      maxSize: 500,
      collapsible: true,
      visible: false,
      modules: ['metadata-panel'],
    },
  ],
};
