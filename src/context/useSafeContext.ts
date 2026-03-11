import { Context, useContext } from 'react';

export function useSafeContext<T>(context: Context<T>) {
  const ctx = useContext(context);

  if (!ctx) {
    throw `Provider missing for ${context.name}`;
  }

  return ctx;
}
