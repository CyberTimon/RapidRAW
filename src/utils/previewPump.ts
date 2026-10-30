/** One render in flight; sample the latest immutable recipe after completion. */
export function startPreviewPump<T>(
  read: () => T,
  render: (sample: T) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let live = true;
  let previous: T;
  let sampled = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (!live) return;
    const sample = read();
    if (!sampled || sample !== previous) {
      previous = sample;
      sampled = true;
      try {
        await render(sample);
      } catch (error) {
        onError(error);
      }
    }
    if (live) timer = setTimeout(tick, 16);
  };
  void tick();
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
