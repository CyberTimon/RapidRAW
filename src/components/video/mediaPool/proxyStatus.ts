import i18n from 'i18next';
import { ProxyState } from '../../../store/videoProxies';

export const proxyLabel = (proxy: ProxyState | undefined) => {
  switch (proxy?.state) {
    case 'ready':
      return i18n.t('video.proxies.ready');
    case 'queued':
      return i18n.t('video.proxies.queued');
    case 'running':
      return i18n.t('video.proxies.creating', { percent: Math.round(proxy.progress * 100) });
    default:
      return null;
  }
};
