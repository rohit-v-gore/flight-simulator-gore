import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const page = (file) => resolve(import.meta.dirname, file);

// Three pages: the flight game (index.html), the hangar viewer (hangar.html) and the CesiumJS globe flight (flight.html).
export default defineConfig({
  base: './',
  // No hot reload: saving a file must never kick a pilot out of a flight. Refresh the page to pick up changes.
  server: { hmr: false },
  build: {
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: { game: page('index.html'), hangar: page('hangar.html'), flight: page('flight.html'), preview: page('aircraft-preview.html') },
    },
  },
});
