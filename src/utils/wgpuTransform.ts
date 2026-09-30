export function wgpuTransformRequest<T extends object>(payload: T, expectedGeneration: number) {
  const scopedPayload = { ...payload, expectedGeneration };
  return { key: JSON.stringify(scopedPayload), payload: scopedPayload };
}

export function wgpuTransformGeneration(backendGeneration: number | null) {
  return backendGeneration ?? 0;
}
