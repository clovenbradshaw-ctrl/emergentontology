import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Deploy under /admin/ on GitHub Pages
  base: process.env.VITE_BASE_URL ? `${process.env.VITE_BASE_URL}/admin/` : '/admin/',
  build: {
    outDir: '../site/public/admin',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
