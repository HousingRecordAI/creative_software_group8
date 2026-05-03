import type { CapturePlan, CaptureReview, GuidedCaptureStep } from './storage';

const AI_GENERATE_URL = '/api/ai/generate';

type AiImageInput = {
  data: string;
  mediaType: string;
};

type AiTask = 'capture_plan' | 'capture_review';

type AiGenerateParams = {
  label: string;
  task: AiTask;
  prompt: string;
  images: AiImageInput[];
  maxTokens: number;
  temperature: number;
};

type AiErrorResponse = {
  code?: string;
  message?: string;
  retryable?: boolean;
  hint?: string;
};

type CapturePlanPayload = {
  summary?: string;
  tasks?: Array<Partial<GuidedCaptureStep>>;
};

type CaptureReviewPayload = {
  status?: 'pass' | 'retry';
  message?: string;
  hint?: string;
};

function previewText(value: string, maxLength = 260) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

async function readAiStructuredData<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${label} 응답 본문이 비어 있습니다.`);
  }

  let data: any;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} HTTP 응답 JSON 파싱 실패: ${getErrorMessage(error)} · body="${previewText(body)}"`);
  }

  if (!response.ok) {
    throw new Error(formatAiError(data, `${label} 요청 실패`));
  }

  if (data?.ok === false) {
    throw new Error(formatAiError(data, `${label}을 처리할 수 없습니다.`));
  }

  if (data?.ok !== true || typeof data !== 'object' || data.data === undefined) {
    throw new Error(`${label} 표준 응답 형식이 아닙니다. body="${previewText(body)}"`);
  }

  return data.data as T;
}

function formatAiError(data: any, fallback: string) {
  if (typeof data?.error === 'string' && data.error.trim()) {
    return data.error;
  }
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) {
    const hint = typeof data.error.hint === 'string' && data.error.hint.trim()
      ? ` ${data.error.hint.trim()}`
      : '';
    return `${data.error.message.trim()}${hint}`;
  }
  return fallback;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '알 수 없는 오류가 발생했습니다.';
}

function dataUrlToAiImage(dataUrl: string, fallbackMediaType = 'image/jpeg'): AiImageInput {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  if (match) {
    return {
      mediaType: match[1],
      data: match[2]
    };
  }

  return {
    mediaType: fallbackMediaType,
    data: dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  };
}

function normalizeStepId(value: string, fallback: string) {
  return (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || fallback;
}

async function generateWithClaude<T>(params: AiGenerateParams): Promise<T> {
  const response = await fetch(AI_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: params.task,
      prompt: params.prompt,
      images: params.images,
      maxTokens: params.maxTokens,
      temperature: params.temperature
    }),
  });

  return readAiStructuredData<T>(response, params.label);
}

