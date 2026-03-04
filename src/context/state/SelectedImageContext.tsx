import React, {
  createContext,
  PropsWithChildren,
  RefObject,
  SetStateAction,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { SelectedImage } from '../../components/ui/AppProperties';

interface SelectedImageContext {
  selectedImage: SelectedImage | null;
  selectedImagePathRef: RefObject<string | null>;
  setSelectedImage: React.Dispatch<SetStateAction<SelectedImage | null>>;
}

const SelectedImageContext = createContext<SelectedImageContext | null>(null);

export function SelectedImageProvider({ children }: PropsWithChildren) {
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  return (
    <SelectedImageContext.Provider value={{ selectedImage, setSelectedImage, selectedImagePathRef }}>
      {children}
    </SelectedImageContext.Provider>
  );
}

export function useSelectedImage() {
  const ctx = useContext(SelectedImageContext);

  if (!ctx) {
    throw new Error(`${useSelectedImage.name} must be used within a ${SelectedImageProvider.name}`);
  }

  return ctx;
}
