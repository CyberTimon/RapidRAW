import { Cubit, blac, borrow } from '@blac/core';
import type { FolderNode } from '../../types/library';
import { TauriService } from '../services/TauriService';

interface FolderState {
  tree: FolderNode | null;
  isLoading: boolean;
  error: string | null;
}

@blac({
  keepAlive: true,
})
export class FolderBloc extends Cubit<FolderState> {
  constructor() {
    super({
      tree: null,
      isLoading: false,
      error: null,
    });
  }

  loadTree = async (rootPath: string) => {
    this.patch({ isLoading: true, error: null });

    try {
      const tauri = borrow(TauriService);
      const treeData = await tauri.getFolderTree(rootPath);
      const tree = treeData as FolderNode;

      this.patch({ tree, isLoading: false });
    } catch (error) {
      this.patch({
        error: `Failed to load folder tree: ${error}`,
        isLoading: false,
      });
    }
  };

  setTree = (tree: FolderNode) => {
    this.patch({ tree });
  };

  toggleExpand = (path: string) => {
    if (!this.state.tree) return;

    const updateNode = (node: FolderNode): FolderNode => {
      if (node.path === path) {
        return { ...node, isExpanded: !node.isExpanded };
      }
      return {
        ...node,
        children: node.children.map(updateNode),
      };
    };

    this.patch({ tree: updateNode(this.state.tree) });
  };

  expandPath = (path: string) => {
    if (!this.state.tree) return;

    const updateNode = (node: FolderNode): FolderNode => {
      if (path.startsWith(node.path)) {
        return {
          ...node,
          isExpanded: true,
          children: node.children.map(updateNode),
        };
      }
      return node;
    };

    this.patch({ tree: updateNode(this.state.tree) });
  };

  collapseAll = () => {
    if (!this.state.tree) return;

    const collapseNode = (node: FolderNode): FolderNode => ({
      ...node,
      isExpanded: false,
      children: node.children.map(collapseNode),
    });

    this.patch({ tree: collapseNode(this.state.tree) });
  };

  clear = () => {
    this.emit({
      tree: null,
      isLoading: false,
      error: null,
    });
  };
}
