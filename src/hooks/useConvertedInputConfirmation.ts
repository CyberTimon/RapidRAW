import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import {
  CONVERTED_INPUT_DISCLOSURE_VERSION,
  requiresConvertedInputDisclosure,
} from './convertedInputSupport';

/**
 * Gates inputs that require decoding through RapidRAW's converted-input
 * pipeline. A versioned acknowledgement in app settings makes the disclosure
 * a one-time explanation while still allowing materially changed behavior to
 * be disclosed again in a future release.
 */
export function useConvertedInputConfirmation() {
  const { t } = useTranslation();
  const pendingResolution = useRef<((approved: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      pendingResolution.current?.(false);
      pendingResolution.current = null;
    },
    [],
  );

  const confirmConvertedInputs = useCallback(
    async (paths: string[]): Promise<boolean> => {
      const { osPlatform, supportedTypes } = useSettingsStore.getState();
      const configuredExtensions = supportedTypes?.convertedInput;
      const disclosureVersion = useSettingsStore.getState().appSettings?.convertedInputDisclosureVersion ?? 0;

      if (!requiresConvertedInputDisclosure(paths, configuredExtensions, osPlatform, disclosureVersion)) return true;

      pendingResolution.current?.(false);

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (approved: boolean) => {
          if (settled) return;
          settled = true;

          if (approved) {
            const { appSettings, handleSettingsChange } = useSettingsStore.getState();
            if (
              appSettings &&
              (appSettings.convertedInputDisclosureVersion ?? 0) < CONVERTED_INPUT_DISCLOSURE_VERSION
            ) {
              void handleSettingsChange({
                ...appSettings,
                convertedInputDisclosureVersion: CONVERTED_INPUT_DISCLOSURE_VERSION,
              });
            }
          }
          if (pendingResolution.current === settle) {
            pendingResolution.current = null;
          }
          resolve(approved);
        };

        pendingResolution.current = settle;

        useUIStore.getState().setUI({
          confirmModalState: {
            confirmText: t('modals.convertedInput.confirm', { defaultValue: 'Open HEIC' }),
            confirmVariant: 'primary',
            isOpen: true,
            message: t('modals.convertedInput.message', {
              defaultValue:
                "RapidRAW uses your system's HEVC decoder to open HEIC/HEIF images as a high-precision RGB working image for editing. No new image file is created, and the original remains unchanged.\n\nYour edits are saved automatically in a .rrdata sidecar next to the original. Use Export when you want a finished JPEG, TIFF, or other image file. HDR appearance may vary from an HDR-aware viewer.",
            }),
            onCancel: () => settle(false),
            onConfirm: () => settle(true),
            title: t('modals.convertedInput.title', { defaultValue: 'Open HEIC for editing?' }),
          },
        });
      });
    },
    [t],
  );

  return { confirmConvertedInputs };
}
