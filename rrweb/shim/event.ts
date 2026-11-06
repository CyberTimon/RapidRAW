import { emitLocal, on } from './transport';
export type UnlistenFn = () => void;
type Ev<T> = { event: string; id: number; payload: T };
export async function listen<T>(event: string, handler: (e: Ev<T>) => void): Promise<UnlistenFn> {
  return on(event, (payload) => handler({ event, id: 0, payload: payload as T }));
}
// Events emitted by the UI stay in the browser (the backend's event bus is not reachable from here)
export async function emit<T>(event: string, payload?: T): Promise<void> {
  emitLocal(event, payload ?? null);
}
export async function once<T>(event: string, handler: (e: Ev<T>) => void): Promise<UnlistenFn> {
  const un = on(event, (payload) => { un(); handler({ event, id: 0, payload: payload as T }); });
  return un;
}
