import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

function normalizeOrigin(value: string | undefined, fallback: string) {
  const origin = value?.trim() || fallback;
  return origin.replace(/\/+$/, '');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const ollamaHost = normalizeOrigin(
    env.VITE_OLLAMA_HOST || env.OLLAMA_HOST,
    'http://localhost:11434'
  );
  const functionsHost = normalizeOrigin(
    env.VITE_FUNCTIONS_HOST,
    'http://localhost:8788'
  );

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Deposit Defender',
          short_name: 'DepoDefen',
          description: 'Student Housing Deposit Protection',
          theme_color: '#0f172a',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ],
    server: {
      allowedHosts: ['.trycloudflare.com'],
      hmr: {
        protocol: 'wss',
        clientPort: 443,
      },
      proxy: {
        '/api/analyze': {
          target: functionsHost,
          changeOrigin: true,
        },
        '/api/ollama': {
          target: ollamaHost,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/ollama/, '')
        }
      },
      watch: {
        ignored: ['**/venv/**', '**/node_modules/**']
      }
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**', '**/.{idea,git,cache,output,temp}/**', '**/gstack/**']
    }
  };
});
