import React, { useCallback } from 'react';
import { RotateCcw, Copy, ClipboardPaste, Aperture, ChartArea } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import BasicAdjustments from '../../adjustments/Basic';
import CurveGraph from '../../adjustments/Curves';
import ColorPanel from '../../adjustments/Color';
import DetailsPanel from '../../adjustments/Details';
import EffectsPanel from '../../adjustments/Effects';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Waveform from '../editor/Waveform';
import Resizer from '../../ui/Resizer';
import { Adjustments, SectionVisibility, INITIAL_ADJUSTMENTS, ADJUSTMENT_SECTIONS } from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OPTION_SEPARATOR, Orientation } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useWaveformControls } from '../../../hooks/useWaveformControls';

export default function Controls() {
  const { showContextMenu } = useContextMenu();
  const { isResizingWaveform, onToggleWaveform, setActiveWaveformChannel, handleWaveformResize } =
    useWaveformControls();
  const { setAdjustments, handleAutoAdjustments, handleLutSelect } = useEditorActions();

  const { appSettings, theme } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
    })),
  );

  const { collapsibleSectionsState, setUI } = useUIStore(
    useShallow((state) => ({
      collapsibleSectionsState: state.collapsibleSectionsState,
      setUI: state.setUI,
    })),
  );

  const {
    adjustments,
    copiedSectionAdjustments,
    histogram,
    selectedImage,
    isWbPickerActive,
    isWaveformVisible,
    waveform,
    activeWaveformChannel,
    waveformHeight,
    setEditor,
  } = useEditorStore(
    useShallow((state) => ({
      adjustments: state.adjustments,
      copiedSectionAdjustments: state.copiedSectionAdjustments,
      histogram: state.histogram,
      selectedImage: state.selectedImage,
      isWbPickerActive: state.isWbPickerActive,
      isWaveformVisible: state.isWaveformVisible,
      waveform: state.waveform,
      activeWaveformChannel: state.activeWaveformChannel,
      waveformHeight: state.waveformHeight,
      setEditor: state.setEditor,
    })),
  );

  const setCopiedSectionAdjustments = useCallback(
    (val: any) => setEditor({ copiedSectionAdjustments: val }),
    [setEditor],
  );

  const toggleWbPicker = useCallback(
    () => setEditor((state) => ({ isWbPickerActive: !state.isWbPickerActive })),
    [setEditor],
  );

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const setCollapsibleState = useCallback(
    (updater: any) =>
      setUI((state) => ({
        collapsibleSectionsState: typeof updater === 'function' ? updater(state.collapsibleSectionsState) : updater,
      })),
    [setUI],
  );

  const handleToggleVisibility = (sectionName: string) => {
    setAdjustments((prev: Adjustments) => {
      const currentVisibility: SectionVisibility = prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility;
      return {
        ...prev,
        sectionVisibility: {
          ...currentVisibility,
          [sectionName]: !currentVisibility[sectionName],
        },
      };
    });
  };

  const handleResetAdjustments = () => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      ...Object.keys(ADJUSTMENT_SECTIONS)
        .flatMap((s) => ADJUSTMENT_SECTIONS[s])
        .reduce((acc: any, key: string) => {
          acc[key] = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
          return acc;
        }, {}),
      sectionVisibility: { ...INITIAL_ADJUSTMENTS.sectionVisibility },
    }));
  };

  const handleToggleSection = (section: string) => {
    setCollapsibleState((prev: any) => {
      const isOpening = !prev[section];
      if (appSettings?.enableFocusMode && isOpening) {
        const newState = { ...prev };
        Object.keys(newState).forEach((key) => {
          newState[key] = false;
        });
        newState[section] = true;
        return newState;
      }
      return { ...prev, [section]: !prev[section] };
    });
  };

  const handleSectionContextMenu = (event: any, sectionName: string) => {
    event.preventDefault();
    event.stopPropagation();

    const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
    if (!sectionKeys) {
      return;
    }

    const handleCopy = () => {
      const adjustmentsToCopy: any = {};
      for (const key of sectionKeys) {
        if (Object.prototype.hasOwnProperty.call(adjustments, key)) {
          adjustmentsToCopy[key] = JSON.parse(JSON.stringify(adjustments[key as keyof Adjustments]));
        }
      }
      setCopiedSectionAdjustments({ section: sectionName, values: adjustmentsToCopy });
    };

    const handlePaste = () => {
      if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) {
        return;
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...copiedSectionAdjustments.values,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const handleReset = () => {
      const resetValues: any = {};
      for (const key of sectionKeys) {
        resetValues[key] = JSON.parse(JSON.stringify(INITIAL_ADJUSTMENTS[key as keyof Adjustments]));
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...resetValues,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const isPasteAllowed = copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName;
    const pasteLabel = copiedSectionAdjustments
      ? `Paste ${
          copiedSectionAdjustments.section.charAt(0).toUpperCase() + copiedSectionAdjustments.section.slice(1)
        } Settings`
      : 'Paste Settings';

    const options: any = [
      {
        label: `Copy ${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)} Settings`,
        icon: Copy,
        onClick: handleCopy,
      },
      { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
      { type: OPTION_SEPARATOR },
      {
        label: `Reset ${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)} Settings`,
        icon: RotateCcw,
        onClick: handleReset,
      },
    ];

    showContextMenu(event.clientX, event.clientY, options);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>Adjustments</Text>
        <div className="flex items-center gap-1">
          <button
            className="p-2 rounded-full hover:bg-surface disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage?.isReady}
            onClick={handleAutoAdjustments}
            data-tooltip="Auto Adjust Image"
          >
            <Aperture size={18} />
          </button>
          <button
            className={clsx(
              'p-2 rounded-full transition-colors',
              isWaveformVisible ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
            )}
            onClick={onToggleWaveform}
            data-tooltip="Toggle Analytics Display"
          >
            <ChartArea size={18} />
          </button>
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleResetAdjustments}
            data-tooltip="Reset Adjustments"
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isWaveformVisible && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: waveformHeight || 256, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
            className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
          >
            <div className="grow w-full h-full p-4 pb-2 min-h-0">
              <Waveform
                waveformData={waveform || null}
                histogram={histogram}
                displayMode={activeWaveformChannel || 'luma'}
                setDisplayMode={setActiveWaveformChannel}
                showClipping={adjustments.showClipping || false}
                onToggleClipping={() => {
                  setAdjustments((prev: Adjustments) => ({
                    ...prev,
                    showClipping: !prev.showClipping,
                  }));
                }}
                theme={theme}
              />
            </div>
            <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grow overflow-y-auto p-4 flex flex-col gap-2">
        {Object.keys(ADJUSTMENT_SECTIONS).map((sectionName: string) => {
          const SectionComponent: any = {
            basic: BasicAdjustments,
            curves: CurveGraph,
            color: ColorPanel,
            details: DetailsPanel,
            effects: EffectsPanel,
          }[sectionName];

          const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
          const sectionVisibility = adjustments.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility;

          return (
            <div className="shrink-0 group" key={sectionName}>
              <CollapsibleSection
                isContentVisible={sectionVisibility[sectionName as keyof SectionVisibility]}
                isOpen={collapsibleSectionsState[sectionName as keyof typeof collapsibleSectionsState]}
                onContextMenu={(e: any) => handleSectionContextMenu(e, sectionName)}
                onToggle={() => handleToggleSection(sectionName)}
                onToggleVisibility={() => handleToggleVisibility(sectionName)}
                title={title}
              >
                <SectionComponent
                  adjustments={adjustments}
                  setAdjustments={setAdjustments}
                  histogram={histogram}
                  theme={theme}
                  handleLutSelect={handleLutSelect}
                  appSettings={appSettings}
                  isWbPickerActive={isWbPickerActive}
                  toggleWbPicker={toggleWbPicker}
                  onDragStateChange={onDragStateChange}
                />
              </CollapsibleSection>
            </div>
          );
        })}
      </div>
    </div>
  );
}
