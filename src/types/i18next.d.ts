import 'i18next';

declare module 'i18next' {
  interface CustomTypeOptions {
    returnNull: false;
    resources: {
      translation: Record<string, any>;
    };
  }
}
