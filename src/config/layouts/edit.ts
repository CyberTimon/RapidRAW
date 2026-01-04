import type { LayoutConfig } from '../../types/layout';

export const editLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
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
            id: 'filmstrip',
            size: 120,
            minSize: 80,
            maxSize: 200,
            collapsible: true,
            modules: ['filmstrip'],
          },
        ],
      },
    },
    {
      id: 'right-panel',
      size: 340,
      minSize: 300,
      maxSize: 500,
      collapsible: true,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'panel-tabs',
            size: 48,
            modules: ['panel-switcher'],
          },
          {
            id: 'active-panel',
            flex: 1,
            modules: ['adjustments-panel'],
          },
          {
            id: 'metadata-bar',
            size: 60,
            collapsible: true,
            modules: ['rating-control'],
          },
        ],
      },
    },
  ],
};
