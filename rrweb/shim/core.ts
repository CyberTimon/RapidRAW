import { call } from './transport';
export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => call<T>(cmd, args ?? {});
export const convertFileSrc = (path: string) => `/files?path=${encodeURIComponent(path)}`;
export const isTauri = () => false;
