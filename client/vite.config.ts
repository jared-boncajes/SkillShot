import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the game server runs separately on :2567; proxying /ws keeps
// the client same-origin, so LAN play works by sharing http://<your-ip>:5173.
const serverTarget = process.env.DEV_SERVER_TARGET || 'http://localhost:2567';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: serverTarget, ws: true, changeOrigin: true },
      '/health': { target: serverTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
