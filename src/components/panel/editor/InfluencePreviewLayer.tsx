import type { CSSProperties } from 'react';
/** Opaque diagnostic pixels isolate over both JPEG and native GPU presentation. */
export default function InfluencePreviewLayer({ url, style }: { url: string; style: CSSProperties }) {
  return <img alt="" aria-hidden src={url} className="absolute pointer-events-none" style={style} />;
}
