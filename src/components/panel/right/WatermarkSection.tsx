import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import Switch from '../../ui/Switch';
import Slider from '../../ui/Slider';
import ImagePicker from '../../ui/ImagePicker';
import PanelSection from '../../ui/PanelSection';
import SegmentedControl from '../../ui/SegmentedControl';
import Input from '../../ui/Input';
import Dropdown from '../../ui/Dropdown';
import ColorField, { normalizeHexColor, useParsedTextField } from '../../ui/ColorField';
import FontPicker, { useFontWeights } from '../../ui/FontPicker';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { WatermarkSourceKind } from '../../../types/export';
import { useWatermarkStore } from '../../../store/useWatermarkStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { reloadWatermarkImage, useWatermarkImage, WatermarkImage } from '../../../hooks/useWatermarkImage';
import { ExportFrameFill, WatermarkPlacer, rectStyle } from '../editor/overlays/WatermarkPlacer';
import {
  DEFAULT_WATERMARK,
  ExportLayout,
  MAX_WATERMARK_MARGIN,
  MAX_WATERMARK_SCALE,
  MIN_WATERMARK_SCALE,
  exportFrame,
  watermarkSource,
  withMargin,
} from '../../../utils/watermark';

const PREVIEW_MAX_HEIGHT = 260;

interface WatermarkPreviewProps {
  paths: Array<string>;
  image: WatermarkImage;
  layout: ExportLayout;
}

