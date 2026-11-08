import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // Runtime PCFs and import previews are data, not frontend source. Watching
  // their HTML files causes a full reload and sends users back to project selection.
  // Match the backend's process.env paths, including custom data/database locations.
  const dataDir = path.resolve(__dirname, process.env.PAHUB_DATA_DIR || 'data').replace(/\\/g, '/');
  const dbPath = path.resolve(__dirname, process.env.PAPC_DB_PATH || path.join(dataDir, 'papc.db')).replace(/\\/g, '/');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      watch: {
        ignored: [dataDir, dataDir + '/**', dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal'],
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
        }
      }
    },
    plugins: [tailwindcss(), react()],
    define: {
      ...(mode === 'hub' ? {
        'import.meta.env.VITE_DATA_API_BASE_URL': JSON.stringify('/api'),
        'import.meta.env.VITE_DATA_API_FALLBACK': JSON.stringify('false'),
      } : {}),
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'import.meta.env.VITE_PUSH_PASSWORD': JSON.stringify(env.VITE_PUSH_PASSWORD || env.PUSH_PASSWORD)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
