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

function previewText(value: string, maxLength = 260) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

async function readOllamaGenerateText(response: Response, label: string): Promise<string> {
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

  if (typeof data.response !== 'string' || data.response.trim().length === 0) {
    throw new Error(`${label} 응답에 모델 출력 JSON이 없습니다. body="${previewText(body)}"`);
  }

  return data.response;
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

function parseJsonObject(rawText: string, label = '모델 출력'): any {
  const match = rawText.match(/\{[\s\S]*\}/);
  const jsonText = match?.[0] ?? rawText;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} JSON 파싱 실패: ${getErrorMessage(error)} · output="${previewText(rawText)}"`);
  }
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

JSON 형식으로만 반환:
{
  "summary": "전체 샷에서 확인한 공간 요약",
  "tasks": [
    {
      "id": "short-kebab-id",
      "label": "촬영 항목명",
      "guide": "사용자에게 보여줄 한 문장 촬영 지시",
      "target": "대상 설비",
      "angle": "wide|detail|low",
      "minPhotos": 1,
      "coverageCriteria": ["반드시 보여야 하는 요소"]
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
        options: { temperature: 0.2, num_predict: 1600 }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await readErrorBody(response)}`);
    }

    const modelOutput = await readOllamaGenerateText(response, '촬영 계획');
    const parsed = parseJsonObject(modelOutput, '촬영 계획');
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
        options: { temperature: 0.1, num_predict: 500 }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await readErrorBody(response)}`);
    }

    const modelOutput = await readOllamaGenerateText(response, '사진 검수');
    const parsed = parseJsonObject(modelOutput, '사진 검수');
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
