import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../leaseq/console',
    emptyOutDir: true,
  },
});
