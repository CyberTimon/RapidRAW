import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import Switch from '../ui/Switch';
import Dropdown from '../ui/Dropdown';
import { FILENAME_VARIABLES } from '../ui/ExportImportProperties';
import Text from '../ui/Text';
import { ImportSettings, Invokes, Preset } from '../ui/AppProperties';
import { Adjustments } from '../../utils/adjustments';
import { UserPreset } from '../../hooks/usePresets';
import { TextVariants } from '../../types/typography';

interface FlatPreset {
  id: string;
  name: string;
  adjustments: Partial<Adjustments>;
}

interface ImportSettingsModalProps {
  fileCount: number;
  initialSettings?: ImportSettings | null;
  isOpen: boolean;
  onClose(): void;
  onSave(settings: ImportSettings): void;
}

const DEFAULTS: ImportSettings = {
  filenameTemplate: '{original_filename}',
  organizeByDate: false,
  dateFolderFormat: 'YYYY/MM-DD',
  deleteAfterImport: false,
  applyAutoAdjustments: false,
  presetId: null,
};

export default function ImportSettingsModal({
  fileCount,
  initialSettings,
  isOpen,
  onClose,
  onSave,
}: ImportSettingsModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const [filenameTemplate, setFilenameTemplate] = useState(DEFAULTS.filenameTemplate);
  const [organizeByDate, setOrganizeByDate] = useState(DEFAULTS.organizeByDate);
  const [dateFolderFormat, setDateFolderFormat] = useState(DEFAULTS.dateFolderFormat);
  const [deleteAfterImport, setDeleteAfterImport] = useState(DEFAULTS.deleteAfterImport);
  const [applyAutoAdjustments, setApplyAutoAdjustments] = useState(!!DEFAULTS.applyAutoAdjustments);
  const [presetId, setPresetId] = useState<string | null>(DEFAULTS.presetId ?? null);
  const [presets, setPresets] = useState<Array<FlatPreset>>([]);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const s = { ...DEFAULTS, ...(initialSettings || {}) };
    setFilenameTemplate(s.filenameTemplate || DEFAULTS.filenameTemplate);
    setOrganizeByDate(!!s.organizeByDate);
    setDateFolderFormat(s.dateFolderFormat || DEFAULTS.dateFolderFormat);
    setDeleteAfterImport(!!s.deleteAfterImport);
    setApplyAutoAdjustments(!!s.applyAutoAdjustments);
    setPresetId(s.presetId ?? null);
  }, [isOpen, initialSettings]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    invoke<Array<UserPreset>>(Invokes.LoadPresets)
      .then((loaded) => {
        const flat: Array<FlatPreset> = [];
        for (const item of loaded || []) {
          if (item?.preset) {
            flat.push(item.preset);
          } else if (item?.folder) {
            for (const child of (item.folder.children as Array<Preset>) || []) {
              flat.push({ id: child.id, adjustments: child.adjustments, name: `${item.folder.name} / ${child.name}` });
            }
          }
        }
        setPresets(flat);
      })
      .catch((err) => console.error('Failed to load presets for import:', err));
  }, [isOpen]);

  const presetOptions = useMemo(
    () => [
      { label: t('modals.importSettings.presetNone'), value: '' },
      ...presets.map((p) => ({ label: p.name, value: p.id })),
    ],
    [presets, t],
  );

  const handleSave = useCallback(() => {
    let finalFilenameTemplate = filenameTemplate;
    if (
      fileCount > 1 &&
      !filenameTemplate.includes('{sequence}') &&
      !filenameTemplate.includes('{original_filename}')
    ) {
      finalFilenameTemplate = `${filenameTemplate}_{sequence}`;
    }

    const selectedPreset = presetId ? presets.find((p) => p.id === presetId) : null;

    onSave({
      filenameTemplate: finalFilenameTemplate,
      organizeByDate,
      dateFolderFormat,
      deleteAfterImport,
      applyAutoAdjustments,
      presetId: selectedPreset ? selectedPreset.id : null,
      presetAdjustments: selectedPreset ? selectedPreset.adjustments : null,
    });
    onClose();
  }, [
    onSave,
    onClose,
    filenameTemplate,
    organizeByDate,
    dateFolderFormat,
    deleteAfterImport,
    applyAutoAdjustments,
    presetId,
    presets,
    fileCount,
  ]);

  const handleKeyDown = useCallback(
    (e: any) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose],
  );

  const handleVariableClick = (variable: string) => {
    if (!filenameInputRef.current) {
      return;
    }
    const input = filenameInputRef.current;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const currentValue = input.value;
    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    setFilenameTemplate(newValue);
    setTimeout(() => {
      input.focus();
      const newCursorPos = start + variable.length;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  if (!isMounted) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-lg transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e: any) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <Text variant={TextVariants.title} className="mb-4">
          {t('modals.importSettings.title')}
        </Text>

        <div className="space-y-8 text-sm max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importSettings.fileNaming')}
            </Text>
            <input
              autoFocus
              className="w-full bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
              onChange={(e: any) => setFilenameTemplate(e.target.value)}
              ref={filenameInputRef}
              type="text"
              value={filenameTemplate}
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {FILENAME_VARIABLES.map((variable: string) => (
                <button
                  className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active transition-colors"
                  key={variable}
                  onClick={() => handleVariableClick(variable)}
                >
                  {variable}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importSettings.folderOrganization')}
            </Text>
            <Switch
              label={t('modals.importSettings.organizeByDate')}
              checked={organizeByDate}
              onChange={setOrganizeByDate}
            />
            {organizeByDate && (
              <div className="mt-2">
                <Text variant={TextVariants.label} className="block mb-1">
                  {t('modals.importSettings.dateFormat')}
                </Text>
                <input
                  className="w-full bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
                  onChange={(e: any) => setDateFolderFormat(e.target.value)}
                  placeholder={t('modals.importSettings.dateFormatPlaceholder')}
                  type="text"
                  value={dateFolderFormat}
                />
              </div>
            )}
          </div>

          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importSettings.editsOnImport')}
            </Text>
            <Switch
              checked={applyAutoAdjustments}
              label={t('modals.importSettings.applyAutoAdjustments')}
              onChange={setApplyAutoAdjustments}
            />
            <div className="mt-3">
              <Text variant={TextVariants.label} className="block mb-1">
                {t('modals.importSettings.applyPreset')}
              </Text>
              <Dropdown
                options={presetOptions}
                value={presetId ?? ''}
                onChange={(v) => setPresetId(v ? String(v) : null)}
                placeholder={t('modals.importSettings.presetNone')}
              />
            </div>
            {(applyAutoAdjustments || presetId) && (
              <Text variant={TextVariants.small} className="mt-2">
                {t('modals.importSettings.editsOnImportHint')}
              </Text>
            )}
          </div>

          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.importSettings.sourceFiles')}
            </Text>
            <Switch
              checked={deleteAfterImport}
              label={t('modals.importSettings.deleteAfterImport')}
              onChange={setDeleteAfterImport}
            />
            {deleteAfterImport && (
              <Text variant={TextVariants.small} className="mt-1">
                {t('modals.importSettings.deleteWarning')}
              </Text>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-8">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            {t('modals.importSettings.cancel')}
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent shadow-shiny text-button-text font-semibold hover:bg-accent-hover transition-colors"
            onClick={handleSave}
          >
            {t('modals.importSettings.startImport')}
          </button>
        </div>
      </div>
    </div>
  );
}
