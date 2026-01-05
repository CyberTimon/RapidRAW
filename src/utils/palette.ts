export interface ColorPalette {
  dominant: string;
  vibrant: string | null;
  muted: string | null;
  darkVibrant: string | null;
  darkMuted: string | null;
  lightVibrant: string | null;
  lightMuted: string | null;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function getPixelData(imageData: ImageData, index: number): RGB {
  return {
    r: imageData.data[index],
    g: imageData.data[index + 1],
    b: imageData.data[index + 2],
  };
}

function colorDistance(c1: RGB, c2: RGB): number {
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) + Math.pow(c1.g - c2.g, 2) + Math.pow(c1.b - c2.b, 2)
  );
}

function getLuminance(color: RGB): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function getSaturation(color: RGB): number {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function isVibrant(color: RGB): boolean {
  const saturation = getSaturation(color);
  const luminance = getLuminance(color);
  return saturation > 0.35 && luminance > 50 && luminance < 200;
}

function isMuted(color: RGB): boolean {
  const saturation = getSaturation(color);
  return saturation < 0.35 && saturation > 0.1;
}

function isDark(color: RGB): boolean {
  return getLuminance(color) < 100;
}

function isLight(color: RGB): boolean {
  return getLuminance(color) > 150;
}

function quantizeColors(imageData: ImageData, numColors: number): RGB[] {
  const pixels: RGB[] = [];
  const step = Math.max(1, Math.floor(imageData.data.length / 4 / 1000));

  for (let i = 0; i < imageData.data.length; i += 4 * step) {
    if (imageData.data[i + 3] < 128) continue;

    const pixel = getPixelData(imageData, i);
    if (pixel.r === 0 && pixel.g === 0 && pixel.b === 0) continue;
    if (pixel.r === 255 && pixel.g === 255 && pixel.b === 255) continue;

    pixels.push(pixel);
  }

  if (pixels.length === 0) {
    return [{ r: 128, g: 128, b: 128 }];
  }

  const centroids: RGB[] = [];
  for (let i = 0; i < numColors; i++) {
    centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);
  }

  for (let iteration = 0; iteration < 10; iteration++) {
    const clusters: RGB[][] = Array.from({ length: numColors }, () => []);

    for (const pixel of pixels) {
      let minDistance = Infinity;
      let closestIndex = 0;

      for (let i = 0; i < centroids.length; i++) {
        const distance = colorDistance(pixel, centroids[i]);
        if (distance < minDistance) {
          minDistance = distance;
          closestIndex = i;
        }
      }

      clusters[closestIndex].push(pixel);
    }

    for (let i = 0; i < numColors; i++) {
      if (clusters[i].length === 0) continue;

      const sum = clusters[i].reduce(
        (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
        { r: 0, g: 0, b: 0 }
      );

      centroids[i] = {
        r: Math.round(sum.r / clusters[i].length),
        g: Math.round(sum.g / clusters[i].length),
        b: Math.round(sum.b / clusters[i].length),
      };
    }
  }

  return centroids;
}

export async function extractPalette(imageUrl: string): Promise<ColorPalette> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      const maxSize = 100;
      const scale = Math.min(maxSize / img.width, maxSize / img.height);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const colors = quantizeColors(imageData, 16);

      let dominant = colors[0];
      let vibrant: RGB | null = null;
      let muted: RGB | null = null;
      let darkVibrant: RGB | null = null;
      let darkMuted: RGB | null = null;
      let lightVibrant: RGB | null = null;
      let lightMuted: RGB | null = null;

      for (const color of colors) {
        if (isVibrant(color) && !vibrant) vibrant = color;
        if (isMuted(color) && !muted) muted = color;
        if (isDark(color) && isVibrant(color) && !darkVibrant) darkVibrant = color;
        if (isDark(color) && isMuted(color) && !darkMuted) darkMuted = color;
        if (isLight(color) && isVibrant(color) && !lightVibrant) lightVibrant = color;
        if (isLight(color) && isMuted(color) && !lightMuted) lightMuted = color;
      }

      resolve({
        dominant: rgbToHex(dominant.r, dominant.g, dominant.b),
        vibrant: vibrant ? rgbToHex(vibrant.r, vibrant.g, vibrant.b) : null,
        muted: muted ? rgbToHex(muted.r, muted.g, muted.b) : null,
        darkVibrant: darkVibrant ? rgbToHex(darkVibrant.r, darkVibrant.g, darkVibrant.b) : null,
        darkMuted: darkMuted ? rgbToHex(darkMuted.r, darkMuted.g, darkMuted.b) : null,
        lightVibrant: lightVibrant ? rgbToHex(lightVibrant.r, lightVibrant.g, lightVibrant.b) : null,
        lightMuted: lightMuted ? rgbToHex(lightMuted.r, lightMuted.g, lightMuted.b) : null,
      });
    };

    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

export function getContrastColor(hexColor: string): string {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const luminance = getLuminance({ r, g, b });
  return luminance > 128 ? '#000000' : '#ffffff';
}
