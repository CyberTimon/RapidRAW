import fs from 'node:fs';
import path from 'node:path';

// POC guard: ensure migrated modal copy no longer contains selected hardcoded literals.
const CHECKS = [
  {
    file: 'src/components/modals/PanoramaModal.tsx',
    banned: ['Panorama Failed', 'Panorama Saved!', 'Stitching Panorama', 'Save Panorama'],
  },
  {
    file: 'src/components/modals/HdrModal.tsx',
    banned: ['HDR Failed', 'HDR Saved!', 'Merging HDR', 'Save HDR'],
  },
  {
    file: 'src/components/modals/DenoiseModal.tsx',
    banned: ['Denoising Image', 'Denoise Image', 'Save Image', 'Processing Failed'],
  },
];

const violations = [];

for (const { file, banned } of CHECKS) {
  const fullPath = path.join(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    violations.push(`${file}: file not found`);
    continue;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  for (const text of banned) {
    if (content.includes(text)) {
      violations.push(`${file}: contains hardcoded literal '${text}'`);
    }
  }
}

if (violations.length > 0) {
  console.error('Hardcoded UI check failed:');
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

console.log('Hardcoded UI check passed for POC scope.');
