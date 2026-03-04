import { createContext, PropsWithChildren, ReactNode, SetStateAction, useContext, useState } from 'react';
import { SelectedImageProvider } from './state/SelectedImageContext';
import { ContextMenuProvider } from './ContextMenuContext';
import { ClerkProvider } from '@clerk/clerk-react';
import { CLERK_PUBLISHABLE_KEY } from '../utils/constants';
import { AppSettingsContextProvider } from './state/AppSettingsContext';

export function ContextProviders({ children }: PropsWithChildren) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <AppSettingsContextProvider>
        <SelectedImageProvider>
          <ContextMenuProvider>{children}</ContextMenuProvider>
        </SelectedImageProvider>
      </AppSettingsContextProvider>
    </ClerkProvider>
  );
}
