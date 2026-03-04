import { createContext, PropsWithChildren, useContext, useState } from 'react';
import {
  Theme,
  FilterCriteria,
  LibraryViewMode,
  SortCriteria,
  ThumbnailSize,
  ThumbnailAspectRatio,
  UiVisibility,
  AppSettings,
} from '../../components/ui/AppProperties';
import { ExportPreset } from '../../components/ui/ExportImportProperties';

interface AppSettingsContext {
  appSettings: AppSettings | null;
  setAppSettings: (settings: AppSettings | null) => void;
}

const AppSettingsContext = createContext<AppSettingsContext | null>(null);

export function AppSettingsContextProvider({ children }: PropsWithChildren) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

  return <AppSettingsContext.Provider value={{ appSettings, setAppSettings }}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const ctx = useContext(AppSettingsContext);

  if (!ctx) {
    throw new Error(`${useAppSettings.name} must be used within a ${AppSettingsContextProvider.name}`);
  }

  return ctx;
}
