import { useAppState } from '../../context/ContextProviders';

export function useCloseConfirmModal() {
  const { confirmModalState, setConfirmModalState } = useAppState();

  const closeConfirmModal = () => setConfirmModalState({ ...confirmModalState, isOpen: false });
  return closeConfirmModal;
}
