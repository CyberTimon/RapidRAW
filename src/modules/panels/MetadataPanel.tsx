import { useMemo } from 'react';
import { useBloc } from '@blac/react';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { MetadataBloc } from '../../blocs/editor/MetadataBloc.js';
import { CollapsibleSection } from '../../primitives/CollapsibleSection.js';

function formatExifTag(str: string): string {
  if (!str) return '';
  return str.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

interface MetadataItemProps {
  label: string;
  value: unknown;
}

function MetadataItem({ label, value }: MetadataItemProps) {
  const displayValue = String(value);
  return (
    <div className="grid grid-cols-3 gap-2 text-xs py-1.5 px-2 rounded odd:bg-bg-primary">
      <p className="font-semibold text-text-primary col-span-1 break-words">{label}</p>
      <p className="text-text-secondary col-span-2 break-words truncate" title={displayValue}>
        {displayValue}
      </p>
    </div>
  );
}

interface GPSMapProps {
  latitude: number;
  longitude: number;
  altitude: number | null;
}

function GPSMap({ latitude, longitude, altitude }: GPSMapProps) {
  const mapSrc = useMemo(() => {
    const bbox = `${longitude - 0.01},${latitude - 0.01},${longitude + 0.01},${latitude + 0.01}`;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude},${longitude}`;
  }, [latitude, longitude]);

  const mapLink = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative rounded-md overflow-hidden border border-surface">
        <iframe
          className="pointer-events-none"
          frameBorder="0"
          height="180"
          loading="lazy"
          scrolling="no"
          src={mapSrc}
          width="100%"
          title="GPS Location Map"
        />
        <a
          className="absolute inset-0 cursor-pointer"
          href={mapLink}
          rel="noopener noreferrer"
          target="_blank"
          title="Open map in new tab"
        />
      </div>
      <div className="flex flex-col gap-1">
        <MetadataItem label="Latitude" value={latitude.toFixed(6)} />
        <MetadataItem label="Longitude" value={longitude.toFixed(6)} />
        {altitude !== null && <MetadataItem label="Altitude" value={`${altitude}m`} />}
      </div>
    </div>
  );
}

export function MetadataPanel() {
  const [editor] = useBloc(EditorBloc);
  const [metadata] = useBloc(MetadataBloc);
  const { selectedImage } = editor;
  const { keyCameraSettings, gpsData, otherExifEntries, isLoading } = metadata;

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
          <h2 className="text-lg font-bold text-text-primary">Metadata</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="rounded-full h-6 w-6 border-2 border-accent border-t-transparent" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      </div>
    );
  }

  if (!selectedImage) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
          <h2 className="text-lg font-bold text-text-primary">Metadata</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-text-secondary text-center">No image selected</p>
        </div>
      </div>
    );
  }

  const filename = selectedImage.path.split(/[\\/]/).pop() || 'Unknown';
  const dimensions = `${selectedImage.width} x ${selectedImage.height}`;
  const hasGps = gpsData.latitude !== null && gpsData.longitude !== null;
  const hasOtherExif = otherExifEntries.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-lg font-bold text-text-primary">Metadata</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <CollapsibleSection title="File Properties" defaultOpen>
            <div className="flex flex-col gap-1">
              <MetadataItem label="Filename" value={filename} />
              <MetadataItem label="Dimensions" value={dimensions} />
              {selectedImage.isRaw && <MetadataItem label="Type" value="RAW" />}
            </div>
          </CollapsibleSection>

          {keyCameraSettings.length > 0 && (
            <CollapsibleSection title="Camera Settings" defaultOpen>
              <div className="flex flex-col gap-1">
                {keyCameraSettings.map((setting) => (
                  <MetadataItem key={setting.key} label={setting.label} value={setting.value} />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {hasGps && (
            <CollapsibleSection title="GPS Location" defaultOpen>
              <GPSMap
                latitude={gpsData.latitude!}
                longitude={gpsData.longitude!}
                altitude={gpsData.altitude}
              />
            </CollapsibleSection>
          )}

          {hasOtherExif && (
            <CollapsibleSection title="All EXIF Data" defaultOpen={false}>
              <div className="flex flex-col gap-1">
                {otherExifEntries.map(([tag, value]) => (
                  <MetadataItem key={tag} label={formatExifTag(tag)} value={value} />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {!keyCameraSettings.length && !hasOtherExif && (
            <p className="text-xs text-center text-text-secondary mt-4">
              No EXIF data found in this file.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
