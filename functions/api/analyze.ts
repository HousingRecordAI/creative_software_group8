interface Env {
  ANTHROPIC_API_KEY: string;
}

interface DefectItem {
  type: string;
  location: string;
  severity: '경미' | '보통' | '심각';
}

interface AnalysisData {
  defects: DefectItem[];
  summary: string;
}

const PROMPT = `이 사진에서 다음 항목들을 한국어로 분석해줘:
1. 발견된 하자 목록 (곰팡이, 스크래치, 균열, 누수, 변색 등)
2. 각 하자의 위치와 심각도 (경미/보통/심각)
3. 하자가 없으면 defects를 빈 배열로 반환

반드시 제공된 구조화 도구의 입력 스키마에 맞춰 반환해줘.`;

const DEFECT_ANALYSIS_TOOL = {
  name: 'analyze_defects',
  description: 'Return structured visible defect analysis for an interior photo.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      error: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
        },
        required: ['code', 'message', 'retryable'],
      },
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
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: { image: string; mediaType: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { image, mediaType } = body;
  if (!image || !mediaType) {
    return json({ error: 'Missing image or mediaType' }, 400);
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'Use the forced tool exactly once. Do not return free-form text.',
      tools: [DEFECT_ANALYSIS_TOOL],
      tool_choice: { type: 'tool', name: 'analyze_defects' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return json({ error: `Claude API error: ${errText}` }, 502);
  }

  const claudeData: any = await claudeRes.json();
  const toolInput = Array.isArray(claudeData.content)
    ? claudeData.content.find((item: any) => item?.type === 'tool_use' && item.name === 'analyze_defects')?.input
    : null;

  if (!toolInput || typeof toolInput !== 'object') {
    return json({ error: 'Claude returned no structured tool output' }, 502);
  }

  if (toolInput.ok === false) {
    return json({
      defects: [],
      summary: typeof toolInput.error?.message === 'string'
        ? toolInput.error.message
        : '하자 분석 대상 사진으로 판단하기 어렵습니다.',
    }, 200);
  }

  return json({
    defects: Array.isArray(toolInput.defects) ? toolInput.defects.map(normalizeDefect).filter(Boolean) : [],
    summary: typeof toolInput.summary === 'string' && toolInput.summary.trim()
      ? toolInput.summary.trim()
      : '분석 결과 요약이 없습니다.',
  }, 200);
};

function normalizeDefect(defect: any): DefectItem | null {
  if (!defect || typeof defect !== 'object') return null;
  return {
    type: typeof defect.type === 'string' && defect.type.trim() ? defect.type.trim() : '하자',
    location: typeof defect.location === 'string' && defect.location.trim() ? defect.location.trim() : '위치 미상',
    severity: ['경미', '보통', '심각'].includes(defect.severity) ? defect.severity : '경미',
  };
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
