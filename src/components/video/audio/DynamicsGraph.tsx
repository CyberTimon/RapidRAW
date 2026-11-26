import { compressedDb, compressorOf } from '../../../utils/video/sound';

const SIZE = 64;
const PAD = 4;
const FLOOR_DB = -48;
const SAMPLES = 48;

const at = (db: number) => PAD + (1 - (Math.max(FLOOR_DB, Math.min(0, db)) - FLOOR_DB) / -FLOOR_DB) * (SIZE - 2 * PAD);
const across = (db: number) => SIZE - at(db);

export default function DynamicsGraph({ amount }: { amount: number }) {
  const compressor = compressorOf(amount);
  const path = Array.from({ length: SAMPLES + 1 }, (_, index) => {
    const input = FLOOR_DB - (FLOOR_DB * index) / SAMPLES;
    const output = amount > 0 ? compressedDb(compressor, input) : input;
    return `${index === 0 ? 'M' : 'L'}${across(input).toFixed(1)},${at(output).toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-16 h-16 shrink-0 rounded-md bg-bg-primary" aria-hidden>
      <g className="text-text-secondary">
        {[-12, -24, -36].map((db) => (
          <g key={db} stroke="currentColor" strokeOpacity={0.12} strokeWidth={0.5}>
            <line x1={PAD} x2={SIZE - PAD} y1={at(db)} y2={at(db)} />
            <line x1={across(db)} x2={across(db)} y1={PAD} y2={SIZE - PAD} />
          </g>
        ))}
        <line
          x1={across(FLOOR_DB)}
          y1={at(FLOOR_DB)}
          x2={across(0)}
          y2={at(0)}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={0.75}
          strokeDasharray="2 2"
        />
      </g>
      {amount > 0 && (
        <circle
          cx={across(compressor.threshold)}
          cy={at(compressedDb(compressor, compressor.threshold))}
          r={2}
          className="text-text-primary"
          fill="currentColor"
        />
      )}
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        className="text-accent"
        strokeWidth={1.75}
        strokeLinejoin="round"
      />
    </svg>
  );
}
