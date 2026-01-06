import { composeRenderProps } from 'react-aria-components';

/**
 * Compose Tailwind classes with React Aria render props.
 * Allows combining user-provided className with default styles while
 * supporting React Aria's render prop pattern for state-based styling.
 */
export function composeTailwindRenderProps<T>(
  className: string | ((renderProps: T) => string) | undefined,
  defaultClassName: string
): string | ((renderProps: T) => string) {
  return composeRenderProps(className, (className) =>
    `${defaultClassName} ${className ?? ''}`.trim()
  );
}

/**
 * Standard focus ring styles for accessibility.
 * Uses the app's accent color for consistency.
 */
export const focusRing = `
  outline-none
  focus-visible:ring-2
  focus-visible:ring-accent
  focus-visible:ring-offset-2
  focus-visible:ring-offset-bg-primary
`.trim().replace(/\s+/g, ' ');

/**
 * Focus ring variant without offset (for components where offset looks wrong)
 */
export const focusRingInset = `
  outline-none
  focus-visible:ring-2
  focus-visible:ring-accent
  focus-visible:ring-inset
`.trim().replace(/\s+/g, ' ');
