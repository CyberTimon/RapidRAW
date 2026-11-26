import { useEffect, useRef } from 'react';

const sections = new WeakMap<Element, { wrapper: HTMLDivElement; isOpen: boolean }>();

const observer = new ResizeObserver((entries) => {
  const heights = entries.flatMap((entry) => {
    const section = sections.get(entry.target);
    return section?.isOpen ? [[section.wrapper, (entry.target as HTMLElement).scrollHeight] as const] : [];
  });
  heights.forEach(([wrapper, height]) => {
    wrapper.style.height = `${height}px`;
  });
});

export function useCollapsibleHeight(isOpen: boolean) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) {
      return;
    }

    sections.set(content, { wrapper, isOpen });
    if (!isOpen) {
      wrapper.style.height = '0px';
    }
    observer.observe(content);

    return () => {
      observer.unobserve(content);
      sections.delete(content);
    };
  }, [isOpen]);

  return { contentRef, wrapperRef };
}