export async function generateCapturePlanFromOverview(params: {
  roomName: string;
  roomTypeId: string;
  imageDataUrl: string;
}): Promise<CapturePlan> {
  const startedAt = performance.now();
  const prompt = `너는 임차인 보증금 분쟁을 대비하는 사진 촬영 감독이다.
사용자가 "${params.roomName}"의 전체 샷을 찍었다.
사진에서 보이는 설비와 구조를 바탕으로, 나중에 분쟁 증거로 빠지면 안 되는 추가 촬영 목록을 만들어라.

중요 원칙:
- "하자 있음/없음"을 단정하지 말고, 증거로 확인해야 하는 위치를 제안한다.
- 세면대, 싱크대, 변기, 배수구처럼 아래쪽/하부가 중요한 설비는 반드시 낮은 각도 촬영을 제안한다.
- 한 장으로 부족한 설비나 가려진 영역은 minPhotos를 2 또는 3으로 올린다.
- coverageCriteria에는 사용자가 빠뜨리면 안 되는 시야 요소를 2~4개 넣는다.
- 각 항목은 사용자가 바로 따라할 수 있는 짧은 촬영 지시문이어야 한다.
- 최대 8개, 최소 3개 항목만 반환한다.

이미지가 실내 전체 샷으로 보기 어렵거나 공간 구조를 판단할 수 없으면 촬영 목록을 만들지 말고 재촬영이 필요하다고 반환한다.
반드시 제공된 구조화 도구의 입력 스키마에 맞춰 반환한다.`;

  try {
    const parsed = await generateWithClaude<CapturePlanPayload>({
      label: '촬영 계획',
      task: 'capture_plan',
      prompt,
      images: [dataUrlToAiImage(params.imageDataUrl)],
      maxTokens: 1800,
      temperature: 0.2
    });
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.slice(0, 8).map((task: any, index: number): GuidedCaptureStep => {
          const minPhotos = Number(task.minPhotos);
          const coverageCriteria = Array.isArray(task.coverageCriteria)
            ? task.coverageCriteria
                .filter((item: unknown) => typeof item === 'string' && item.trim())
                .slice(0, 4)
                .map((item: string) => item.trim())
            : undefined;

          return {
            id: normalizeStepId(String(task.id || task.label || ''), `ai-task-${index + 1}`),
            label: String(task.label || `추가 촬영 ${index + 1}`),
            guide: String(task.guide || '대상 부위가 선명하게 보이도록 찍어주세요.'),
            target: typeof task.target === 'string' ? task.target : undefined,
            angle: ['wide', 'detail', 'low'].includes(task.angle) ? task.angle : 'detail',
            minPhotos: Number.isFinite(minPhotos) ? Math.min(3, Math.max(1, Math.round(minPhotos))) : 1,
            coverageCriteria
          };
        })
      : [];

    if (tasks.length < 3) {
      throw new Error(`AI 촬영 목록이 ${tasks.length}개만 생성되었습니다. 최소 3개가 필요합니다.`);
    }

    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary
        : `${params.roomName} 전체 샷을 바탕으로 AI 촬영 목록을 만들었습니다.`,
      tasks,
      source: 'ai',
      generatedAt: Date.now(),
      elapsedMs: Math.round(performance.now() - startedAt)
    };
  } catch (error) {
    console.warn('AI capture plan generation failed:', error);
    throw new Error(`AI 촬영 목록 생성 실패: ${getErrorMessage(error)}`);
  }
}

export async function reviewGuidedCapture(params: {
  roomName: string;
  step: GuidedCaptureStep;
  imageDataUrl: string;
}): Promise<CaptureReview> {
  const startedAt = performance.now();
  const criteriaText = params.step.coverageCriteria?.length
    ? `\n이 체크포인트에서 반드시 확인해야 할 요소: ${params.step.coverageCriteria.join(', ')}`
    : '';
  const prompt = `너는 임차인 보증금 분쟁용 증거 사진을 검수하는 촬영 감독이다.
사용자는 "${params.roomName}"에서 "${params.step.label}"을 찍으려 한다.
촬영 지시: ${params.step.guide}
필요 통과 사진 수: ${params.step.minPhotos || 1}장${criteriaText}

사진이 이 촬영 지시를 증거 사진으로 충분히 만족하는지 평가해라.
하자 있음/없음은 판단하지 말고, 사진이 충분한지만 판단한다.

사진이 촬영 지시와 무관하거나 너무 흐리면 retry로 판단하고, 사용자가 다시 찍을 수 있는 구체적인 hint를 제공한다.
반드시 제공된 구조화 도구의 입력 스키마에 맞춰 반환한다.`;

  try {
    const parsed = await generateWithClaude<CaptureReviewPayload>({
      label: '사진 검수',
      task: 'capture_review',
      prompt,
      images: [dataUrlToAiImage(params.imageDataUrl)],
      maxTokens: 500,
      temperature: 0.1
    });
    if (parsed.status !== 'pass' && parsed.status !== 'retry') {
      throw new Error('AI 검수 응답의 status가 pass 또는 retry가 아닙니다.');
    }

    const status = parsed.status;
    return {
      status,
      message: typeof parsed.message === 'string'
        ? parsed.message
        : status === 'pass'
          ? '증거 사진으로 충분합니다.'
          : '촬영 대상이 충분히 보이지 않습니다.',
      hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
      source: 'ai',
      reviewedAt: Date.now(),
      elapsedMs: Math.round(performance.now() - startedAt)
    };
  } catch (error) {
    console.warn('AI capture review failed:', error);
    throw new Error(`AI 사진 검수 실패: ${getErrorMessage(error)}`);
  }
}
