import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { getTheme, NEUTRAL_CANVAS_COLOR } from '../../../utils/themes';
import { normalizeHexColor } from '../../ui/ColorField';

function getThemeCanvasColor(theme: string) {
  const color = getTheme(theme).cssVariables['--app-editor-bg'];
  const channels = color.match(/\d+/g);
  return channels ? `#${channels.map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}` : '#2c2c2c';
}

function setCanvasPreview(color: string | null) {
  const { canvasPreviewColor, setEditor } = useEditorStore.getState();
  if (canvasPreviewColor !== color) setEditor({ canvasPreviewColor: color });
}

export default function CanvasBackgroundMenu({ hideContextMenu }: { hideContextMenu(): void }) {
  const { t } = useTranslation();
  const savedColor = useSettingsStore((state) => state.appSettings?.editorCanvasColor);
  const neutralGrey = useSettingsStore((state) => state.appSettings?.editorNeutralGreyBg);
  const theme = useSettingsStore((state) => state.theme);
  const color =
    normalizeHexColor(savedColor ?? '') ?? (neutralGrey ? NEUTRAL_CANVAS_COLOR : getThemeCanvasColor(theme));
  const swatchRef = useRef<HTMLInputElement>(null);

  const applyColor = useCallback(
    (editorCanvasColor?: string) => {
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      if (appSettings && editorCanvasColor !== appSettings.editorCanvasColor) {
        void handleSettingsChange({ ...appSettings, editorCanvasColor });
      }
      setCanvasPreview(null);
      hideContextMenu();
    },
    [hideContextMenu],
  );

  useEffect(() => {
    const swatch = swatchRef.current;
    if (!swatch) return;
    // Preview input events in the editor and persist the committed color once.
    const previewColor = () => setCanvasPreview(swatch.value);
    const commitColor = () => applyColor(swatch.value);
    swatch.addEventListener('input', previewColor);
    swatch.addEventListener('change', commitColor);
    return () => {
      swatch.removeEventListener('input', previewColor);
      swatch.removeEventListener('change', commitColor);
      setCanvasPreview(null);
    };
  }, [applyColor]);

  return (
    <div className="flex items-center gap-1 rounded-lg bg-surface/95 p-2">
      <input
        aria-label={t('contextMenus.editor.canvasBackground')}
        className="size-8 shrink-0 cursor-pointer rounded-md border border-text-secondary/50 bg-transparent p-1 focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0"
        defaultValue={color}
        ref={swatchRef}
        type="color"
      />
      <button
        className="rounded-md px-3 py-2 text-sm text-text-primary transition-colors duration-150 hover:bg-bg-primary focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-text-secondary disabled:hover:bg-transparent"
        disabled={!savedColor}
        onClick={() => applyColor()}
        type="button"
      >
        {t('contextMenus.editor.canvasColorReset')}
      </button>
    </div>
  );
}
