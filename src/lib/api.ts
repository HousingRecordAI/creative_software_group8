import type { CapturePlan, CaptureReview, GuidedCaptureStep } from './storage';

export interface DefectItem {
  type: string;
  location: string;
  severity: '경미' | '보통' | '심각';
}

export interface AnalysisData {
  defects: DefectItem[];
  summary: string;
}

const OLLAMA_URL = '/api/ollama/api/generate';
const MODEL_NAME = import.meta.env.VITE_OLLAMA_MODEL || 'gemma4:e4b';

const FALLBACK_CAPTURE_PLANS: Record<string, GuidedCaptureStep[]> = {
  bathroom: [
    { id: 'sink-under-pipe', label: '세면대 하부 배관', guide: '카메라를 낮춰 세면대 아래 배수관 연결부와 하부장 바닥을 함께 찍어주세요.', target: '세면대', angle: 'low' },
    { id: 'sink-silicone', label: '세면대 실리콘 경계', guide: '세면대와 벽이 만나는 실리콘, 수전 주변 물때나 틈이 보이게 가까이 찍어주세요.', target: '세면대', angle: 'detail' },
    { id: 'floor-drain', label: '바닥 배수구', guide: '배수구 주변 타일, 물 고임, 녹, 냄새 차단캡 상태가 보이도록 위에서 찍어주세요.', target: '배수구', angle: 'detail' },
    { id: 'tile-grout', label: '타일 줄눈', guide: '곰팡이, 금 간 타일, 변색된 줄눈이 보이도록 벽면과 바닥 모서리를 찍어주세요.', target: '타일', angle: 'detail' },
    { id: 'toilet-base', label: '변기 하부', guide: '변기와 바닥이 만나는 부분, 실리콘, 누수 흔적이 보이게 낮은 각도로 찍어주세요.', target: '변기', angle: 'low' },
  ],
  kitchen: [
    { id: 'sink-under-pipe', label: '싱크대 하부 배관', guide: '하부장을 열고 배수관 연결부, 누수 흔적, 바닥판 변색을 낮은 각도로 찍어주세요.', target: '싱크대', angle: 'low' },
    { id: 'counter-edge', label: '상판 모서리', guide: '상판 모서리의 들뜸, 찍힘, 실리콘 틈이 보이도록 가까이 찍어주세요.', target: '상판', angle: 'detail' },
    { id: 'cabinet-hinges', label: '수납장 경첩', guide: '문짝 처짐, 경첩 풀림, 내부 찍힘이 보이도록 수납장을 열고 찍어주세요.', target: '수납장', angle: 'detail' },
    { id: 'appliance-surface', label: '가전 표면', guide: '인덕션, 오븐, 냉장고 표면의 금, 눌림, 오염이 보이게 정면에서 찍어주세요.', target: '가전', angle: 'wide' },
  ],
  bedroom: [
    { id: 'wall-corners', label: '벽 모서리', guide: '벽과 천장이 만나는 모서리, 곰팡이, 누수 얼룩이 보이도록 넓게 찍어주세요.', target: '벽', angle: 'wide' },
    { id: 'floor-edge', label: '바닥 가장자리', guide: '걸레받이와 바닥이 만나는 부분의 들뜸, 긁힘, 틈이 보이게 낮은 각도로 찍어주세요.', target: '바닥', angle: 'low' },
    { id: 'window-frame', label: '창틀', guide: '창틀, 유리, 잠금장치, 블라인드 파손이 한 화면에 들어오게 찍어주세요.', target: '창문', angle: 'detail' },
    { id: 'outlet-switch', label: '콘센트와 스위치', guide: '콘센트 깨짐, 그을림, 커버 들뜸이 보이도록 가까이 찍어주세요.', target: '전기 설비', angle: 'detail' },
  ],
  'living-room': [
    { id: 'main-wall', label: '주요 벽면', guide: '못 자국, 긁힘, 얼룩이 빠지지 않도록 벽 전체를 정면에서 찍어주세요.', target: '벽', angle: 'wide' },
    { id: 'floor-wide', label: '바닥 전체', guide: '마루 긁힘, 들뜸, 변색이 보이도록 빛 반사를 피해서 넓게 찍어주세요.', target: '바닥', angle: 'wide' },
    { id: 'window-frame', label: '창문과 창틀', guide: '창틀, 유리, 방충망, 잠금장치 상태가 보이도록 찍어주세요.', target: '창문', angle: 'detail' },
    { id: 'outlet-switch', label: '콘센트와 스위치', guide: '거실 콘센트, 스위치, 벽면 패널의 파손이나 들뜸을 찍어주세요.', target: '전기 설비', angle: 'detail' },
  ],
};

