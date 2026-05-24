import { useRef, useEffect, useCallback } from 'react';
import type { RenderSize } from '../../../hooks/useImageRenderSize';
import type { InteractivePatch } from '../../../store/useEditorStore';

interface TransformState {
  positionX: number;
  positionY: number;
  scale: number;
}

interface Options {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  baseUrl: string | null;
  fadeUrl: string | null;
  patch: InteractivePatch | null;
  transformRef: React.RefObject<TransformState>;
  imageRenderSizeRef: React.RefObject<RenderSize>;
  isMaxZoomRef: React.RefObject<boolean>;
  enabled: boolean;
}

export function usePreviewCanvas({
  canvasRef,
  containerRef,
  baseUrl,
  fadeUrl,
  patch,
  transformRef,
  imageRenderSizeRef,
  isMaxZoomRef,
  enabled,
}: Options) {
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const fadeImgRef = useRef<HTMLImageElement | null>(null);
  const patchImgRef = useRef<HTMLImageElement | null>(null);
  const fadeOpacityRef = useRef(0);
  const fadeAnimRef = useRef<number | null>(null);
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const drawRef = useRef<() => void>(() => {});

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !enabled) return;

    const dpr = window.devicePixelRatio || 1;
    const cW = container.clientWidth;
    const cH = container.clientHeight;

    const targetW = Math.round(cW * dpr);
    const targetH = Math.round(cH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${cW}px`;
      canvas.style.height = `${cH}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { positionX: tx, positionY: ty, scale: s } = transformRef.current;
    const { width: rW, height: rH, offsetX: oX, offsetY: oY } = imageRenderSizeRef.current;
    if (rW <= 0 || rH <= 0) return;

    // Image bounds in container CSS pixels, accounting for the CSS transform on contentRef
    const imgL = tx + oX * s;
    const imgT = ty + oY * s;
    const imgScaledW = rW * s;
    const imgScaledH = rH * s;

    // Clip to container bounds
    const visL = Math.max(0, imgL);
    const visT = Math.max(0, imgT);
    const visR = Math.min(cW, imgL + imgScaledW);
    const visB = Math.min(cH, imgT + imgScaledH);
    if (visR <= visL || visB <= visT) return;

    ctx.imageSmoothingEnabled = !isMaxZoomRef.current;
    ctx.imageSmoothingQuality = 'high';

    const drawLayer = (img: HTMLImageElement, alpha: number) => {
      if (alpha <= 0) return;
      // Map visible container region back to source natural pixels
      const srcX = ((visL - imgL) / imgScaledW) * img.naturalWidth;
      const srcY = ((visT - imgT) / imgScaledH) * img.naturalHeight;
      const srcW = ((visR - visL) / imgScaledW) * img.naturalWidth;
      const srcH = ((visB - visT) / imgScaledH) * img.naturalHeight;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, srcX, srcY, srcW, srcH, visL * dpr, visT * dpr, (visR - visL) * dpr, (visB - visT) * dpr);
    };

    if (baseImgRef.current) drawLayer(baseImgRef.current, 1);
    if (fadeImgRef.current && fadeOpacityRef.current > 0) drawLayer(fadeImgRef.current, fadeOpacityRef.current);
    ctx.globalAlpha = 1;

    const p = patchRef.current;
    if (patchImgRef.current && p) {
      const pImg = patchImgRef.current;
      const pL = imgL + p.normX * imgScaledW;
      const pT = imgT + p.normY * imgScaledH;
      const pW = p.normW * imgScaledW;
      const pH = p.normH * imgScaledH;
      const pVisL = Math.max(visL, pL);
      const pVisT = Math.max(visT, pT);
      const pVisR = Math.min(visR, pL + pW);
      const pVisB = Math.min(visB, pT + pH);
      if (pVisR > pVisL && pVisB > pVisT) {
        ctx.drawImage(
          pImg,
          ((pVisL - pL) / pW) * pImg.naturalWidth,
          ((pVisT - pT) / pH) * pImg.naturalHeight,
          ((pVisR - pVisL) / pW) * pImg.naturalWidth,
          ((pVisB - pVisT) / pH) * pImg.naturalHeight,
          pVisL * dpr,
          pVisT * dpr,
          (pVisR - pVisL) * dpr,
          (pVisB - pVisT) * dpr,
        );
      }
    }
  }, [canvasRef, containerRef, transformRef, imageRenderSizeRef, isMaxZoomRef, enabled]);

  drawRef.current = draw;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!baseUrl) {
      baseImgRef.current = null;
      draw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      baseImgRef.current = img;
      draw();
    };
    img.src = baseUrl;
  }, [baseUrl, draw]);

  useEffect(() => {
    if (fadeAnimRef.current) {
      cancelAnimationFrame(fadeAnimRef.current);
      fadeAnimRef.current = null;
    }
    if (!fadeUrl) {
      fadeImgRef.current = null;
      fadeOpacityRef.current = 0;
      return;
    }
    const img = new Image();
    img.onload = () => {
      fadeImgRef.current = img;
      fadeOpacityRef.current = 0;
      const t0 = performance.now();
      const animate = (now: number) => {
        fadeOpacityRef.current = Math.min((now - t0) / 150, 1);
        draw();
        if (fadeOpacityRef.current < 1) {
          fadeAnimRef.current = requestAnimationFrame(animate);
        }
      };
      fadeAnimRef.current = requestAnimationFrame(animate);
    };
    img.src = fadeUrl;
    return () => {
      if (fadeAnimRef.current) {
        cancelAnimationFrame(fadeAnimRef.current);
        fadeAnimRef.current = null;
      }
    };
  }, [fadeUrl, draw]);

  useEffect(() => {
    if (!patch?.url) {
      patchImgRef.current = null;
      draw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      patchImgRef.current = img;
      draw();
    };
    img.src = patch.url;
  }, [patch?.url, draw]);

  useEffect(() => {
    draw();
  }, [enabled, draw]);

  return { draw };
}
