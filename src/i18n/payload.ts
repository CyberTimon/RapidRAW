export interface I18nEventPayload {
  key: string;
  params?: Record<string, any>;
}

export const isI18nEventPayload = (payload: unknown): payload is I18nEventPayload => {
  return typeof payload === 'object' && payload !== null && typeof (payload as I18nEventPayload).key === 'string';
};
