import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
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
