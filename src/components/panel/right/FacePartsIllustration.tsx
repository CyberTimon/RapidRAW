import { useId } from 'react';
import { FacePart } from './Masks';

interface FacePartsIllustrationProps {
  selected: Array<string>;
}

const EYES =
  'M81.5 64.5 C 84 61 90 60.5 93.5 64 C 90 66.8 84.5 67 81.5 64.5 Z M118.5 64.5 C 116 61 110 60.5 106.5 64 C 110 66.8 115.5 67 118.5 64.5 Z';

const LAYERS: Array<{ part: FacePart | null; d: string; shade: number; clip?: boolean }> = [
  { part: null, d: 'M11 180 C 16.5 143.5 53 125 81 122 L 119 122 C 147 125 183.5 143.5 189 180 Z', shade: 12 },
  {
    part: 'bodySkin',
    d: 'M85 95 L 115 95 L 115.5 117.5 C 122 119.5 127.5 122 131 125 C 122 137 111.5 141 100 141 C 88.5 141 78 137 69 125 C 72.5 122 78 119.5 84.5 117.5 Z',
    shade: 28,
  },
  {
    part: null,
    d: 'M65 73 a 4 8.5 0 1 0 8 0 a 4 8.5 0 1 0 -8 0 Z M127 73 a 4 8.5 0 1 0 8 0 a 4 8.5 0 1 0 -8 0 Z',
    shade: 28,
  },
  {
    part: 'faceSkin',
    d: 'M100 27.5 C 117.5 27.5 129.5 38.5 130.5 56.5 C 131 71 129 82 123.5 91 C 117.5 100.5 109 106.5 100 106.5 C 91 106.5 82.5 100.5 76.5 91 C 71 82 69 71 69.5 56.5 C 70.5 38.5 82.5 27.5 100 27.5 Z',
    shade: 28,
  },
  {
    part: 'hair',
    d: 'M69.5 62 C 67.8 51 68 41 72.5 33.5 C 77.5 25 87 20 98 19.5 C 102 18 108 18 112.5 19.5 C 121.5 21.5 128 27 130.5 34.5 C 132.5 42 132.4 52 130.5 62 C 129.6 56 128.3 51.5 126.3 48 C 124 44.2 120.5 42 116 41.2 C 110 40.2 103 39.4 96.5 39.8 C 90 40.2 84 41.8 79.5 45 C 75.5 48 72.2 54 69.5 62 Z',
    shade: 50,
  },
  {
    part: 'eyebrows',
    d: 'M79 58.4 C 83.5 55.8 89.5 55.2 95.2 56.3 L 95.1 58.3 C 89.5 57.3 84 57.7 79.5 60 Z M121 58.4 C 116.5 55.8 110.5 55.2 104.8 56.3 L 104.9 58.3 C 110.5 57.3 116 57.7 120.5 60 Z',
    shade: 62,
  },
  { part: 'eyeWhites', d: EYES, shade: 52 },
  {
    part: 'iris',
    d: 'M85 63.9 a 2.6 2.6 0 1 0 5.2 0 a 2.6 2.6 0 1 0 -5.2 0 Z M109.8 63.9 a 2.6 2.6 0 1 0 5.2 0 a 2.6 2.6 0 1 0 -5.2 0 Z',
    shade: 75,
    clip: true,
  },
  {
    part: null,
    d: 'M86.5 63.9 a 1.1 1.1 0 1 0 2.2 0 a 1.1 1.1 0 1 0 -2.2 0 Z M111.3 63.9 a 1.1 1.1 0 1 0 2.2 0 a 1.1 1.1 0 1 0 -2.2 0 Z',
    shade: 0,
    clip: true,
  },
  {
    part: 'nose',
    d: 'M99.1 66 C 99 72 97.8 76 95.8 79.4 C 94.6 81 95.2 83.1 96.9 83.3 C 98.3 84.2 101.7 84.2 103.1 83.3 C 104.8 83.1 105.4 81 104.2 79.4 C 102.2 76 101 72 100.9 66 Z',
    shade: 36,
  },
  {
    part: 'lips',
    d: 'M89 91.4 C 92 90.2 95 89.2 97.6 89.4 C 98.6 89.5 99.3 89.9 100 89.9 C 100.7 89.9 101.4 89.5 102.4 89.4 C 105 89.2 108 90.2 111 91.4 C 107.5 91.9 103.8 92.1 100 92.1 C 96.2 92.1 92.5 91.9 89 91.4 Z M89 91.4 C 92.5 91.9 96.2 92.1 100 92.1 C 103.8 92.1 107.5 91.9 111 91.4 C 109.4 95 105.2 96.6 100 96.6 C 94.8 96.6 90.6 95 89 91.4 Z',
    shade: 58,
  },
  {
    part: 'teeth',
    d: 'M90.8 91.9 C 93.9 92.3 97 92.5 100 92.5 C 103 92.5 106.1 92.3 109.2 91.9 C 107.7 93.3 104.2 94 100 94 C 95.8 94 92.3 93.3 90.8 91.9 Z',
    shade: 40,
  },
];

export default function FacePartsIllustration({ selected }: FacePartsIllustrationProps) {
  const clipId = useId();

  return (
    <svg viewBox="22 12 156 168" className="w-full max-w-[160px] mx-auto block pointer-events-none">
      <defs>
        <clipPath id={clipId}>
          <path d={EYES} />
        </clipPath>
      </defs>
      {LAYERS.map(({ part, d, shade, clip }) => (
        <path
          key={d}
          d={d}
          strokeWidth={0.8}
          strokeLinejoin="round"
          clipPath={clip ? `url(#${clipId})` : undefined}
          style={{
            fill:
              part && selected.includes(part)
                ? 'var(--color-accent)'
                : `color-mix(in srgb, var(--color-text-secondary) ${shade}%, var(--color-surface))`,
          }}
          className={part ? 'stroke-surface transition-colors' : undefined}
        />
      ))}
    </svg>
  );
}
