import { useAppState } from '../../context/ContextProviders';
import { useHandleSettingsChange } from './useHandleSettingsChange';

export function useHandleActiveTreeSectionChange() {
  const { setActiveTreeSection, appSettings } = useAppState();
  const handleSettingsChange = useHandleSettingsChange();

  const handleActiveTreeSectionChange = (section: string | null) => {
    setActiveTreeSection(section);
    if (appSettings) {
      handleSettingsChange({ ...appSettings, activeTreeSection: section });
    }
  };

  return handleActiveTreeSectionChange;
}
