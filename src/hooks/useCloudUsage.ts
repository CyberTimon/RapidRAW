import { useEffect, useCallback } from 'react';
import { useUser, useAuth } from '@clerk/react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useCloudStore } from '../store/useCloudStore';

export function useCloudUsage() {
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const isPro = user?.publicMetadata?.plan === 'pro';

  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider || 'cpu');
  const cloudUsage = useCloudStore((s) => s.cloudUsage);
  const isLoading = useCloudStore((s) => s.isLoading);
  const fetchUsage = useCloudStore((s) => s.fetchUsage);

  const refreshUsage = useCallback(async () => {
    if (aiProvider === 'cloud' && isSignedIn && isPro) {
      await fetchUsage(getToken);
    }
  }, [aiProvider, isSignedIn, isPro, getToken, fetchUsage]);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  return {
    cloudUsage,
    isLoading,
    refreshUsage,
    isSignedIn: !!isSignedIn,
    isPro: !!isPro,
    aiProvider,
  };
}
