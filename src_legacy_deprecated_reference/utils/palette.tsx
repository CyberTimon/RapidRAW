export const generatePaletteFromImage = (imageUrl: string) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = imageUrl;

    img.onload = () => {
      const canvas: HTMLCanvasElement = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const scale = 0.1;
      const width = img.width * scale;
      const height = img.height * scale;
      canvas.width = width;
      canvas.height = height;
      ctx?.drawImage(img, 0, 0, width, height);

      const imageData = ctx?.getImageData(0, 0, width, height).data;
      if (!imageData) {
        return;
      }

      const sampleRate = 20;
      let bestAccentCandidate = { score: -1, color: { r: 220, g: 220, b: 220 } };

      for (let i = 0; i < imageData.length; i += 4 * sampleRate) {
        const r = imageData[i];
        const g = imageData[i + 1];
        const b = imageData[i + 2];

        const r_ = r / 255,
          g_ = g / 255,
          b_ = b / 255;
        const max = Math.max(r_, g_, b_),
          min = Math.min(r_, g_, b_);
        const l = (max + min) / 2;
        const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);

        if (l > 0.3 && l < 0.8 && s > bestAccentCandidate.score) {
          bestAccentCandidate = { score: s, color: { r, g, b } };
        }
      }

      const accentColor = bestAccentCandidate.color;

      const toRgbSpace = (c: any) => `${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}`;
      const borderColor = {
        r: Math.min(255, accentColor.r + 40),
        g: Math.min(255, accentColor.g + 40),
        b: Math.min(255, accentColor.b + 40),
      };

      resolve({
        '--color-accent': toRgbSpace(accentColor),
        '--color-hover-color': toRgbSpace(accentColor),
        '--color-border-color': toRgbSpace(borderColor),
      });
    };

    img.onerror = (err) => {
      console.error('Failed to load image for palette generation:', err);
      reject(err);
    };
  });
};
