import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Dropdown from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { useSettingsStore } from '../../store/useSettingsStore';
import { DEFAULT_IMMICH_SETTINGS, ImmichSettings } from './immichApi';
import { useImmichStore } from './useImmichStore';

export function useImmichExportAvailable() {
  return useImmichStore((state) => state.isConfigured);
}

export function useImmichExportChoice() {
  const immich = useSettingsStore((state) => state.appSettings?.immich);
  const albums = useImmichStore((state) => state.albums);
  const settings: ImmichSettings = { ...DEFAULT_IMMICH_SETTINGS, ...immich };
  const album = settings.exportAlbum;
  const isKnown = album === 'source' || album === 'none' || albums.some((a) => a.id === album);
  return { album: isKnown ? album : 'source', withOriginal: settings.exportWithOriginal };
}

export default function ImmichExportOptions({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const appSettings = useSettingsStore((state) => state.appSettings);
  const handleSettingsChange = useSettingsStore((state) => state.handleSettingsChange);
  const albums = useImmichStore((state) => state.albums);
  const loadAlbums = useImmichStore((state) => state.loadAlbums);
  const { album, withOriginal } = useImmichExportChoice();

  useEffect(() => {
    if (albums.length === 0) loadAlbums();
  }, [albums.length, loadAlbums]);

  const change = (changes: Partial<ImmichSettings>) => {
    if (!appSettings) return;
    handleSettingsChange({
      ...appSettings,
      immich: { ...DEFAULT_IMMICH_SETTINGS, ...appSettings.immich, ...changes },
    });
  };

  const options = [
    { label: t('immich.export.sourceAlbum'), value: 'source' },
    { label: t('immich.export.noAlbum'), value: 'none' },
    ...albums.map((a) => ({ label: a.albumName, value: a.id })),
  ];

  return (
    <div className="space-y-3 pl-2 border-l-2 border-surface">
      <div className="flex items-center gap-3">
        <Text variant={TextVariants.label} className="whitespace-nowrap min-w-[70px]">
          {t('immich.export.album')}
        </Text>
        <Dropdown
          options={options}
          value={album}
          onChange={(value) => change({ exportAlbum: value as string })}
          disabled={disabled}
          className="w-full"
        />
      </div>
      <Switch
        id="immich-export-with-original"
        label={t('immich.export.withOriginal')}
        tooltip={t('immich.export.withOriginalDesc')}
        checked={withOriginal}
        onChange={(exportWithOriginal) => change({ exportWithOriginal })}
        disabled={disabled}
      />
    </div>
  );
}
