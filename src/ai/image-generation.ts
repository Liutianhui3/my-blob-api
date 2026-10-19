import { BadGatewayException } from '@nestjs/common';

export const imageTool = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Create an image when the user asks you to draw, generate or create a picture. Do not use this for questions about existing images. Describe the requested image in detail in prompt.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 12_000_000) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    return value;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[<>\r\n]/.test(value)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function imageMarkdown(value: unknown): string {
  const url = safeImageUrl(value);
  if (!url) throw new BadGatewayException('图片服务返回的图片格式无效');
  return `\n\n![AI 生成的图片](<${url}>)\n\n`;
}

export async function generateImage(options: {
  apiKey: string;
  chatUrl: URL;
  model: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(
    new URL('../images/generations', options.chatUrl),
    {
      method: 'POST',
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        n: 1,
        size: '1024x1024',
        quality: 'auto',
        output_format: 'png',
        response_format: 'url',
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new BadGatewayException(
      '图片生成失败，请确认服务商的 /images/generations 接口和 AI_IMAGE_MODEL 配置',
    );
  }
  // Bound the response before JSON parsing, including base64 image payloads.
  const reader = response.body?.getReader();
  if (!reader) throw new BadGatewayException('图片服务返回空响应');
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12_000_000)
        throw new BadGatewayException('生成图片过大，请降低图片尺寸后重试');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BadGatewayException('图片服务响应格式无效');
  }
  const image = payload?.data?.[0];
  if (image?.url) return imageMarkdown(image.url);
  if (typeof image?.b64_json === 'string') {
    const mime = image.b64_json.startsWith('/9j/')
      ? 'jpeg'
      : image.b64_json.startsWith('UklGR')
        ? 'webp'
        : 'png';
    return imageMarkdown(`data:image/${mime};base64,${image.b64_json}`);
  }
  throw new BadGatewayException('图片服务未返回图片');
}