function WatermarkPreview({ paths, image, layout }: WatermarkPreviewProps) {
  const [index, setIndex] = useState(0);
  const path = paths[Math.min(index, paths.length - 1)];
  const thumbnail = useProcessStore((state) => state.mediumThumbnails[path] ?? state.thumbnails[path]);
  const [loaded, setLoaded] = useState<{ url: string; width: number; height: number } | null>(null);
  const photo = loaded?.url === thumbnail ? loaded : { width: 3, height: 2 };

  const frame = useMemo(
    () => exportFrame(photo.width, photo.height, layout.border, layout.pad),
    [photo.width, photo.height, layout],
  );
  const aspect = frame.width / frame.height;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center" style={paths.length > 1 ? { height: PREVIEW_MAX_HEIGHT } : undefined}>
        <div
          className="relative mx-auto overflow-hidden rounded-md bg-bg-primary"
          style={{
            aspectRatio: `${frame.width} / ${frame.height}`,
            width: `min(100%, ${PREVIEW_MAX_HEIGHT * aspect}px)`,
          }}
        >
          {thumbnail && (
            <img
              alt=""
              src={thumbnail}
              draggable={false}
              className={clsx(
                'absolute select-none pointer-events-none object-fill',
                loaded?.url === thumbnail ? 'opacity-100' : 'opacity-0',
              )}
              style={rectStyle(frame.photo, frame.width, frame.height)}
              onLoad={(event) =>
                setLoaded({
                  url: thumbnail,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          )}
          <ExportFrameFill frame={frame} layout={layout} />
          <WatermarkPlacer frameWidth={frame.width} frameHeight={frame.height} image={image} />
        </div>
      </div>
      {paths.length > 1 && (
        <div className="flex items-center justify-center gap-1">
          <button
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
            onClick={() =>
              setIndex((current) => (Math.min(current, paths.length - 1) + paths.length - 1) % paths.length)
            }
          >
            <ChevronLeft size={14} />
          </button>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="tabular-nums min-w-12 text-center">
            {`${Math.min(index, paths.length - 1) + 1} / ${paths.length}`}
          </Text>
          <button
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
            onClick={() => setIndex((current) => (Math.min(current, paths.length - 1) + 1) % paths.length)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

interface WatermarkSectionProps {
  disabled: boolean;
  layout: ExportLayout;
  previewPaths: Array<string> | null;
}

function TextWatermarkFields({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const watermark = useWatermarkStore((state) => state.watermark);
  const setWatermark = useWatermarkStore((state) => state.setWatermark);
  const weights = useFontWeights(watermark.font);
  const colorField = useParsedTextField(watermark.color, (color) => setWatermark({ color }), normalizeHexColor);
  const weight = weights?.length
    ? weights.reduce((best, option) =>
        Math.abs(option - watermark.fontWeight) < Math.abs(best - watermark.fontWeight) ? option : best,
      )
    : watermark.fontWeight;

  return (
    <div className="space-y-3">
      <Input
        value={watermark.text}
        placeholder={t('export.watermark.textPlaceholder')}
        onChange={(event) => setWatermark({ text: event.target.value })}
        disabled={disabled}
      />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
        <Text variant={TextVariants.label}>{t('export.watermark.font')}</Text>
        <FontPicker
          className="w-full"
          value={watermark.font}
          onChange={(font) => setWatermark({ font })}
          systemOption={false}
        />
        {weights && weights.length > 1 && (
          <>
            <Text variant={TextVariants.label}>{t('export.watermark.weight')}</Text>
            <Dropdown<number>
              className="w-full"
              options={weights.map((value) => ({ value, label: t(`ui.fontPicker.weights.${value}`) }))}
              value={weight}
              onChange={(fontWeight) => setWatermark({ fontWeight })}
            />
          </>
        )}
      </div>
      <ColorField
        color={watermark.color}
        disabled={disabled}
        field={colorField}
        label={t('export.watermark.color')}
        onColorChange={(color) => setWatermark({ color })}
      />
    </div>
  );
}

export default function WatermarkSection({ disabled, layout, previewPaths }: WatermarkSectionProps) {
  const { t } = useTranslation();
  const watermark = useWatermarkStore((state) => state.watermark);
  const setWatermark = useWatermarkStore((state) => state.setWatermark);
  const setExportLayout = useWatermarkStore((state) => state.setExportLayout);
  const source = watermark.enabled ? watermarkSource(watermark) : null;
  const image = useWatermarkImage(source);
  const isPlaced = !!source;
  const isText = watermark.source === WatermarkSourceKind.Text;
  const [heldHeight, setHeldHeight] = useState<number | null>(null);

  useEffect(() => {
    if (heldHeight === null || !image) return;
    setHeldHeight(null);
    const scale = Math.min(MAX_WATERMARK_SCALE, Math.max(MIN_WATERMARK_SCALE, heldHeight * image.aspect));
    setWatermark({ scale: Math.round(scale * 10) / 10 });
  }, [heldHeight, image, setWatermark]);

  useEffect(() => {
    setExportLayout(isPlaced ? layout : null);
  }, [isPlaced, layout, setExportLayout]);

  useEffect(() => () => setExportLayout(null), [setExportLayout]);

  const switchSource = (kind: WatermarkSourceKind) => {
    if (kind === watermark.source) return;
    setHeldHeight(image ? watermark.scale / image.aspect : null);
    setWatermark({ source: kind });
  };

  const handleImageSelect = (selected: string) => {
    if (selected === watermark.path) reloadWatermarkImage();
    else setWatermark({ path: selected });
  };

  return (
    <PanelSection title={t('export.sections.watermark')}>
      <Switch
        label={t('export.watermark.addWatermark')}
        checked={watermark.enabled}
        onChange={(enabled) => setWatermark({ enabled })}
        disabled={disabled}
        trackClassName="bg-surface"
      />
      {watermark.enabled && (
        <div className={clsx('space-y-4 pl-2 border-l-2 border-surface', disabled && 'opacity-50 pointer-events-none')}>
          <SegmentedControl<WatermarkSourceKind>
            options={[
              { id: WatermarkSourceKind.Image, label: t('export.watermark.sources.image') },
              { id: WatermarkSourceKind.Text, label: t('export.watermark.sources.text') },
            ]}
            value={watermark.source}
            onChange={switchSource}
            disabled={disabled}
          />
          {isText ? (
            <TextWatermarkFields disabled={disabled} />
          ) : (
            <div>
              <ImagePicker
                label={t('export.watermark.watermarkImage')}
                imageName={watermark.path ? watermark.path.split(/[\\/]/).pop() || null : null}
                onImageSelect={handleImageSelect}
                onClear={() => setWatermark({ path: null })}
              />
              {image === null && (
                <Text variant={TextVariants.label} className="text-red-500">
                  {t('export.watermark.unreadable')}
                </Text>
              )}
            </div>
          )}
          {(isText || watermark.path) && (
            <>
              {previewPaths && previewPaths.length > 0 && image && (
                <WatermarkPreview paths={previewPaths} image={image} layout={layout} />
              )}
              <div>
                <Slider
                  label={t('export.watermark.size')}
                  min={MIN_WATERMARK_SCALE}
                  max={MAX_WATERMARK_SCALE}
                  step={0.1}
                  value={watermark.scale}
                  defaultValue={DEFAULT_WATERMARK.scale}
                  onChange={(event) => setWatermark({ scale: Number(event.target.value) })}
                  fillOrigin="min"
                  suffix="%"
                />
                <Slider
                  label={t('export.watermark.margin')}
                  min={0}
                  max={MAX_WATERMARK_MARGIN}
                  step={0.1}
                  value={watermark.margin}
                  defaultValue={DEFAULT_WATERMARK.margin}
                  onChange={(event) => {
                    const margin = Number(event.target.value);
                    setWatermark(withMargin({ ...watermark, margin }, margin));
                  }}
                  fillOrigin="min"
                  suffix="%"
                />
                <Slider
                  label={t('export.watermark.opacity')}
                  min={0}
                  max={100}
                  step={1}
                  value={watermark.opacity}
                  defaultValue={DEFAULT_WATERMARK.opacity}
                  onChange={(event) => setWatermark({ opacity: Number(event.target.value) })}
                  fillOrigin="min"
                  suffix="%"
                />
              </div>
              <div className="flex justify-end">
                <button
                  className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active hover:text-text-primary transition-colors"
                  onClick={() =>
                    setWatermark({
                      anchor: DEFAULT_WATERMARK.anchor,
                      scale: DEFAULT_WATERMARK.scale,
                      offsetX: DEFAULT_WATERMARK.offsetX,
                      offsetY: DEFAULT_WATERMARK.offsetY,
                      margin: DEFAULT_WATERMARK.margin,
                    })
                  }
                >
                  {t('export.watermark.resetPlacement')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </PanelSection>
  );
}
