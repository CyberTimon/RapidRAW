import { useEffect, useMemo, useRef, useState } from 'react';

function landscapeGrid(count: number): { rows: number; cols: number } {
  if (count <= 1) return { rows: 1, cols: 1 };
  if (count <= 3) return { rows: 1, cols: count };
  const target = 1.25;
  let best = { rows: 1, cols: count, score: Number.POSITIVE_INFINITY };
  for (let rows = 1; rows <= count; rows++) {
    const cols = Math.ceil(count / rows);
    const empty = rows * cols - count;
    const ratio = cols / rows;
    const score = empty + 3 * Math.abs(Math.log(ratio / target));
    const longer = Math.max(rows, cols);
    const bestLonger = Math.max(best.rows, best.cols);
    const closer =
      score < best.score - 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && (longer < bestLonger || (longer === bestLonger && cols > best.cols)));
    if (closer) best = { rows, cols, score };
  }
  return { rows: best.rows, cols: best.cols };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PrintPlace {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  z: number;
}

const PRINT_COVERAGE = 1.45;
const PRINT_JITTER = 0.25;

function placePrints(count: number, landscape: boolean, boxW: number, boxH: number): PrintPlace[] {
  if (count === 0 || boxW <= 0 || boxH <= 0) return [];
  if (count === 1) {
    const aspect = landscape ? 3 / 2 : 2 / 3;
    let width = boxW * 0.86;
    let height = width / aspect;
    if (height > boxH * 0.86) {
      height = boxH * 0.86;
      width = height * aspect;
    }
    const tilt = mulberry32(1)() * 2 - 1;
    return [
      {
        left: (boxW - width) / 2,
        top: (boxH - height) / 2,
        width,
        height,
        rotate: tilt * tilt * tilt * 8,
        z: 1,
      },
    ];
  }
  const grid = landscapeGrid(count);
  const rows = landscape ? grid.rows : grid.cols;
  const cols = landscape ? grid.cols : grid.rows;
  const cellW = boxW / cols;
  const cellH = boxH / rows;
  const photoAspect = landscape ? 3 / 2 : 2 / 3;
  let printW = cellW * PRINT_COVERAGE;
  let printH = printW / photoAspect;
  if (printH < cellH * PRINT_COVERAGE) {
    printH = cellH * PRINT_COVERAGE;
    printW = printH * photoAspect;
  }
  const cap = Math.min(1, (boxW * 0.78) / printW, (boxH * 0.72) / printH);
  printW *= cap;
  printH *= cap;
  const rand = mulberry32(count * 997);
  const cells = Array.from({ length: rows * cols }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const used = cells.slice(0, count);
  const stack = used.map((_, i) => i);
  for (let i = stack.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [stack[i], stack[j]] = [stack[j], stack[i]];
  }
  return used.map((cell, i) => {
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const jx = (rand() - 0.5) * 2 * PRINT_JITTER * cellW;
    const jy = (rand() - 0.5) * 2 * PRINT_JITTER * cellH;
    const tilt = rand() * 2 - 1;
    const cx = (col + 0.5) * cellW + jx;
    const cy = (row + 0.5) * cellH + jy;
    return {
      left: cx - printW / 2,
      top: cy - printH / 2,
      width: printW,
      height: printH,
      rotate: tilt * tilt * tilt * 15,
      z: stack[i],
    };
  });
}

export default function LoadingCollage({ urls }: { urls: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [landscape, setLandscape] = useState(true);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const signature = urls.join('\0');
  useEffect(() => {
    let cancelled = false;
    let pending = urls.length;
    if (pending === 0) return;
    let wide = 0;
    let tall = 0;
    const finish = () => {
      pending -= 1;
      if (!cancelled && pending === 0) setLandscape(wide >= tall);
    };
    const images = urls.map((url) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth >= img.naturalHeight) wide += 1;
        else tall += 1;
        finish();
      };
      img.onerror = finish;
      img.src = url;
      return img;
    });
    return () => {
      cancelled = true;
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [signature]);
  const places = useMemo(
    () => placePrints(urls.length, landscape, box.w, box.h),
    [urls.length, landscape, box.w, box.h],
  );
  return (
    <div ref={boxRef} className="absolute inset-0">
      {urls.map((url, i) => {
        const place = places[i];
        if (!place) return null;
        return (
          <div
            key={`${url}-${i}`}
            className="absolute bg-white shadow-[0_8px_18px_rgba(0,0,0,0.45)]"
            style={{
              left: place.left,
              top: place.top,
              width: place.width,
              height: place.height,
              zIndex: place.z,
              padding: 3,
              transform: `rotate(${place.rotate}deg)`,
            }}
          >
            <img src={url} alt="" className="h-full w-full object-contain" />
          </div>
        );
      })}
    </div>
  );
}
