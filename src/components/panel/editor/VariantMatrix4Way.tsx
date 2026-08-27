import React, { useState } from 'react';
import { useEditorStore, GradingSnapshot } from '../../../store/useEditorStore';
import { Grid2X2, Camera, Check, ArrowUpRight, X, Sparkles } from 'lucide-react';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import clsx from 'clsx';

export const VariantMatrix4Way: React.FC = () => {
  const compareMode = useEditorStore((state) => state.compareMode);
  const snapshots = useEditorStore((state) => state.snapshots);
  const adjustments = useEditorStore((state) => state.adjustments);
  const finalPreviewUrl = useEditorStore((state) => state.finalPreviewUrl);
  const setEditor = useEditorStore((state) => state.setEditor);

  if (compareMode !== 'matrix_4way') return null;

  const slots = ['A', 'B', 'C', 'D'];

  const getSnapshotForSlot = (slotLetter: string): GradingSnapshot | undefined => {
    return snapshots.find((s) => s.id === `slot_${slotLetter}`);
  };

  const handleCaptureSlot = (slotLetter: string) => {
    const newSnapshot: GradingSnapshot = {
      id: `slot_${slotLetter}`,
      name: `Variant ${slotLetter}`,
      adjustments: { ...adjustments },
      previewUrl: finalPreviewUrl,
      timestamp: Date.now(),
    };

    setEditor((state) => ({
      snapshots: [
        ...state.snapshots.filter((s) => s.id !== `slot_${slotLetter}`),
        newSnapshot,
      ],
    }));
  };

  const handlePromoteSlot = (snapshot: GradingSnapshot) => {
    setEditor({
      adjustments: { ...snapshot.adjustments },
      compareMode: 'none',
    });
  };

  const handleClose = () => {
    setEditor({ compareMode: 'none' });
  };

  const [syncZoom, setSyncZoom] = useState<number>(1.0);
  const [syncPan, setSyncPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (syncZoom <= 1.0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - syncPan.x, y: e.clientY - syncPan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || syncZoom <= 1.0) return;
    setSyncPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomDelta = e.deltaY < 0 ? 0.25 : -0.25;
    const nextZoom = Math.max(1.0, Math.min(6.0, Number((syncZoom + zoomDelta).toFixed(2))));
    setSyncZoom(nextZoom);
    if (nextZoom === 1.0) {
      setSyncPan({ x: 0, y: 0 });
    }
  };

  return (
    <div
      className="absolute inset-0 bg-[#0c0c0e]/95 backdrop-blur-xl z-40 flex flex-col p-4 select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border-color/60">
        <div className="flex items-center gap-2">
          <Grid2X2 size={18} className="text-accent" />
          <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
            4-Way Variant Matrix (A / B / C / D)
          </Text>
          <span className="text-xs text-text-secondary ml-2">
            Capture different color treatments to evaluate side-by-side
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Synchronized Zoom Controls */}
          <div className="flex items-center bg-surface rounded-lg p-0.5 border border-border-color/60 text-xs text-text-secondary mr-2">
            <button
              onClick={() => { setSyncZoom(1.0); setSyncPan({ x: 0, y: 0 }); }}
              className={clsx("px-2 py-1 rounded transition-colors", syncZoom === 1.0 ? "bg-accent text-black font-semibold" : "hover:text-text-primary")}
            >
              Fit (1x)
            </button>
            <button
              onClick={() => setSyncZoom(2.0)}
              className={clsx("px-2 py-1 rounded transition-colors", syncZoom === 2.0 ? "bg-accent text-black font-semibold" : "hover:text-text-primary")}
            >
              2x Sync
            </button>
            <button
              onClick={() => setSyncZoom(4.0)}
              className={clsx("px-2 py-1 rounded transition-colors", syncZoom === 4.0 ? "bg-accent text-black font-semibold" : "hover:text-text-primary")}
            >
              4x Sync
            </button>
          </div>

          <button
            onClick={handleClose}
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* 2x2 Grid */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 pt-3 min-h-0">
        {slots.map((slot) => {
          const snapshot = getSnapshotForSlot(slot);

          return (
            <div
              key={slot}
              className="relative rounded-xl border border-border-color/80 bg-surface/40 overflow-hidden flex flex-col group transition-all hover:border-accent/50"
            >
              {/* Slot Header */}
              <div className="flex items-center justify-between px-3 py-2 bg-[#18181b]/80 border-b border-border-color/40 z-10">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent/20 text-accent font-bold text-xs flex items-center justify-center font-mono">
                    {slot}
                  </span>
                  <span className="text-xs font-medium text-text-primary">
                    {snapshot ? snapshot.name : `Empty Slot ${slot}`}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleCaptureSlot(slot)}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-surface hover:bg-surface-secondary border border-border-color/60 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                    title="Capture current editor adjustments into this slot"
                  >
                    <Camera size={12} />
                    <span>{snapshot ? 'Update' : 'Capture'}</span>
                  </button>

                  {snapshot && (
                    <button
                      onClick={() => handlePromoteSlot(snapshot)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-black font-semibold text-[11px] hover:bg-accent/90 transition-colors shadow-xs"
                      title="Set active editor adjustments to this variant"
                    >
                      <Check size={12} />
                      <span>Promote</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Viewport content */}
              <div
                className={clsx(
                  "flex-1 relative flex items-center justify-center bg-black/40 overflow-hidden min-h-0",
                  syncZoom > 1.0 ? "cursor-grab active:cursor-grabbing" : ""
                )}
                onMouseDown={handleMouseDown}
                onWheel={handleWheel}
              >
                {snapshot?.previewUrl ? (
                  <div
                    className="w-full h-full flex items-center justify-center transition-transform duration-75"
                    style={{
                      transform: `scale(${syncZoom}) translate(${syncPan.x / syncZoom}px, ${syncPan.y / syncZoom}px)`,
                    }}
                  >
                    <img
                      src={snapshot.previewUrl}
                      alt={`Variant ${slot}`}
                      className="w-full h-full object-contain pointer-events-none"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-text-secondary/60 gap-2 p-4 text-center">
                    <Sparkles size={24} className="opacity-40" />
                    <span className="text-xs">No variant captured in Slot {slot}</span>
                    <button
                      onClick={() => handleCaptureSlot(slot)}
                      className="mt-1 px-3 py-1 rounded-md bg-surface text-accent text-xs border border-border-color/60 hover:bg-surface-secondary transition-colors"
                    >
                      Capture Current Look
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VariantMatrix4Way;
