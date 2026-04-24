import { Theme } from '../components/ui/AppProperties';

export interface ThemeProps {
  cssVariables: any;
  id: Theme;
  name: string;
  splashImage: string;
}

export const THEMES: Array<ThemeProps> = [
  {
    id: Theme.Dark,
    name: 'Dark',
    splashImage: '/splash-dark.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(24, 24, 24)',
      '--app-bg-secondary': 'rgb(35, 35, 35)',
      '--app-surface': 'rgb(28, 28, 28)',
      '--app-card-active': 'rgb(43, 43, 43)',
      '--app-button-text': 'rgb(0, 0, 0)',
      '--app-text-primary': 'rgb(232, 234, 237)',
      '--app-text-secondary': 'rgb(158, 158, 158)',
      '--app-accent': 'rgb(255, 255, 255)',
      '--app-border-color': 'rgb(45, 45, 45)',
      '--app-hover-color': 'rgb(255, 255, 255)',
    },
  },
  {
    id: Theme.Light,
    name: 'Light',
    splashImage: '/splash-light.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(240, 240, 240)',
      '--app-bg-secondary': 'rgb(255, 255, 255)',
      '--app-surface': 'rgb(244, 244, 244)',
      '--app-card-active': 'rgb(255, 255, 255)',
      '--app-button-text': 'rgb(255, 255, 255)',
      '--app-text-primary': 'rgb(20, 20, 20)',
      '--app-text-secondary': 'rgb(108, 108, 108)',
      '--app-accent': 'rgb(181, 141, 98)',
      '--app-border-color': 'rgb(224, 224, 224)',
      '--app-hover-color': 'rgb(181, 141, 98)',
    },
  },
  {
    id: Theme.Grey,
    name: 'Grey',
    splashImage: '/splash-grey.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(84, 84, 84)',
      '--app-bg-secondary': 'rgb(90, 90, 90)',
      '--app-surface': 'rgb(80, 80, 80)',
      '--app-card-active': 'rgb(105, 105, 105)',
      '--app-button-text': 'rgb(80, 80, 80)',
      '--app-text-primary': 'rgb(225, 225, 225)',
      '--app-text-secondary': 'rgb(160, 160, 160)',
      '--app-accent': 'rgb(210, 210, 210)',
      '--app-border-color': 'rgb(110, 110, 110)',
      '--app-hover-color': 'rgb(210, 210, 210)',
    },
  },
];

export const DEFAULT_THEME_ID = Theme.Dark;
