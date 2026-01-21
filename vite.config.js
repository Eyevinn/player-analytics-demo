import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        about: resolve(__dirname, 'about.html')
      }
    }
  },
  server: {
    port: 1234,
    open: true
  },
  optimizeDeps: {
    include: ['hls.js', 'shaka-player', '@eyevinn/web-player', '@eyevinn/player-analytics-client-sdk-web']
  }
});
