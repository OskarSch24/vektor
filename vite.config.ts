import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { redisBridge } from './dev/redisBridge';

export default defineConfig({
  plugins: [react(), redisBridge()],
  // Relative asset URLs so the bundle also works under the app:// scheme of the
  // native macOS host, not just from a web root.
  base: './',
  build: {
    target: 'es2022',
  },
  server: {
    port: 5473,
  },
});
