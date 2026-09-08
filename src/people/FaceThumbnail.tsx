import { memo, useEffect, useRef, useState } from 'react';
import { ScanFace } from 'lucide-react';
import { faceThumbnail } from './store';
export default memo(function FaceThumbnail({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSource(null);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void faceThumbnail(id)
            .then((url) => {
              if (alive) setSource(url);
            })
            .catch(() => {});
        }
      },
      { rootMargin: '160px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [id]);
  return (
    <div
      ref={ref}
      className="aspect-square w-full rounded-md overflow-hidden bg-surface flex items-center justify-center"
    >
      {source ? (
        <img src={source} alt="" className="w-full h-full object-cover" />
      ) : (
        <ScanFace size={24} className="text-text-secondary" />
      )}
    </div>
  );
});
