import { useEffect, useRef } from 'react';

export function useCollapsibleHeight(isOpen: boolean) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) {
      return;
    }

    const updateHeight = () => {
      if (isOpen) {
        const contentHeight = content.scrollHeight;
        wrapper.style.height = `${contentHeight}px`;
      } else {
        wrapper.style.height = '0px';
      }
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(content);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  return { contentRef, wrapperRef };
}
