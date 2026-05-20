import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { travelApi } from './server/travelApi';

export default defineConfig(({ mode }) => {
  const travelEnv = loadEnv(mode, process.cwd(), 'TRAVEL_');

  Object.assign(process.env, travelEnv);

  return {
    plugins: [tailwindcss(), react(), travelApi()],
    build: {
      target: 'esnext'
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext'
      }
    },
    server: {
      host: '127.0.0.1',
      port: 5173
    }
  };
});
