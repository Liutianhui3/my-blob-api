import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sseData } from './sse.js';
import { modelCatalog, resolveGeneration } from './model-catalog.js';
import type { GenerationOptions, GenerationSettings } from './model-catalog.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HistoryTurn {
  user: string;
  assistant: string;
}

export interface AiDelta {
  text?: string;
  finishReason?: 'stop' | 'length';
}

@Injectable()
export class AiService {
  models() {
    const { model } = this.configuration();
    // Expose configured choices without provider credentials or transport details.
    return {
      defaultModel: model,
      models: modelCatalog(model).map(
        ({ tokenParameter: _tokenParameter, ...item }) => item,
      ),
    };
  }

  resolveGeneration(options?: GenerationOptions) {
    return resolveGeneration(this.configuration().model, options);
  }

  configuration() {
    const apiKey = process.env.AI_API_KEY?.trim();
    const model = process.env.AI_MODEL?.trim();
    const baseUrl = process.env.AI_BASE_URL?.trim();
    if (!apiKey || !model || !baseUrl)
      throw new ServiceUnavailableException(
        '请配置 AI_API_KEY、AI_BASE_URL 和 AI_MODEL',
      );
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid model URL');
    } catch {
      throw new ServiceUnavailableException('AI_BASE_URL 配置无效');
    }
    return {
      apiKey,
      model,
      url,
      systemPrompt:
        process.env.AI_SYSTEM_PROMPT || '你是一个有帮助的中文助手。',
      timeoutMs: this.integer('AI_TIMEOUT_MS', 120_000, 1_000, 600_000),
      maxTokens: this.integer('AI_MAX_TOKENS', 2048, 1, 32_768),
      contextMaxBytes: this.integer(
        'AI_CONTEXT_MAX_BYTES',
        24_000,
        1024,
        1_000_000,
      ),
    };
  }

  buildMessages(history: HistoryTurn[], content: string): AiMessage[] {
    const { systemPrompt, contextMaxBytes } = this.configuration();
    const system: AiMessage = { role: 'system', content: systemPrompt };
    const current: AiMessage = { role: 'user', content };
    let size = this.messageBytes(system) + this.messageBytes(current);
    if (size > contextMaxBytes)
      throw new BadRequestException('当前消息超过模型输入预算，请缩短内容');
    const selected: AiMessage[] = [];
    // Keep a contiguous suffix of completed pairs; never include orphan replies.
    for (const turn of [...history].reverse()) {
      const pair: AiMessage[] = [
        { role: 'user', content: turn.user },
        { role: 'assistant', content: turn.assistant },
      ];
      const pairSize = pair.reduce(
        (sum, message) => sum + this.messageBytes(message),
        0,
      );
      if (size + pairSize > contextMaxBytes) break;
      size += pairSize;
      selected.unshift(...pair);
    }
    return [system, ...selected, current];
  }

  async openStream(
    messages: AiMessage[],
    signal: AbortSignal,
    settings?: GenerationSettings,
  ) {
    const { apiKey, url, maxTokens } = this.configuration();
    const { model, reasoningEffort, tokenParameter } =
      settings ?? this.resolveGeneration();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          [tokenParameter]: maxTokens,
          ...(reasoningEffort === 'auto'
            ? {}
            : { reasoning_effort: reasoningEffort }),
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BadGatewayException('无法连接模型服务');
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      await response.body?.cancel().catch(() => {});
      throw new BadGatewayException('模型服务未返回有效的流式响应');
    }
    return this.readCompletion(response.body, signal);
  }

  private async *readCompletion(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<AiDelta> {
    let finished = false;
    let hasText = false;
    try {
      for await (const data of sseData(body)) {
        signal.throwIfAborted();
        if (data === '[DONE]') {
          if (!finished || !hasText) throw new Error('Incomplete model reply');
          return;
        }
        const chunk = JSON.parse(data);
        if (!chunk || chunk.error || !Array.isArray(chunk.choices))
          throw new Error('Invalid model event');
        const choice = chunk.choices.find(
          (item: { index: number }) => item.index === 0,
        );
        if (!choice) continue; // Some services append a usage-only event.
        if (choice.delta?.tool_calls || choice.delta?.function_call)
          throw new Error('Tool calls are not supported');
        const text = choice.delta?.content;
        if (text !== undefined && text !== null && typeof text !== 'string')
          throw new Error('Invalid model content');
        if (text) {
          if (finished) throw new Error('Content after completion');
          hasText = true;
          yield { text };
        }
        if (choice.finish_reason != null) {
          if (!['stop', 'length'].includes(choice.finish_reason))
            throw new Error('Model did not produce a text completion');
          finished = true;
          yield { finishReason: choice.finish_reason };
        }
      }
      throw new Error('Model stream ended without DONE');
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BadGatewayException('模型输出中断或格式不正确');
    }
  }

  private messageBytes(message: AiMessage) {
    return Buffer.byteLength(message.content, 'utf8') + 32;
  }

  private integer(name: string, fallback: number, min: number, max: number) {
    const raw = process.env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new ServiceUnavailableException(`${name} 配置无效`);
    return value;
  }
}
