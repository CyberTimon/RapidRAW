import React from 'react';
import type { SVGProps } from 'react';

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

type ExifIconProps = SVGProps<SVGSVGElement>;

export const IconAperture = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M14.31 8l5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16L3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94" />
  </svg>
);

export const IconShutter = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 12V7" />
    <path d="M12 2v2" />
    <path d="M12 22v-2" />
    <path d="M22 12h-2" />
    <path d="M2 12h2" />
    <path d="M19.07 4.93l-1.41 1.41" />
    <path d="M6.34 17.66l-1.41 1.41" />
    <path d="M19.07 19.07l-1.41-1.41" />
    <path d="M6.34 6.34L4.93 4.93" />
  </svg>
);

export const IconIso = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M6 8h.01M6 16h.01M18 8h.01M18 16h.01" />
  </svg>
);

export const IconFocalLength = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <path d="M2 12L22 12" />
    <path d="M17 12a5 5 0 0 0-5-5 5 5 0 0 0-5 5" />
    <path d="M2 12l6 8" />
    <path d="M22 12l-6 8" />
  </svg>
);

export const IconCalendar = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

export const IconClock = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const IconLens = (props: ExifIconProps) => (
  <svg {...iconProps} {...props}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="5" />
    <path d="M12 7a5 5 0 0 1 5 5" strokeWidth="1.5" strokeOpacity="0.4" />
  </svg>
);
