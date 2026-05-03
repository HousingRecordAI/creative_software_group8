import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function writeJson(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function readRequestBody(req: any) {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function toClaudeImageBlock(image: any) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image?.mediaType || 'image/jpeg',
      data: image?.data || '',
    },
  };
}

function extractClaudeText(data: any) {
  return Array.isArray(data.content)
    ? data.content
        .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text)
        .join('\n')
        .trim()
    : '';
}

function claudeDevApi(env: Record<string, string>) {
  return {
    name: 'house-record-claude-dev-api',
    configureServer(server: any) {
      server.middlewares.use('/api/ai/generate', async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          writeJson(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
          return;
        }

        let body: any;
        try {
          body = JSON.parse(await readRequestBody(req));
        } catch {
          writeJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          writeJson(res, 400, { error: 'Missing prompt' });
          return;
        }

        const images = Array.isArray(body.images) ? body.images : [];
        const maxTokens = clampNumber(body.maxTokens, 1, 4096, 1024);
        const temperature = clampNumber(body.temperature, 0, 1, 0.1);
        const model = env.CLAUDE_MODEL || env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [
              {
                role: 'user',
                content: [
                  ...images.map(toClaudeImageBlock),
                  { type: 'text', text: prompt },
                ],
              },
            ],
          }),
        });

        if (!claudeRes.ok) {
          const errorText = await claudeRes.text();
          writeJson(res, 502, { error: `Claude API error: ${errorText}` });
          return;
        }

        const claudeData = await claudeRes.json();
        const response = extractClaudeText(claudeData);
        if (!response) {
          writeJson(res, 502, { error: 'Claude returned no text content' });
          return;
        }

        writeJson(res, 200, {
          response,
          model: claudeData.model || model,
          usage: claudeData.usage,
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      claudeDevApi(env),
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
