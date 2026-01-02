import { Cubit } from '@blac/core';

export interface UIState {
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  isResizing: boolean;
  isLibraryExportPanelVisible: boolean;
  libraryScrollTop: number;
  isAnimatingTheme: boolean;
  isWindowFullScreen: boolean;
}

const INITIAL_STATE: UIState = {
  leftPanelWidth: 256,
  rightPanelWidth: 320,
  bottomPanelHeight: 144,
  isResizing: false,
  isLibraryExportPanelVisible: false,
  libraryScrollTop: 0,
  isAnimatingTheme: false,
  isWindowFullScreen: false,
};

export class UICubit extends Cubit<UIState> {
  constructor() {
    super(INITIAL_STATE);
  }

  setLeftPanelWidth = (width: number) => {
    this.patch({ leftPanelWidth: Math.max(200, Math.min(width, 500)) });
  };

  setRightPanelWidth = (width: number) => {
    this.patch({ rightPanelWidth: Math.max(280, Math.min(width, 600)) });
  };

  setBottomPanelHeight = (height: number) => {
    this.patch({ bottomPanelHeight: Math.max(100, Math.min(height, 400)) });
  };

  setIsResizing = (isResizing: boolean) => {
    this.patch({ isResizing });
  };

  setIsLibraryExportPanelVisible = (visible: boolean) => {
    this.patch({ isLibraryExportPanelVisible: visible });
  };

  setLibraryScrollTop = (scrollTop: number) => {
    this.patch({ libraryScrollTop: scrollTop });
  };

  setIsAnimatingTheme = (animating: boolean) => {
    this.patch({ isAnimatingTheme: animating });
  };

  setIsWindowFullScreen = (fullScreen: boolean) => {
    this.patch({ isWindowFullScreen: fullScreen });
  };

  startResize = () => {
    this.patch({ isResizing: true });
  };

  endResize = () => {
    this.patch({ isResizing: false });
  };

  resetScrollPosition = () => {
    this.patch({ libraryScrollTop: 0 });
  };

  createResizeHandler = (
    panelType: 'left' | 'right' | 'bottom',
    startSize: number
  ) => (e: MouseEvent) => {
    e.preventDefault();
    this.setIsResizing(true);
    const startX = e.clientX;
    const startY = e.clientY;

    const doDrag = (moveEvent: MouseEvent) => {
      if (panelType === 'left') {
        this.setLeftPanelWidth(startSize + (moveEvent.clientX - startX));
      } else if (panelType === 'right') {
        this.setRightPanelWidth(startSize - (moveEvent.clientX - startX));
      } else if (panelType === 'bottom') {
        this.setBottomPanelHeight(startSize - (moveEvent.clientY - startY));
      }
    };

    const stopDrag = () => {
      document.documentElement.style.cursor = '';
      window.removeEventListener('mousemove', doDrag);
      window.removeEventListener('mouseup', stopDrag);
      this.setIsResizing(false);
    };

    document.documentElement.style.cursor = panelType === 'bottom' ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', doDrag);
    window.addEventListener('mouseup', stopDrag);
  };
}
