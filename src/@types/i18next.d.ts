import 'i18next';
import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en & typeof zh;
    };
  }
}
