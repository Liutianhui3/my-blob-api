import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

@Injectable()
export class EmbeddingService {
  configuration() {
    const key = process.env.EMBEDDING_API_KEY?.trim();
    const base = process.env.EMBEDDING_BASE_URL?.trim();
    const model = process.env.EMBEDDING_MODEL?.trim();
    if (!key || !base || model !== 'BAAI/bge-m3')
      throw new ServiceUnavailableException(
        '请配置 EMBEDDING_API_KEY、EMBEDDING_BASE_URL 和 EMBEDDING_MODEL=BAAI/bge-m3',
      );
    let url: URL;
    try {
      url = new URL(`${base.replace(/\/+$/, '')}/embeddings`);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException('EMBEDDING_BASE_URL 无效');
    }
    return { key, url, model };
  }

  async embed(texts: string[], signal?: AbortSignal) {
    const config = this.configuration();
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += 16) {
      const input = texts.slice(start, start + 16);
      try {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            input,
            encoding_format: 'float',
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error();
        const payload = await response.json();
        if (
          !Array.isArray(payload.data) ||
          payload.data.length !== input.length
        )
          throw new Error();
        const batch: number[][] = [];
        for (const item of payload.data) {
          if (
            !Number.isInteger(item.index) ||
            item.index < 0 ||
            item.index >= input.length ||
            batch[item.index] ||
            !Array.isArray(item.embedding) ||
            item.embedding.length !== 1024 ||
            !item.embedding.every(
              (value: unknown) =>
                typeof value === 'number' && Number.isFinite(value),
            ) ||
            !item.embedding.some((value: number) => value !== 0)
          )
            throw new Error();
          batch[item.index] = item.embedding;
        }
        vectors.push(...batch);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new BadGatewayException(
          '向量服务调用失败，请检查模型配置、额度和网络',
        );
      }
    }
    return { model: config.model, vectors };
  }
}
