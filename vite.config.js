import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const page = (file) => resolve(import.meta.dirname, file);

// Two pages: the Three.js viewer (index.html) and the CesiumJS flight (flight.html, Cesium from its CDN).
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: { viewer: page('index.html'), flight: page('flight.html') },
    },
  },
});
