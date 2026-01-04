import { Cubit } from '@blac/core';

interface FullscreenState {
  isFullscreen: boolean;
  showUI: boolean;
  autoHideUI: boolean;
  autoHideDelay: number;
  cursorHidden: boolean;
}

export class FullscreenBloc extends Cubit<FullscreenState> {
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super({
      isFullscreen: false,
      showUI: true,
      autoHideUI: true,
      autoHideDelay: 3000,
      cursorHidden: false,
    });
  }

  enterFullscreen = async () => {
    try {
      if (document.fullscreenElement) return;

      await document.documentElement.requestFullscreen();
      this.patch({ isFullscreen: true });
      this.startAutoHide();
    } catch (error) {
      console.error('Failed to enter fullscreen:', error);
    }
  };

  exitFullscreen = async () => {
    try {
      if (!document.fullscreenElement) return;

      await document.exitFullscreen();
      this.patch({
        isFullscreen: false,
        showUI: true,
        cursorHidden: false,
      });
      this.stopAutoHide();
    } catch (error) {
      console.error('Failed to exit fullscreen:', error);
    }
  };

  toggleFullscreen = () => {
    if (this.state.isFullscreen) {
      this.exitFullscreen();
    } else {
      this.enterFullscreen();
    }
  };

  setShowUI = (show: boolean) => {
    this.patch({ showUI: show, cursorHidden: !show });

    if (show && this.state.autoHideUI && this.state.isFullscreen) {
      this.startAutoHide();
    }
  };

  toggleUI = () => {
    this.setShowUI(!this.state.showUI);
  };

  setAutoHideUI = (enabled: boolean) => {
    this.patch({ autoHideUI: enabled });

    if (!enabled) {
      this.stopAutoHide();
      this.patch({ showUI: true, cursorHidden: false });
    }
  };

  setAutoHideDelay = (delay: number) => {
    this.patch({ autoHideDelay: Math.max(500, delay) });
  };

  onMouseMove = () => {
    if (!this.state.isFullscreen || !this.state.autoHideUI) return;

    this.patch({ showUI: true, cursorHidden: false });
    this.startAutoHide();
  };

  private startAutoHide = () => {
    this.stopAutoHide();

    if (!this.state.autoHideUI) return;

    this.hideTimer = setTimeout(() => {
      this.patch({ showUI: false });
    }, this.state.autoHideDelay);

    this.cursorTimer = setTimeout(() => {
      this.patch({ cursorHidden: true });
    }, this.state.autoHideDelay + 500);
  };

  private stopAutoHide = () => {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
  };

  syncWithBrowserState = () => {
    const isActuallyFullscreen = !!document.fullscreenElement;
    if (this.state.isFullscreen !== isActuallyFullscreen) {
      this.patch({
        isFullscreen: isActuallyFullscreen,
        showUI: true,
        cursorHidden: false,
      });

      if (!isActuallyFullscreen) {
        this.stopAutoHide();
      }
    }
  };

  reset = () => {
    this.stopAutoHide();
    this.emit({
      isFullscreen: false,
      showUI: true,
      autoHideUI: true,
      autoHideDelay: 3000,
      cursorHidden: false,
    });
  };

  get shouldHideCursor(): boolean {
    return this.state.isFullscreen && this.state.cursorHidden;
  }

  get shouldShowControls(): boolean {
    return !this.state.isFullscreen || this.state.showUI;
  }
}
