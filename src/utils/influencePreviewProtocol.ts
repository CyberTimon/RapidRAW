import { sameInfluenceIdentity, type InfluenceIdentity } from './influencePreviewState';

export function decodeInfluencePreview(buffer: ArrayBuffer, expected: InfluenceIdentity, generation: number) {
  if (buffer.byteLength < 8 || buffer.byteLength > 80 * 1024 * 1024) throw new Error('Invalid influence response size');
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIF1') throw new Error('Unsupported influence response');
  const length = new DataView(buffer).getUint32(4, true);
  if (length > 16384 || length + 8 + 24 > bytes.length) throw new Error('Invalid influence header');
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length)));
  if (
    !metadata.identity ||
    !sameInfluenceIdentity(metadata.identity, expected) ||
    metadata.generation !== generation ||
    metadata.status !== 'ready'
  )
    throw new Error('Stale influence response');
  const png = bytes.subarray(8 + length);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => png[i] === v)) throw new Error('Invalid influence PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    width !== metadata.width ||
    height !== metadata.height ||
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > 16_777_216
  )
    throw new Error('Invalid influence dimensions');
  return new Blob([png], { type: 'image/png' });
}
