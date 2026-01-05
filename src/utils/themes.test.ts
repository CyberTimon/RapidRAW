import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Theme,
  THEMES,
  DEFAULT_THEME_ID,
  getThemeById,
  getThemeByIdOrDefault,
  applyTheme,
  getThemeOptions,
  getSplashImage,
} from './themes';

describe('themes', () => {
  describe('Theme enum', () => {
    it('should have all 8 themes defined', () => {
      expect(Object.values(Theme)).toHaveLength(8);
      expect(Theme.Dark).toBe('dark');
      expect(Theme.Light).toBe('light');
      expect(Theme.Grey).toBe('grey');
      expect(Theme.MutedGreen).toBe('muted-green');
      expect(Theme.Blue).toBe('blue');
      expect(Theme.Sepia).toBe('sepia');
      expect(Theme.Snow).toBe('snow');
      expect(Theme.Arctic).toBe('arctic');
    });
  });

  describe('THEMES array', () => {
    it('should contain 8 theme definitions', () => {
      expect(THEMES).toHaveLength(8);
    });

    it('should have unique ids', () => {
      const ids = THEMES.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(8);
    });

    it('should have all required CSS variables', () => {
      const requiredVars = [
        '--color-bg-primary-rgb',
        '--opacity-bg-primary',
        '--color-bg-secondary-rgb',
        '--opacity-bg-secondary',
        '--color-surface',
        '--color-card-active',
        '--color-button-text',
        '--color-text-primary',
        '--color-text-secondary',
        '--color-accent',
        '--color-border-color',
        '--color-hover-color',
      ];

      THEMES.forEach((theme) => {
        requiredVars.forEach((varName) => {
          expect(theme.cssVariables).toHaveProperty(varName);
          expect(theme.cssVariables[varName as keyof typeof theme.cssVariables]).toBeTruthy();
        });
      });
    });

    it('should have splash images for all themes', () => {
      THEMES.forEach((theme) => {
        expect(theme.splashImage).toBeTruthy();
        expect(theme.splashImage).toMatch(/^\/splash-.+\.jpg$/);
      });
    });

    it('should have names for all themes', () => {
      THEMES.forEach((theme) => {
        expect(theme.name).toBeTruthy();
        expect(typeof theme.name).toBe('string');
      });
    });
  });

  describe('DEFAULT_THEME_ID', () => {
    it('should be dark theme', () => {
      expect(DEFAULT_THEME_ID).toBe(Theme.Dark);
    });

    it('should exist in THEMES array', () => {
      const defaultTheme = THEMES.find((t) => t.id === DEFAULT_THEME_ID);
      expect(defaultTheme).toBeDefined();
    });
  });

  describe('getThemeById', () => {
    it('should return theme for valid id', () => {
      const theme = getThemeById('dark');
      expect(theme).toBeDefined();
      expect(theme?.id).toBe(Theme.Dark);
      expect(theme?.name).toBe('Dark');
    });

    it('should return undefined for invalid id', () => {
      const theme = getThemeById('nonexistent');
      expect(theme).toBeUndefined();
    });

    it('should find all themes', () => {
      THEMES.forEach((expectedTheme) => {
        const theme = getThemeById(expectedTheme.id);
        expect(theme).toBeDefined();
        expect(theme?.id).toBe(expectedTheme.id);
      });
    });
  });

  describe('getThemeByIdOrDefault', () => {
    it('should return theme for valid id', () => {
      const theme = getThemeByIdOrDefault('light');
      expect(theme.id).toBe(Theme.Light);
    });

    it('should return default theme for invalid id', () => {
      const theme = getThemeByIdOrDefault('nonexistent');
      expect(theme.id).toBe(THEMES[0].id);
    });

    it('should return first theme when default not found', () => {
      const theme = getThemeByIdOrDefault('invalid-theme-id');
      expect(theme).toBe(THEMES[0]);
    });
  });

  describe('applyTheme', () => {
    let originalSetProperty: typeof CSSStyleDeclaration.prototype.setProperty;

    beforeEach(() => {
      originalSetProperty = document.documentElement.style.setProperty;
      document.documentElement.style.setProperty = vi.fn();
    });

    it('should set CSS variables on document root', () => {
      applyTheme('dark');
      const darkTheme = THEMES.find((t) => t.id === Theme.Dark)!;
      
      Object.entries(darkTheme.cssVariables).forEach(([property, value]) => {
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
          property,
          value
        );
      });
    });

    it('should fall back to default theme for invalid id', () => {
      applyTheme('nonexistent');
      expect(document.documentElement.style.setProperty).toHaveBeenCalled();
    });
  });

  describe('getThemeOptions', () => {
    it('should return array of options with value and label', () => {
      const options = getThemeOptions();
      expect(options).toHaveLength(8);
      
      options.forEach((option) => {
        expect(option).toHaveProperty('value');
        expect(option).toHaveProperty('label');
        expect(typeof option.value).toBe('string');
        expect(typeof option.label).toBe('string');
      });
    });

    it('should have values matching theme ids', () => {
      const options = getThemeOptions();
      const themeIds = THEMES.map((t) => t.id);
      
      options.forEach((option) => {
        expect(themeIds).toContain(option.value);
      });
    });

    it('should have labels matching theme names', () => {
      const options = getThemeOptions();
      const themeNames = THEMES.map((t) => t.name);
      
      options.forEach((option) => {
        expect(themeNames).toContain(option.label);
      });
    });
  });

  describe('getSplashImage', () => {
    it('should return splash image for valid theme', () => {
      const splash = getSplashImage('dark');
      expect(splash).toBe('/splash-dark.jpg');
    });

    it('should return splash image for all themes', () => {
      THEMES.forEach((theme) => {
        const splash = getSplashImage(theme.id);
        expect(splash).toBe(theme.splashImage);
      });
    });

    it('should return default splash image for invalid theme', () => {
      const splash = getSplashImage('nonexistent');
      expect(splash).toBe(THEMES[0].splashImage);
    });
  });
});
