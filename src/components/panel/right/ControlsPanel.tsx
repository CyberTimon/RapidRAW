import { RotateCcw, Copy, ClipboardPaste, Aperture } from 'lucide-react';
import BasicAdjustments from '../../adjustments/Basic';
import CurveGraph from '../../adjustments/Curves';
import ColorPanel from '../../adjustments/Color';
import DetailsPanel from '../../adjustments/Details';
import EffectsPanel from '../../adjustments/Effects';
import CollapsibleSection from '../../ui/CollapsibleSection';
import { Adjustments, SectionVisibility, INITIAL_ADJUSTMENTS, ADJUSTMENT_SECTIONS } from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OPTION_SEPARATOR, SelectedImage, AppSettings } from '../../ui/AppProperties';
import { ChannelConfig } from '../../adjustments/Curves';

interface ControlsPanelOption {
  disabled?: boolean;
  icon?: any;
  label?: string;
  onClick?(): void;
  type?: string;
}

interface ControlsProps {
  adjustments: Adjustments;
  collapsibleState: any;
  copiedSectionAdjustments: Adjustments | null;
  handleAutoAdjustments(): void;
  handleLutSelect(path: string): void;
  histogram: ChannelConfig | null;
  selectedImage: SelectedImage;
  setAdjustments(updater: (prev: Adjustments) => Adjustments): void;
  setCollapsibleState(state: any): void;
  setCopiedSectionAdjustments(adjustments: any): void;
  theme: string;
  appSettings: AppSettings | null;
  isWbPickerActive?: boolean;
  toggleWbPicker?: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

export default function Controls({
  adjustments,
  collapsibleState,
  copiedSectionAdjustments,
  handleAutoAdjustments,
  handleLutSelect,
  histogram,
  selectedImage,
  setAdjustments,
  setCollapsibleState,
  setCopiedSectionAdjustments,
  theme,
  appSettings,
  isWbPickerActive,
  toggleWbPicker,
  onDragStateChange,
}: ControlsProps) {
  const { showContextMenu } = useContextMenu();

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
          acc[key] = INITIAL_ADJUSTMENTS[key];
          return acc;
        }, {}),
      sectionVisibility: { ...INITIAL_ADJUSTMENTS.sectionVisibility },
    }));
  };

  const handleToggleSection = (section: string) => {
    setCollapsibleState((prev: any) => ({ ...prev, [section]: !prev[section] }));
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
          adjustmentsToCopy[key] = JSON.parse(JSON.stringify(adjustments[key]));
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
        resetValues[key] = JSON.parse(JSON.stringify(INITIAL_ADJUSTMENTS[key]));
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

    const options: Array<ControlsPanelOption> = [
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
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">Adjustments</h2>
        <div className="flex items-center gap-1">
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleAutoAdjustments}
            data-tooltip="Auto Adjust Image"
          >
            <Aperture size={18} />
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
      <div className="flex-grow overflow-y-auto p-4 flex flex-col gap-2">
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
            <div className="flex-shrink-0 group" key={sectionName}>
              <CollapsibleSection
                isContentVisible={sectionVisibility[sectionName]}
                isOpen={collapsibleState[sectionName]}
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
