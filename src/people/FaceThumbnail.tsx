import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanFace } from 'lucide-react';
import { faceThumbnail, usePeopleStore } from './store';
export default memo(function FaceThumbnail({
  id,
  onOpen,
  label,
}: {
  id: string;
  onOpen?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const version = usePeopleStore((s) => s.thumbnailVersion);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSource(null);
    setFailed(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void faceThumbnail(id)
            .then((url) => {
              if (alive) setSource(url);
            })
            .catch(() => {
              if (alive) setFailed(true);
            });
        }
      },
      { rootMargin: '160px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [id, version, attempt]);
  return (
    <div
      ref={ref}
      className="aspect-square w-full rounded-md overflow-hidden bg-surface flex items-center justify-center"
    >
      {source ? (
        onOpen ? (
          <button className="w-full h-full" onClick={onOpen} aria-label={label}>
            <img draggable={false} src={source} alt="" className="w-full h-full object-cover" />
          </button>
        ) : (
          <img draggable={false} src={source} alt="" className="w-full h-full object-cover" />
        )
      ) : failed ? (
        <button
          className="p-2 text-xs"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setAttempt((n) => n + 1);
          }}
        >
          {t('people.retry')}
        </button>
      ) : onOpen ? (
        <button className="w-full h-full flex items-center justify-center" onClick={onOpen} aria-label={label}>
          <ScanFace size={24} className="text-text-secondary" />
        </button>
      ) : (
        <ScanFace size={24} className="text-text-secondary" />
      )}
    </div>
  );
});
