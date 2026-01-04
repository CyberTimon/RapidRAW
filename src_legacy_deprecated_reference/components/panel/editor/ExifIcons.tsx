import React from 'react';

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconAperture = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="10" />
    <path d="M14.31 8l5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16L3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94" />
  </svg>
);

export const IconShutter = () => (
  <svg {...iconProps}>
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

export const IconIso = () => (
  <svg {...iconProps}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M6 8h.01M6 16h.01M18 8h.01M18 16h.01" />
  </svg>
);

export const IconFocalLength = () => (
  <svg {...iconProps}>
    <path d="M2 12L22 12" />
    <path d="M17 12a5 5 0 0 0-5-5 5 5 0 0 0-5 5" />
    <path d="M2 12l6 8" />
    <path d="M22 12l-6 8" />
  </svg>
);