import i18n from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';

import enCommon from './locales/en/common.json';
import enLibrary from './locales/en/library.json';
import enBackend from './locales/en/backend.json';
import enModals from './locales/en/modals.json';
import enSettings from './locales/en/settings.json';

import frCommon from './locales/fr/common.json';
import frLibrary from './locales/fr/library.json';
import frBackend from './locales/fr/backend.json';
import frModals from './locales/fr/modals.json';
import frSettings from './locales/fr/settings.json';

import esCommon from './locales/es/common.json';
import esLibrary from './locales/es/library.json';
import esBackend from './locales/es/backend.json';
import esModals from './locales/es/modals.json';
import esSettings from './locales/es/settings.json';

export const SUPPORTED_LOCALES = ['fr', 'es', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const normalizeLocale = (candidate?: string | null): SupportedLocale => {
  if (!candidate) return 'fr';

  const lower = candidate.toLowerCase();
  const exactMatch = SUPPORTED_LOCALES.find((locale) => locale === lower);
  if (exactMatch) return exactMatch;

  const short = lower.split('-')[0];
  const shortMatch = SUPPORTED_LOCALES.find((locale) => locale === short);
  if (shortMatch) return shortMatch;

  return 'fr';
};

const resources = {
  en: {
    common: enCommon,
    library: enLibrary,
    backend: enBackend,
    modals: enModals,
    settings: enSettings,
  },
  fr: {
    common: frCommon,
    library: frLibrary,
    backend: frBackend,
    modals: frModals,
    settings: frSettings,
  },
  es: {
    common: esCommon,
    library: esLibrary,
    backend: esBackend,
    modals: esModals,
    settings: esSettings,
  },
};

const detectedBrowserLocale =
  typeof navigator !== 'undefined' && typeof navigator.language === 'string'
    ? normalizeLocale(navigator.language)
    : 'fr';

if (!i18n.isInitialized) {
  const sharedConfig = {
    resources,
    lng: detectedBrowserLocale,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: ['common', 'library', 'backend', 'modals', 'settings'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
  };

  try {
    i18n.use(ICU).use(initReactI18next).init(sharedConfig);
  } catch (err) {
    // Fail open: keep the app bootable even if ICU plugin is unavailable at runtime.
    console.error('Failed to initialize i18next ICU plugin, falling back to plain i18next.', err);
    i18n.use(initReactI18next).init(sharedConfig);
  }
}

export default i18n;
