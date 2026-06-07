import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built bundle works when loaded from file:// inside Electron.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
});
