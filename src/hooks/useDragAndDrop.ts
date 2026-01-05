import { useState, useCallback, useEffect, type DragEvent } from 'react';
import { IMAGE_EXTENSIONS } from '../types/library';

interface UseDragAndDropOptions {
  onFilesDropped: (files: File[]) => void;
  acceptedExtensions?: string[];
}

interface UseDragAndDropResult {
  isDragging: boolean;
  handlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

export function useDragAndDrop({
  onFilesDropped,
  acceptedExtensions = IMAGE_EXTENSIONS,
}: UseDragAndDropOptions): UseDragAndDropResult {
  const [isDragging, setIsDragging] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);

  const isValidFile = useCallback(
    (file: File) => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      return extension && acceptedExtensions.includes(extension);
    },
    [acceptedExtensions]
  );

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter((prev) => prev + 1);
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter((prev) => {
      const newCount = prev - 1;
      if (newCount === 0) {
        setIsDragging(false);
      }
      return newCount;
    });
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      setDragCounter(0);

      const files = Array.from(e.dataTransfer.files).filter(isValidFile);

      if (files.length > 0) {
        onFilesDropped(files);
      }
    },
    [isValidFile, onFilesDropped]
  );

  useEffect(() => {
    return () => {
      setDragCounter(0);
      setIsDragging(false);
    };
  }, []);

  return {
    isDragging,
    handlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  };
}


