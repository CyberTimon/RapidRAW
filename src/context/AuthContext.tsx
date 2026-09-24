import React, { createContext, useContext } from 'react';
import {
  ClerkProvider,
  useAuth as useClerkAuth,
  useUser as useClerkUser,
  useClerk as useClerkInstance,
  Show as ClerkShow,
  SignIn as ClerkSignIn,
} from '@clerk/react';

export interface AuthContextType {
  getToken: () => Promise<string | null>;
  isSignedIn: boolean;
  userId: string | null;
  user: any;
  isLoaded: boolean;
  signOut: () => Promise<void>;
  openSignIn: () => void;
}

const DefaultAuthContext = createContext<AuthContextType>({
  getToken: async () => null,
  isSignedIn: false,
  userId: null,
  user: null,
  isLoaded: true,
  signOut: async () => {},
  openSignIn: () => {},
});

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_KEY || '';

const ClerkAuthBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { getToken, isSignedIn, userId, isLoaded } = useClerkAuth();
  const { user } = useClerkUser();
  const clerk = useClerkInstance();

  return (
    <DefaultAuthContext.Provider
      value={{
        getToken: () => getToken().catch(() => null),
        isSignedIn: Boolean(isSignedIn),
        userId: userId || null,
        user: user || null,
        isLoaded: Boolean(isLoaded),
        signOut: () => clerk.signOut(),
        openSignIn: () => clerk.openSignIn?.(),
      }}
    >
      {children}
    </DefaultAuthContext.Provider>
  );
};

export const SafeAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (CLERK_PUBLISHABLE_KEY) {
    return (
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
        <ClerkAuthBridge>{children}</ClerkAuthBridge>
      </ClerkProvider>
    );
  }
  return (
    <DefaultAuthContext.Provider
      value={{
        getToken: async () => null,
        isSignedIn: false,
        userId: null,
        user: null,
        isLoaded: true,
        signOut: async () => {},
        openSignIn: () => {},
      }}
    >
      {children}
    </DefaultAuthContext.Provider>
  );
};

export const useSafeAuth = () => {
  const ctx = useContext(DefaultAuthContext);
  return {
    getToken: ctx.getToken,
    isSignedIn: ctx.isSignedIn,
    userId: ctx.userId,
    isLoaded: ctx.isLoaded,
  };
};

export const useUser = () => {
  const ctx = useContext(DefaultAuthContext);
  return {
    user: ctx.user,
    isSignedIn: ctx.isSignedIn,
    isLoaded: ctx.isLoaded,
  };
};

export const useAuth = useSafeAuth;

export const useClerk = () => {
  const ctx = useContext(DefaultAuthContext);
  return {
    signOut: ctx.signOut,
    openSignIn: ctx.openSignIn,
  };
};

export const Show: React.FC<{ when?: any; fallback?: React.ReactNode; children?: React.ReactNode }> = ({
  when,
  fallback,
  children,
}) => {
  if (CLERK_PUBLISHABLE_KEY) {
    return <ClerkShow when={when} fallback={fallback}>{children}</ClerkShow>;
  }
  return when ? <>{children}</> : <>{fallback || null}</>;
};

export const SignIn: React.FC<any> = (props) => {
  if (CLERK_PUBLISHABLE_KEY) {
    return <ClerkSignIn {...props} />;
  }
  return null;
};
