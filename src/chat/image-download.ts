import { BadGatewayException, BadRequestException } from '@nestjs/common';

function allowedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('图片地址无效');
  }
  const extra = (process.env.AI_IMAGE_DOWNLOAD_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  // Only provider storage and explicitly configured hosts. Never proxy arbitrary URLs.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !(url.hostname.endsWith('.r2.dev') || extra.includes(url.hostname))
  )
    throw new BadRequestException('图片地址不在允许的下载域名中');
  return url;
}

export async function downloadRemoteImage(source: string, signal: AbortSignal) {
  let url = allowedImageUrl(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'image/png,image/jpeg,image/webp' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 3)
        throw new BadGatewayException('图片下载重定向异常');
      url = allowedImageUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new BadGatewayException('无法下载图片，图片链接可能已过期');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20 * 1024 * 1024)
          throw new BadGatewayException('图片文件超过 20 MB');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const format = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'webp'
          : null;
    if (!format)
      throw new BadGatewayException(
        '下载内容不是有效的 PNG、JPEG 或 WebP 图片',
      );
    return {
      bytes,
      mime: `image/${format}`,
      extension: format === 'jpeg' ? 'jpg' : format,
    };
  }
  throw new BadGatewayException('无法下载图片');
}
