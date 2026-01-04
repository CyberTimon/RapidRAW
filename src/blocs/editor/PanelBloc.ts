import { Cubit } from '@blac/core';

export type PanelId = 'adjustments' | 'crop' | 'masks' | 'presets' | 'export' | 'metadata' | 'ai';

interface PanelState {
  activePanel: PanelId;
  previousPanel: PanelId | null;
}

export class PanelBloc extends Cubit<PanelState> {
  constructor() {
    super({
      activePanel: 'adjustments',
      previousPanel: null,
    });
  }

  setActivePanel = (panelId: PanelId) => {
    if (panelId === this.state.activePanel) return;

    this.emit({
      activePanel: panelId,
      previousPanel: this.state.activePanel,
    });
  };

  goBack = () => {
    if (this.state.previousPanel) {
      this.emit({
        activePanel: this.state.previousPanel,
        previousPanel: null,
      });
    }
  };

  resetToDefault = () => {
    this.emit({
      activePanel: 'adjustments',
      previousPanel: null,
    });
  };
}