const DEFECT_ANALYSIS_PROMPT = `이 사진에서 다음 항목들을 한국어로 분석해줘:
1. 발견된 하자 목록 (곰팡이, 스크래치, 균열, 누수, 변색 등)
2. 각 하자의 위치와 심각도 (경미/보통/심각)
3. 하자가 없으면 defects를 빈 배열로 반환

아래 JSON 형식으로만 반환해줘:
{
  "defects": [
    { "type": "하자종류", "location": "위치", "severity": "경미|보통|심각" }
  ],
  "summary": "전체 요약"
}`;

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error || body;
  } catch {
    return body;
  }
}

function parseAnalysisData(rawText: string): AnalysisData {
  const match = rawText.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? rawText);
    return {
      defects: Array.isArray(parsed.defects) ? parsed.defects : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '분석 결과 요약이 없습니다.'
    };
  } catch {
    return { defects: [], summary: '분석 결과를 파싱할 수 없습니다.' };
  }
}

function parseJsonObject(rawText: string): any {
  const match = rawText.match(/\{[\s\S]*\}/);
  return JSON.parse(match?.[0] ?? rawText);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '알 수 없는 오류가 발생했습니다.';
}

function dataUrlToBase64(dataUrl: string) {
  return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
}

function normalizeStepId(value: string, fallback: string) {
  return (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || fallback;
}

function getFallbackTasks(roomTypeId: string): GuidedCaptureStep[] {
  const baseType = roomTypeId.replace(/-\d+$/, '');
  return FALLBACK_CAPTURE_PLANS[baseType] || FALLBACK_CAPTURE_PLANS.bedroom;
}

export function createFallbackCapturePlan(roomTypeId: string, roomName: string): CapturePlan {
  return {
    summary: `${roomName}에서 분쟁 증거로 자주 필요한 위치를 기준으로 촬영 목록을 만들었습니다.`,
    tasks: getFallbackTasks(roomTypeId),
    source: 'fallback',
    generatedAt: Date.now(),
    elapsedMs: 0
  };
}

export function createFallbackCaptureReview(step: GuidedCaptureStep, elapsedMs = 0): CaptureReview {
  const hint = step.angle === 'low'
    ? '낮은 각도에서 하부와 연결부가 보이는지 확인하세요.'
    : step.angle === 'detail'
      ? '대상 부위가 프레임 중앙에 선명하게 보이는지 확인하세요.'
      : '공간 맥락과 대상 위치가 함께 보이는지 확인하세요.';

  return {
    status: 'saved',
    message: '사진을 저장했습니다. AI 검수 대신 기본 체크 기준을 적용했습니다.',
    hint,
    source: 'fallback',
    reviewedAt: Date.now(),
    elapsedMs
  };
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
- 각 항목은 사용자가 바로 따라할 수 있는 짧은 촬영 지시문이어야 한다.
- 최대 6개, 최소 3개 항목만 반환한다.

JSON 형식으로만 반환:
{
  "summary": "전체 샷에서 확인한 공간 요약",
  "tasks": [
    {
      "id": "short-kebab-id",
      "label": "촬영 항목명",
      "guide": "사용자에게 보여줄 한 문장 촬영 지시",
      "target": "대상 설비",
      "angle": "wide|detail|low"
    }
  ]
}`;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        prompt,
        images: [dataUrlToBase64(params.imageDataUrl)],
        stream: false,
        format: 'json',
        options: { temperature: 0.2 }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await readErrorBody(response)}`);
    }

    const data = await response.json();
    if (typeof data.response !== 'string' || data.response.trim().length === 0) {
      throw new Error('Ollama 응답에 촬영 목록 JSON이 없습니다.');
    }

    const parsed = parseJsonObject(data.response || '{}');
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.slice(0, 6).map((task: any, index: number): GuidedCaptureStep => ({
          id: normalizeStepId(String(task.id || task.label || ''), `ai-task-${index + 1}`),
          label: String(task.label || `추가 촬영 ${index + 1}`),
          guide: String(task.guide || '대상 부위가 선명하게 보이도록 찍어주세요.'),
          target: typeof task.target === 'string' ? task.target : undefined,
          angle: ['wide', 'detail', 'low'].includes(task.angle) ? task.angle : 'detail'
      }))
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
  const prompt = `너는 임차인 보증금 분쟁용 증거 사진을 검수하는 촬영 감독이다.
사용자는 "${params.roomName}"에서 "${params.step.label}"을 찍으려 한다.
촬영 지시: ${params.step.guide}

사진이 이 촬영 지시를 증거 사진으로 충분히 만족하는지 평가해라.
하자 있음/없음은 판단하지 말고, 사진이 충분한지만 판단한다.

JSON 형식으로만 반환:
{
  "status": "pass|retry",
  "message": "사진 충분 여부를 짧게 설명",
  "hint": "retry일 때 다시 찍는 각도나 위치"
}`;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        prompt,
        images: [dataUrlToBase64(params.imageDataUrl)],
        stream: false,
        format: 'json',
        options: { temperature: 0.1 }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await readErrorBody(response)}`);
    }

    const data = await response.json();
    if (typeof data.response !== 'string' || data.response.trim().length === 0) {
      throw new Error('Ollama 응답에 사진 검수 JSON이 없습니다.');
    }

    const parsed = parseJsonObject(data.response || '{}');
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

export async function analyzeImage(file: File): Promise<AnalysisData> {
  const base64 = await readFileAsBase64(file);

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_NAME,
      prompt: DEFECT_ANALYSIS_PROMPT,
      images: [base64],
      stream: false,
      format: 'json',
      options: { temperature: 0.1 }
    }),
  });

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    throw new Error(`Ollama failed with status ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return parseAnalysisData(data.response || '{}');
}

