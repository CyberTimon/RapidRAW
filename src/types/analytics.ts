export interface HistogramData {
  red: number[];
  green: number[];
  blue: number[];
  luma: number[];
}

export interface CurveInputHistogram {
  maskId: string | null;
  histogram: HistogramData;
}
