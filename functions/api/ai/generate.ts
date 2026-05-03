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
  prompt?: string;
  images?: AiImageInput[];
  maxTokens?: number;
  temperature?: number;
};

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: AiGenerateRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return json({ error: 'Missing prompt' }, 400);
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
    return json({ error: `Claude API error: ${errorText}` }, 502);
  }

  const claudeData: any = await claudeRes.json();
  const response = extractClaudeText(claudeData);
  if (!response) {
    return json({ error: 'Claude returned no text content' }, 502);
  }

  return json({
    response,
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

function extractClaudeText(data: any) {
  return Array.isArray(data.content)
    ? data.content
        .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text)
        .join('\n')
        .trim()
    : '';
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
