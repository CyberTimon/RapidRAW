import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('framer-motion') || id.includes('zustand')) {
              return 'vendor-react';
            }
            if (id.includes('konva') || id.includes('react-image-crop')) {
              return 'vendor-canvas';
            }
            if (id.includes('lucide-react') || id.includes('simple-icons')) {
              return 'vendor-icons';
            }
            if (id.includes('i18next')) {
              return 'vendor-i18n';
            }
          }
        },
      },
    },
  },
}));
