import { Cubit } from '@blac/core';

interface UIPanelState {
  visible: boolean;
  size: number;
  collapsed: boolean;
}

interface UIState {
  leftSidebar: UIPanelState;
  rightPanel: UIPanelState;
  bottomPanel: UIPanelState;
  isResizing: boolean;
}

export class UIBloc extends Cubit<UIState> {
  constructor() {
    super({
      leftSidebar: { visible: true, size: 256, collapsed: false },
      rightPanel: { visible: true, size: 320, collapsed: false },
      bottomPanel: { visible: true, size: 144, collapsed: false },
      isResizing: false,
    });
  }

  toggleLeftSidebar = () => {
    this.emit({
      ...this.state,
      leftSidebar: { ...this.state.leftSidebar, visible: !this.state.leftSidebar.visible },
    });
  };

  toggleRightPanel = () => {
    this.emit({
      ...this.state,
      rightPanel: { ...this.state.rightPanel, visible: !this.state.rightPanel.visible },
    });
  };

  toggleBottomPanel = () => {
    this.emit({
      ...this.state,
      bottomPanel: { ...this.state.bottomPanel, visible: !this.state.bottomPanel.visible },
    });
  };

  collapseLeftSidebar = () => {
    this.emit({
      ...this.state,
      leftSidebar: { ...this.state.leftSidebar, collapsed: true },
    });
  };

  expandLeftSidebar = () => {
    this.emit({
      ...this.state,
      leftSidebar: { ...this.state.leftSidebar, collapsed: false },
    });
  };

  collapseRightPanel = () => {
    this.emit({
      ...this.state,
      rightPanel: { ...this.state.rightPanel, collapsed: true },
    });
  };

  expandRightPanel = () => {
    this.emit({
      ...this.state,
      rightPanel: { ...this.state.rightPanel, collapsed: false },
    });
  };

  collapseBottomPanel = () => {
    this.emit({
      ...this.state,
      bottomPanel: { ...this.state.bottomPanel, collapsed: true },
    });
  };

  expandBottomPanel = () => {
    this.emit({
      ...this.state,
      bottomPanel: { ...this.state.bottomPanel, collapsed: false },
    });
  };

  setLeftSidebarSize = (size: number) => {
    this.emit({
      ...this.state,
      leftSidebar: {
        ...this.state.leftSidebar,
        size: Math.max(200, Math.min(500, size)),
      },
    });
  };

  setRightPanelSize = (size: number) => {
    this.emit({
      ...this.state,
      rightPanel: {
        ...this.state.rightPanel,
        size: Math.max(280, Math.min(600, size)),
      },
    });
  };

  setBottomPanelSize = (size: number) => {
    this.emit({
      ...this.state,
      bottomPanel: {
        ...this.state.bottomPanel,
        size: Math.max(100, Math.min(400, size)),
      },
    });
  };

  setResizing = (isResizing: boolean) => {
    this.patch({ isResizing });
  };

  get isLeftSidebarVisible() {
    return this.state.leftSidebar.visible && !this.state.leftSidebar.collapsed;
  }

  get isRightPanelVisible() {
    return this.state.rightPanel.visible && !this.state.rightPanel.collapsed;
  }

  get isBottomPanelVisible() {
    return this.state.bottomPanel.visible && !this.state.bottomPanel.collapsed;
  }
}
