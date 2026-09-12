import { PencilSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAutoStore } from './store';
import { buildAutoWhiteBalanceOptions } from './applyOptions';
import { useEditorStore } from '../store/useEditorStore';

export default function AutoWhiteBalanceButton() {
  const { t } = useTranslation();
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const options = useAutoStore((state) => state.options);
  const pending = useAutoStore((state) => state.pending);
  const running = useAutoStore((state) => state.progress?.running === true);
  const activePath = selectedImage?.isReady ? selectedImage.path : null;
  const paths = activePath ? [activePath] : [];
  const label = `${t('contextMenus.editor.autoAdjust')}: ${t('adjustments.color.whiteBalance')}`;

  const apply = async () => {
    if (!paths.length || pending || running) return;
    const { runAuto } = await import('./runtime');
    await runAuto(paths, 'apply', buildAutoWhiteBalanceOptions(options));
  };

  return (
    <button
      type="button"
      aria-label={label}
      className="p-1.5 rounded-md text-text-secondary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
      data-tooltip={label}
      disabled={!paths.length || pending || running}
      onClick={() => void apply()}
    >
      <PencilSparkles size={16} />
    </button>
  );
}
