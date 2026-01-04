import { Cubit } from '@blac/core';

export type ModalId =
  | 'confirm'
  | 'rename-folder'
  | 'create-folder'
  | 'rename-file'
  | 'rename-preset'
  | 'add-preset'
  | 'import-settings'
  | 'copy-paste-settings'
  | 'denoise'
  | 'culling'
  | 'collage'
  | 'panorama'
  | 'export-progress'
  | 'keyboard-shortcuts'
  | 'about';

export interface ConfirmModalData {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'destructive';
  onConfirm?: () => void;
  onCancel?: () => void;
}

export interface RenameModalData {
  currentName: string;
  onRename: (newName: string) => void;
}

export interface CreateFolderModalData {
  parentPath: string;
  onConfirm: (folderName: string) => void;
}

export interface ModalData {
  confirm?: ConfirmModalData;
  'rename-folder'?: RenameModalData;
  'create-folder'?: CreateFolderModalData;
  'rename-file'?: RenameModalData;
  'rename-preset'?: RenameModalData;
  'add-preset'?: { folderId?: string; onConfirm: (name: string) => void };
  'import-settings'?: { paths: string[] };
  'copy-paste-settings'?: { sourcePath: string };
  denoise?: { imagePath: string };
  culling?: { imagePaths: string[] };
  collage?: { imagePaths: string[] };
  panorama?: { imagePaths: string[] };
  'export-progress'?: { total: number; current: number; currentFile?: string };
  'keyboard-shortcuts'?: Record<string, never>;
  about?: Record<string, never>;
}

interface ModalState {
  openModals: ModalId[];
  modalData: Partial<ModalData>;
}

export class ModalBloc extends Cubit<ModalState> {
  constructor() {
    super({
      openModals: [],
      modalData: {},
    });
  }

  open = <K extends ModalId>(modalId: K, data?: ModalData[K]) => {
    if (this.state.openModals.includes(modalId)) {
      return;
    }
    this.emit({
      openModals: [...this.state.openModals, modalId],
      modalData: { ...this.state.modalData, [modalId]: data },
    });
  };

  close = (modalId: ModalId) => {
    this.emit({
      openModals: this.state.openModals.filter((id) => id !== modalId),
      modalData: { ...this.state.modalData, [modalId]: undefined },
    });
  };

  closeAll = () => {
    this.emit({
      openModals: [],
      modalData: {},
    });
  };

  isOpen = (modalId: ModalId): boolean => {
    return this.state.openModals.includes(modalId);
  };

  getData = <K extends ModalId>(modalId: K): ModalData[K] | undefined => {
    return this.state.modalData[modalId] as ModalData[K] | undefined;
  };

  confirm = (
    title: string,
    message: string,
    options?: Partial<ConfirmModalData>
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      this.open('confirm', {
        title,
        message,
        confirmText: options?.confirmText ?? 'Confirm',
        cancelText: options?.cancelText ?? 'Cancel',
        confirmVariant: options?.confirmVariant ?? 'primary',
        onConfirm: () => {
          this.close('confirm');
          resolve(true);
        },
        onCancel: () => {
          this.close('confirm');
          resolve(false);
        },
      });
    });
  };
}
