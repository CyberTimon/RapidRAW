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

export interface SelectedImageContext {
  selectedImage: SelectedImage | null;
  selectedImagePathRef: RefObject<string | null>;
  setSelectedImage: React.Dispatch<SetStateAction<SelectedImage | null>>;
}

export function useSelectedImage() {
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  return { selectedImage, setSelectedImage, selectedImagePathRef };
}
