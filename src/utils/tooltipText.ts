export const TOOLTIP_TEXT = {
  basic: {
    brightness: "Adjust the overall brightness of the image",
    contrast: "Adjust the contrast of the image",
    highlights: "Adjust the highlights of the image",
    shadows: "Adjust the shadows of the image",
    whites: "Adjust the whites of the image",
    blacks: "Adjust the blacks of the image",
    toneMapperExposure: "Adjust the exposure compensation for the selected tone mapper",
  },
  color: {
    whiteBalance: {
      temperature: "Adjust the color temperature from warm to cool",
      tint: "Adjust the green-magenta tint of the image",
    },
    presence: {
      vibrance: "Adjust the vibrance to boost muted colors without affecting skin tones",
      saturation: "Adjust the overall color saturation of the image",
    },
    colorGrading: {
      blending: "Control how much the color grading affects the image",
      balance: "Balance the color grading between shadows and highlights",
    },
    colorCalibration: {
      tint: "Adjust the color tint in the shadows",
      hue: "Adjust the hue of the selected primary color",
      saturation: "Adjust the saturation of the selected primary color",
    },
    colorMixer: {
      hue: "Adjust the hue of the selected color range",
      saturation: "Adjust the saturation of the selected color range",
      luminance: "Adjust the luminance of the selected color range",
    },
  },
  details: {
    sharpening: {
      sharpness: "Enhance edge definition and overall image sharpness",
    },
    presence: {
      clarity: "Increase local contrast to add depth and definition",
      dehaze: "Remove atmospheric haze and restore contrast",
      structure: "Enhance fine details and texture in the image",
      centré: "Local contrast enhancement centered on midtones",
    },
    chromaticAberration: {
      redCyan: "Correct red-cyan chromatic aberration (color fringing)",
      blueYellow: "Correct blue-yellow chromatic aberration (color fringing)",
    },
  },
  effects: {
    creative: {
      glow: "Add a soft luminous glow to bright areas",
      halation: "Simulate film halation for a dreamy, cinematic look",
      lightFlares: "Add natural lens flare effects from bright light sources",
    },
    vignette: {
      amount: "Control the intensity of the vignette effect",
      midpoint: "Adjust where the vignette effect begins from the center",
      roundness: "Control the shape of the vignette from circular to rectangular",
      feather: "Control the softness of the vignette edge transition",
    },
    grain: {
      amount: "Control the intensity of film grain overlay",
      size: "Adjust the size of individual grain particles",
      roughness: "Control the texture and irregularity of the grain pattern",
    },
  },
} as const;
