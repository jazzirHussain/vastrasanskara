import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied on the same origin, so the session cookie works without
// HTTPS. Production builds call the API at VITE_API_URL (https://api.<domain>).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': 'http://localhost:4000' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
