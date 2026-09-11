import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ADJUSTMENT_GROUPS, getAdjustmentOptions } from '../../utils/adjustments';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface AdjustmentSelectionProps {
  includedAdjustments: string[];
  onToggle(keys: string[], checked: boolean): void;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export default function AdjustmentSelection({ includedAdjustments, onToggle }: AdjustmentSelectionProps) {
  const { t } = useTranslation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleExpanded = (label: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2 lg:grid-cols-3">
      {Object.entries(ADJUSTMENT_GROUPS).map(([section, groups]) => (
        <div key={section}>
          <Text variant={TextVariants.heading} className="mb-2">
            {t(`editor.adjustments.sections.${section}`, { defaultValue: capitalize(section) })}
          </Text>
          <div className="space-y-1">
            {groups.map((group) => {
              const isExpanded = expandedGroups.has(group.label);
              const checkedCount = group.keys.filter((key) => includedAdjustments.includes(key)).length;
              const isFullyChecked = checkedCount === group.keys.length;

              return (
                <div key={group.label}>
                  <div className="flex min-h-8 items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <Switch
                        label={t(group.label)}
                        checked={isFullyChecked}
                        onChange={(checked) => onToggle(group.keys, checked)}
                      />
                    </div>
                    <button
                      type="button"
                      className="grid size-8 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-surface"
                      onClick={() => toggleExpanded(group.label)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Hide' : 'Show'} ${t(group.label)} settings`}
                    >
                      <ChevronDown className={`size-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="ml-3 mt-1 space-y-1 border-l border-surface pl-3">
                      {getAdjustmentOptions(group).map((option) => {
                        const optionChecked = option.keys.every((key) => includedAdjustments.includes(key));
                        return (
                          <Switch
                            key={option.label}
                            label={option.label}
                            checked={optionChecked}
                            onChange={(checked) => onToggle(option.keys, checked)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