/**
 * Represents the discrepancy result for a specific room step.
 */
export interface DiscrepancyResult {
  roomId: string;
  stepId: string;
  damageLevel: 'none' | 'low' | 'high';
  notes: string;
}

/**
 * Submits the move-out photos for real AI discrepancy detection using local Ollama.
 */
export async function submitMoveOutReport(moveInPhotos: any, moveOutPhotos: any): Promise<DiscrepancyResult[]> {
  console.log('API Request: POST /api/generate (Real Multimodal Analysis)');
  
  const results: DiscrepancyResult[] = [];

  for (const roomId in moveOutPhotos) {
    for (const stepId in moveOutPhotos[roomId]) {
      const outPhotoFull = moveOutPhotos[roomId][stepId][0]; // data:image/jpeg;base64,...
      const inPhotoFull = moveInPhotos[roomId]?.[stepId]?.[0];

      if (outPhotoFull && inPhotoFull) {
        // Strip the data:image/...;base64, prefix for Ollama
        const outBase64 = outPhotoFull.split(',')[1];
        const inBase64 = inPhotoFull.split(',')[1];

        const prompt = `
Compare these two photos of the same room area: "${roomId} - ${stepId}".
Image 1: Move-in state (Baseline).
Image 2: Move-out state (Current).

Identify any new physical damage (scuffs, cracks, stains, holes) that wasn't there in Image 1. 
Ignore lighting, camera angle, and lens distortion.

Output format (REQUIRED):
1. Damage Level: [none | low | high]
2. Analysis Note: [One sentence description]
        `;

        try {
          const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: MODEL_NAME,
              prompt: prompt,
              images: [inBase64, outBase64],
              stream: false,
              options: { temperature: 0.1 }
            })
          });

          if (!response.ok) {
            const errorBody = await readErrorBody(response);
            console.error(`Ollama Error ${response.status}:`, errorBody);
            throw new Error(`Ollama failed with status ${response.status}: ${errorBody}`);
          }

          const data = await response.json();
          const aiText = data.response || '';
          console.log(`AI Output for ${roomId}/${stepId}:`, aiText);

          // Parse the AI's response for damageLevel and notes
          let damageLevel: 'none' | 'low' | 'high' = 'none';
          if (aiText.toLowerCase().includes('high')) damageLevel = 'high';
          else if (aiText.toLowerCase().includes('low')) damageLevel = 'low';

          results.push({
            roomId,
            stepId,
            damageLevel,
            notes: aiText.split('\n').filter((l: string) => l.trim()).join(' ') // Clean up line breaks
          });

        } catch (error) {
          console.error(`AI analysis failed for ${roomId}/${stepId}:`, error);
          results.push({
            roomId, stepId,
            damageLevel: 'none',
            notes: 'AI analysis unavailable due to network or model error.'
          });
        }
      }
    }
  }

  return results;
}
