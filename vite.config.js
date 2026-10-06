import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname.replace(/\\/g, '/') + '/web',
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../src/web/public/app',
    emptyOutDir: true,
  },
});
