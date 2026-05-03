interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_MODEL?: string;
}

type AiImageInput = {
  data: string;
  mediaType: string;
};

type AiGenerateRequest = {
  task?: AiTask;
  prompt?: string;
  images?: AiImageInput[];
  maxTokens?: number;
  temperature?: number;
};

type AiTask = 'capture_plan' | 'capture_review' | 'defect_analysis' | 'move_out_comparison';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEMO_CAPTURE_TASK_LIMIT = 2;
const DEMO_CAPTURE_MIN_TASKS = 1;
const DEMO_COVERAGE_CRITERIA_LIMIT = 2;
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(errorEnvelope('missing_api_key', 'ANTHROPIC_API_KEY not configured', false), 500);
  }

  let body: AiGenerateRequest;
  try {
    body = await request.json();
  } catch {
    return json(errorEnvelope('invalid_json', 'Invalid JSON body', false), 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return json(errorEnvelope('missing_prompt', 'Missing prompt', false), 400);
  }

  if (!isAiTask(body.task)) {
    return json(errorEnvelope('unsupported_task', 'Missing or unsupported AI task', false), 400);
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
    return json(errorEnvelope('claude_api_error', `Claude API error: ${errorText}`, true), 502);
  }

  const claudeData: any = await claudeRes.json();
  const toolInput = extractToolInput(claudeData, toolName);
  if (!toolInput) {
    return json(errorEnvelope('missing_tool_output', 'Claude returned no structured tool output', true), 502);
  }

  const normalized = normalizeToolInput(body.task, toolInput);
  if (!normalized.ok) {
    return json({
      ok: false,
      error: normalized.error,
      model: claudeData.model || model,
      usage: claudeData.usage,
    }, 200);
  }

  return json({
    ok: true,
    data: normalized.data,
    model: claudeData.model || model,
    usage: claudeData.usage,
  }, 200);
};

function toClaudeImageBlock(image: AiImageInput) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType || 'image/jpeg',
      data: image.data,
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

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
