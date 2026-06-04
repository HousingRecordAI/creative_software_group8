import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEMO_CAPTURE_TASK_LIMIT = 2;
const DEMO_CAPTURE_MIN_TASKS = 1;
const DEMO_COVERAGE_CRITERIA_LIMIT = 2;

type AiTask = 'capture_plan' | 'capture_review' | 'defect_analysis' | 'move_out_comparison';

const TASK_TO_TOOL: Record<AiTask, string> = {
  capture_plan: 'create_capture_plan',
  capture_review: 'review_capture_photo',
  defect_analysis: 'analyze_defects',
  move_out_comparison: 'compare_move_out_damage',
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
          maxItems: DEMO_CAPTURE_TASK_LIMIT,
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
  {
    name: 'analyze_defects',
    description: 'Return structured visible defect analysis for an interior photo.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: errorSchema(),
        defects: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string' },
              location: { type: 'string' },
              severity: { type: 'string', enum: ['경미', '보통', '심각'] },
            },
            required: ['type', 'location', 'severity'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['ok', 'defects', 'summary'],
    },
  },
  {
    name: 'compare_move_out_damage',
    description: 'Compare move-in and move-out photos and return structured damage level and notes.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: errorSchema(),
        damageLevel: { type: 'string', enum: ['none', 'low', 'high'] },
        notes: { type: 'string' },
      },
      required: ['ok', 'damageLevel', 'notes'],
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
    const tasks = Array.isArray(input.tasks) ? input.tasks.map(normalizeCaptureTask).filter(Boolean).slice(0, DEMO_CAPTURE_TASK_LIMIT) : [];
    if (tasks.length < DEMO_CAPTURE_MIN_TASKS) {
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

  if (task === 'defect_analysis') {
    return {
      ok: true,
      data: {
        defects: Array.isArray(input.defects) ? input.defects.map(normalizeDefect).filter(Boolean) : [],
        summary: stringOr(input.summary, '분석 결과 요약이 없습니다.'),
      },
    };
  }

  return {
    ok: true,
    data: {
      damageLevel: ['none', 'low', 'high'].includes(input.damageLevel) ? input.damageLevel : 'none',
      notes: stringOr(input.notes, '새로운 손상 여부를 판단할 수 없습니다.'),
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
    minPhotos: clampNumber(task.minPhotos, 1, 1, 1),
    coverageCriteria: Array.isArray(task.coverageCriteria)
      ? task.coverageCriteria.filter((item: unknown) => typeof item === 'string' && item.trim()).slice(0, DEMO_COVERAGE_CRITERIA_LIMIT)
      : [],
  };
}

function normalizeDefect(defect: any) {
  if (!defect || typeof defect !== 'object') return null;
  return {
    type: stringOr(defect.type, '하자'),
    location: stringOr(defect.location, '위치 미상'),
    severity: ['경미', '보통', '심각'].includes(defect.severity) ? defect.severity : '경미',
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
  if (task === 'defect_analysis') {
    return '하자 분석 대상 사진으로 판단하기 어렵습니다.';
  }
  return '두 사진의 변경점을 비교하기 어렵습니다.';
}

function errorEnvelope(code: string, message: string, retryable: boolean) {
  return {
    ok: false,
    error: { code, message, retryable },
  };
}

function isAiTask(value: unknown): value is AiTask {
  return value === 'capture_plan'
    || value === 'capture_review'
    || value === 'defect_analysis'
    || value === 'move_out_comparison';
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
      minPhotos: { type: 'integer', minimum: 1, maximum: 1 },
      coverageCriteria: {
        type: 'array',
        minItems: 0,
        maxItems: DEMO_COVERAGE_CRITERIA_LIMIT,
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
      server.middlewares.use('/api/upload', async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const body = JSON.parse(await readRequestBody(req));
          const imageData = body.image;
          if (!imageData) {
            writeJson(res, 400, { ok: false, error: 'Missing image data' });
            return;
          }

          const matches = imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (!matches || matches.length !== 3) {
            writeJson(res, 400, { ok: false, error: 'Invalid base64 image data format' });
            return;
          }

          const imageBuffer = Buffer.from(matches[2], 'base64');
          const uploadDir = path.join(process.cwd(), 'public', 'uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          const filename = `img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.jpg`;
          const filepath = path.join(uploadDir, filename);
          fs.writeFileSync(filepath, imageBuffer);

          writeJson(res, 200, { ok: true, url: `/uploads/${filename}` });
        } catch (error: any) {
          writeJson(res, 500, { ok: false, error: error?.message || 'Server error uploading image' });
        }
      });

      server.middlewares.use('/api/reset', async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const uploadDir = path.join(process.cwd(), 'public', 'uploads');
          if (fs.existsSync(uploadDir)) {
            const files = fs.readdirSync(uploadDir);
            for (const file of files) {
              const filePath = path.join(uploadDir, file);
              if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
              }
            }
          }
          writeJson(res, 200, { ok: true, message: 'All server uploaded assets purged successfully' });
        } catch (error: any) {
          writeJson(res, 500, { ok: false, error: error?.message || 'Server error resetting assets' });
        }
      });

      server.middlewares.use('/api/ai/generate', async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') {
          next();
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

        const rawImages = Array.isArray(body.images) ? body.images : [];
        const images = rawImages.map(img => {
          if (img.data.startsWith('/uploads/')) {
            const filePath = path.join(process.cwd(), 'public', img.data);
            if (fs.existsSync(filePath)) {
              try {
                const fileBuffer = fs.readFileSync(filePath);
                return {
                  ...img,
                  data: fileBuffer.toString('base64')
                };
              } catch (err) {
                console.error('Failed to read visual image from file:', err);
              }
            }
          }
          return img;
        });
        const aiMode = body.aiMode || 'claude';

        if (aiMode === 'ollama') {
          try {
            const model = "gemma4";
            const ollamaUrl = "http://127.0.0.1:11434/api/generate";
            const ollamaImages = images.map(img => img.data);
            const toolName = TASK_TO_TOOL[body.task];
            const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
            const schemaPrompt = `\n\n[IMPORTANT] You must answer with a JSON object conforming exactly to this schema:
${JSON.stringify(toolDef?.input_schema, null, 2)}
Return raw JSON without markdown blocks. Do NOT wrap inside \`\`\`json ... \`\`\`. Start with { and end with }.`;

            const fullPrompt = prompt + schemaPrompt;

            const ollamaRes = await fetch(ollamaUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                prompt: fullPrompt,
                images: ollamaImages,
                options: {
                  temperature: 0.1
                },
                stream: false,
                format: 'json'
              })
            });

            if (!ollamaRes.ok) {
              const errText = await ollamaRes.text();
              writeJson(res, 502, errorEnvelope('ollama_api_error', `Ollama가 꺼져 있거나 gemma4 모델이 실행 중이지 않습니다. 에러: ${errText}`, true));
              return;
            }

            const ollamaData = await ollamaRes.json();
            const responseText = ollamaData?.response || '{}';

            let parsedOutput: any;
            try {
              parsedOutput = JSON.parse(responseText);
            } catch (parseErr) {
              writeJson(res, 502, errorEnvelope('ollama_invalid_json', `Ollama 응답 JSON 파싱 실패: ${responseText}`, true));
              return;
            }

            const normalized = normalizeToolInput(body.task, parsedOutput);
            if (!normalized.ok) {
              writeJson(res, 200, {
                ok: false,
                error: normalized.error,
                model: model,
                usage: {}
              });
              return;
            }

            writeJson(res, 200, {
              ok: true,
              data: normalized.data,
              model: model,
              usage: {}
            });
            return;

          } catch (error: any) {
            writeJson(res, 502, errorEnvelope('ollama_connection_error', `Ollama 서버 접속 실패. 로컬에 Ollama가 실행 중이고 gemma4 모델이 설치되어 있는지 확인하세요. (${error?.message})`, true));
            return;
          }
        } else {
          const apiKey = env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            writeJson(res, 500, errorEnvelope('missing_api_key', 'ANTHROPIC_API_KEY not configured', false));
            return;
          }

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
        }
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
