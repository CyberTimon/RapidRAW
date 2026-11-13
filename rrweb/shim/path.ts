import { call } from './transport';
export const homeDir = () => call<string>('__rr_home');
