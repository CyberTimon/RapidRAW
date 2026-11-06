import { useEffect, useCallback } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useCloudStore } from '../store/useCloudStore';

export function useCloudUsage() {
  const user = useCloudStore((s) => s.user);
  const isSignedIn = !!user;
  const isPro = user?.publicMetadata?.plan === 'pro';

  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider || 'cpu');
  const cloudUsage = useCloudStore((s) => s.cloudUsage);
  const isLoading = useCloudStore((s) => s.isLoading);
  const fetchUsage = useCloudStore((s) => s.fetchUsage);

  const refreshUsage = useCallback(async () => {
    if (aiProvider === 'cloud' && isSignedIn && isPro) {
      await fetchUsage();
    }
  }, [aiProvider, isSignedIn, isPro, fetchUsage]);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  return {
    cloudUsage,
    isLoading,
    refreshUsage,
    isSignedIn,
    isPro,
    aiProvider,
  };
}
