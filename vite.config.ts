import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

type AiTask = 'capture_plan' | 'capture_review';

const TASK_TO_TOOL: Record<AiTask, string> = {
  capture_plan: 'create_capture_plan',
  capture_review: 'review_capture_photo',
};

const TOOL_DEFINITIONS = [
  {
    name: 'create_capture_plan',
    description: 'Create a structured room photo capture plan, or return a retryable error when the image is not usable as an interior overview.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: errorSchema(),
        summary: { type: 'string' },
        tasks: {
          type: 'array',
          minItems: 0,
          maxItems: 8,
          items: captureTaskSchema(),
        },
      },
      required: ['ok', 'summary', 'tasks'],
    },
  },
  {
    name: 'review_capture_photo',
    description: 'Review whether a photo satisfies a guided capture checkpoint for housing dispute evidence.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: errorSchema(),
        status: { type: 'string', enum: ['pass', 'retry'] },
        message: { type: 'string' },
        hint: { type: 'string' },
      },
      required: ['ok', 'status', 'message'],
    },
  },
];

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

function extractToolInput(data: any, toolName: string) {
  const toolUse = Array.isArray(data.content)
    ? data.content.find((item: any) => item?.type === 'tool_use' && item.name === toolName)
    : null;
  return toolUse?.input && typeof toolUse.input === 'object' ? toolUse.input : null;
}

function normalizeToolInput(task: AiTask, input: any) {
  const ok = input?.ok === true;
  if (!ok) {
    return {
      ok: false,
      error: normalizeAiError(input?.error, fallbackErrorForTask(task)),
    };
  }

  if (task === 'capture_plan') {
    const tasks = Array.isArray(input.tasks) ? input.tasks.map(normalizeCaptureTask).filter(Boolean).slice(0, 8) : [];
    if (tasks.length < 3) {
      return {
        ok: false,
        error: {
          code: 'insufficient_capture_plan',
          message: '촬영 목록을 충분히 만들지 못했습니다. 방 전체가 더 잘 보이도록 다시 촬영해 주세요.',
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      data: {
        summary: stringOr(input.summary, '전체 샷을 바탕으로 촬영 목록을 만들었습니다.'),
        tasks,
      },
    };
  }

  if (task === 'capture_review') {
    const status = input.status === 'pass' ? 'pass' : 'retry';
    return {
      ok: true,
      data: {
        status,
        message: stringOr(input.message, status === 'pass' ? '증거 사진으로 충분합니다.' : '촬영 대상이 충분히 보이지 않습니다.'),
        hint: typeof input.hint === 'string' ? input.hint : undefined,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'unsupported_task',
      message: '지원하지 않는 AI 작업입니다.',
      retryable: false,
    },
  };
}

function normalizeCaptureTask(task: any) {
  if (!task || typeof task !== 'object') return null;
  return {
    id: stringOr(task.id, ''),
    label: stringOr(task.label, '추가 촬영'),
    guide: stringOr(task.guide, '대상 부위가 선명하게 보이도록 찍어주세요.'),
    target: stringOr(task.target, '확인 대상'),
    angle: ['wide', 'detail', 'low'].includes(task.angle) ? task.angle : 'detail',
    minPhotos: clampNumber(task.minPhotos, 1, 3, 1),
    coverageCriteria: Array.isArray(task.coverageCriteria)
      ? task.coverageCriteria.filter((item: unknown) => typeof item === 'string' && item.trim()).slice(0, 4)
      : [],
  };
}

function normalizeAiError(error: any, fallback: string) {
  return {
    code: typeof error?.code === 'string' && error.code.trim() ? error.code : 'ai_unable_to_complete',
    message: typeof error?.message === 'string' && error.message.trim() ? error.message : fallback,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : true,
    hint: typeof error?.hint === 'string' && error.hint.trim() ? error.hint : undefined,
  };
}

function fallbackErrorForTask(task: AiTask) {
  if (task === 'capture_plan') {
    return '실내 전체 샷으로 판단하기 어렵습니다. 벽, 바닥, 주요 설비가 함께 보이도록 다시 촬영해 주세요.';
  }
  if (task === 'capture_review') {
    return '사진이 촬영 지시를 평가하기에 충분하지 않습니다. 다시 촬영해 주세요.';
  }
  return 'AI 작업을 처리하기 어렵습니다.';
}

function errorEnvelope(code: string, message: string, retryable: boolean) {
  return {
    ok: false,
    error: { code, message, retryable },
  };
}

function isAiTask(value: unknown): value is AiTask {
  return value === 'capture_plan'
    || value === 'capture_review';
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      retryable: { type: 'boolean' },
      hint: { type: 'string' },
    },
    required: ['code', 'message', 'retryable'],
  };
}

function captureTaskSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      guide: { type: 'string' },
      target: { type: 'string' },
      angle: { type: 'string', enum: ['wide', 'detail', 'low'] },
      minPhotos: { type: 'integer', minimum: 1, maximum: 3 },
      coverageCriteria: {
        type: 'array',
        minItems: 0,
        maxItems: 4,
        items: { type: 'string' },
      },
    },
    required: ['id', 'label', 'guide', 'target', 'angle', 'minPhotos', 'coverageCriteria'],
  };
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
          writeJson(res, 500, errorEnvelope('missing_api_key', 'ANTHROPIC_API_KEY not configured', false));
          return;
        }

        let body: any;
        try {
          body = JSON.parse(await readRequestBody(req));
        } catch {
          writeJson(res, 400, errorEnvelope('invalid_json', 'Invalid JSON body', false));
          return;
        }

        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          writeJson(res, 400, errorEnvelope('missing_prompt', 'Missing prompt', false));
          return;
        }

        if (!isAiTask(body.task)) {
          writeJson(res, 400, errorEnvelope('unsupported_task', 'Missing or unsupported AI task', false));
          return;
        }

        const images = Array.isArray(body.images) ? body.images : [];
        const maxTokens = clampNumber(body.maxTokens, 1, 4096, 1024);
        const temperature = clampNumber(body.temperature, 0, 1, 0.1);
        const model = env.CLAUDE_MODEL || env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;
        const toolName = TASK_TO_TOOL[body.task];

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
            system: 'You are a housing inspection assistant. Use the forced tool exactly once. Do not return free-form text. If the image is not usable for the requested task, set ok=false with a concise Korean error message and retryable=true.',
            tools: TOOL_DEFINITIONS,
            tool_choice: { type: 'tool', name: toolName },
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
          writeJson(res, 502, errorEnvelope('claude_api_error', `Claude API error: ${errorText}`, true));
          return;
        }

        const claudeData = await claudeRes.json();
        const toolInput = extractToolInput(claudeData, toolName);
        if (!toolInput) {
          writeJson(res, 502, errorEnvelope('missing_tool_output', 'Claude returned no structured tool output', true));
          return;
        }

        const normalized = normalizeToolInput(body.task, toolInput);
        if (!normalized.ok) {
          writeJson(res, 200, {
            ok: false,
            error: normalized.error,
            model: claudeData.model || model,
            usage: claudeData.usage,
          });
          return;
        }

        writeJson(res, 200, {
          ok: true,
          data: normalized.data,
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
