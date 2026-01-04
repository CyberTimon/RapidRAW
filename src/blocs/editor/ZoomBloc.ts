import { Cubit } from '@blac/core';
import type { ZoomState } from '../../types/editor.js';

interface ZoomBlocState extends ZoomState {
  minScale: number;
  maxScale: number;
  fitScale: number;
  zoomSteps: number[];
}

export class ZoomBloc extends Cubit<ZoomBlocState> {
  constructor() {
    super({
      scale: 1,
      positionX: 0,
      positionY: 0,
      isFullResolution: false,
      isLoadingFullRes: false,
      minScale: 0.1,
      maxScale: 16,
      fitScale: 1,
      zoomSteps: [0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16],
    });
  }

  setScale = (scale: number) => {
    const clampedScale = Math.max(
      this.state.minScale,
      Math.min(this.state.maxScale, scale)
    );
    this.patch({ scale: clampedScale });
  };

  setPosition = (x: number, y: number) => {
    this.patch({ positionX: x, positionY: y });
  };

  pan = (deltaX: number, deltaY: number) => {
    this.patch({
      positionX: this.state.positionX + deltaX,
      positionY: this.state.positionY + deltaY,
    });
  };

  zoomIn = () => {
    const { scale, zoomSteps, maxScale } = this.state;
    const nextStep = zoomSteps.find((s) => s > scale);
    this.setScale(nextStep ?? maxScale);
  };

  zoomOut = () => {
    const { scale, zoomSteps, minScale } = this.state;
    const prevStep = [...zoomSteps].reverse().find((s) => s < scale);
    this.setScale(prevStep ?? minScale);
  };

  zoomToFit = () => {
    this.patch({
      scale: this.state.fitScale,
      positionX: 0,
      positionY: 0,
    });
  };

  zoomToActual = () => {
    this.patch({
      scale: 1,
      positionX: 0,
      positionY: 0,
    });
  };

  zoomToFill = (containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) => {
    const scaleX = containerWidth / imageWidth;
    const scaleY = containerHeight / imageHeight;
    const scale = Math.max(scaleX, scaleY);
    this.setScale(scale);
  };

  zoomToPoint = (scale: number, pointX: number, pointY: number) => {
    const { scale: currentScale, positionX, positionY } = this.state;
    const ratio = scale / currentScale;

    this.patch({
      scale: Math.max(this.state.minScale, Math.min(this.state.maxScale, scale)),
      positionX: pointX - (pointX - positionX) * ratio,
      positionY: pointY - (pointY - positionY) * ratio,
    });
  };

  wheelZoom = (delta: number, centerX: number, centerY: number) => {
    const zoomFactor = delta > 0 ? 0.9 : 1.1;
    const newScale = this.state.scale * zoomFactor;
    this.zoomToPoint(newScale, centerX, centerY);
  };

  setFitScale = (containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) => {
    if (imageWidth === 0 || imageHeight === 0) return;

    const scaleX = containerWidth / imageWidth;
    const scaleY = containerHeight / imageHeight;
    const fitScale = Math.min(scaleX, scaleY);

    this.patch({ fitScale });
  };

  setFullResolution = (isFullRes: boolean) => {
    this.patch({ isFullResolution: isFullRes });
  };

  setLoadingFullRes = (isLoading: boolean) => {
    this.patch({ isLoadingFullRes: isLoading });
  };

  reset = () => {
    this.emit({
      scale: 1,
      positionX: 0,
      positionY: 0,
      isFullResolution: false,
      isLoadingFullRes: false,
      minScale: 0.1,
      maxScale: 16,
      fitScale: 1,
      zoomSteps: this.state.zoomSteps,
    });
  };

  constrainPosition = (containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) => {
    const { scale, positionX, positionY } = this.state;
    const scaledWidth = imageWidth * scale;
    const scaledHeight = imageHeight * scale;

    let newX = positionX;
    let newY = positionY;

    if (scaledWidth <= containerWidth) {
      newX = 0;
    } else {
      const maxX = (scaledWidth - containerWidth) / 2;
      newX = Math.max(-maxX, Math.min(maxX, positionX));
    }

    if (scaledHeight <= containerHeight) {
      newY = 0;
    } else {
      const maxY = (scaledHeight - containerHeight) / 2;
      newY = Math.max(-maxY, Math.min(maxY, positionY));
    }

    if (newX !== positionX || newY !== positionY) {
      this.patch({ positionX: newX, positionY: newY });
    }
  };

  get zoomPercentage(): number {
    return Math.round(this.state.scale * 100);
  }

  get isFitMode(): boolean {
    return Math.abs(this.state.scale - this.state.fitScale) < 0.001;
  }

  get isActualSize(): boolean {
    return Math.abs(this.state.scale - 1) < 0.001;
  }

  get canZoomIn(): boolean {
    return this.state.scale < this.state.maxScale;
  }

  get canZoomOut(): boolean {
    return this.state.scale > this.state.minScale;
  }
}
