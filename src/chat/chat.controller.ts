import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpException,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { once } from 'node:events';
import type { Response } from 'express';
import { AiService } from '../ai/ai.service.js';
import type { AiDelta } from '../ai/ai.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { ChatService } from './chat.service.js';
import type { ChatTurn } from './chat.service.js';

@Controller('conversations')
@UseGuards(AuthGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    @Inject(ChatService) private readonly chats: ChatService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.chats.create(request.user.id, body);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.chats.list(request.user.id);
  }

  @Get('models')
  models() {
    return this.ai.models();
  }

  @Get(':id/messages')
  history(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chats.history(request.user.id, id, before, limit);
  }

  @Post(':id/messages/stream')
  async stream(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const controller = new AbortController();
    const { signal } = controller;
    const disconnect = () => {
      if (!response.writableEnded)
        controller.abort(new Error('Client disconnected'));
    };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    if (request.aborted || response.destroyed) disconnect();
    let turn: ChatTurn | undefined;
    let stream: AsyncGenerator<AiDelta> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let content = '';
    let bytes = 0;
    let finishReason: string | undefined;
    let persisted = false;
    try {
      const { timeoutMs } = this.ai.configuration();
      timeout = setTimeout(
        () => controller.abort(new GatewayTimeoutException('模型回复超时')),
        timeoutMs,
      );
      turn = await this.chats.prepare(request.user.id, id, body, signal);
      signal.throwIfAborted();
      // Validate the upstream status before committing downstream SSE headers.
      stream = await this.ai.openStream(turn.messages, signal, turn.generation);
      signal.throwIfAborted();
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      heartbeat = setInterval(() => {
        if (
          !response.destroyed &&
          !response.writableEnded &&
          !response.writableNeedDrain
        )
          response.write(': ping\n\n');
      }, 15_000);
      await this.event(response, signal, 'start', {
        conversationId: id,
        userMessageId: turn.userMessageId,
        messageId: turn.messageId,
        model: turn.generation?.model,
        reasoningEffort: turn.generation?.reasoningEffort,
      });
      for await (const delta of stream) {
        signal.throwIfAborted();
        if (delta.text) {
          bytes += Buffer.byteLength(delta.text, 'utf8');
          if (bytes > 1_048_576)
            throw new BadGatewayException('模型回复超过长度限制');
          content += delta.text;
          await this.event(response, signal, 'delta', { text: delta.text });
        }
        if (delta.finishReason) finishReason = delta.finishReason;
      }
      signal.throwIfAborted();
      await this.chats.finish(turn, content, 'completed');
      persisted = true;
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      await this.event(response, signal, 'done', {
        messageId: turn.messageId,
        finishReason,
      });
    } catch (error) {
      const timedOut =
        signal.aborted && signal.reason instanceof GatewayTimeoutException;
      const cancelled = signal.aborted && !timedOut;
      controller.abort(error);
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      await stream?.return(undefined).catch(() => {});
      if (turn && !persisted) {
        try {
          await this.chats.finish(
            turn,
            content,
            cancelled ? 'cancelled' : 'failed',
          );
        } catch {
          this.logger.error('无法保存回复状态；生成租约过期后将释放会话');
        }
      }
      if (response.destroyed || cancelled) return;
      const failure = timedOut
        ? new GatewayTimeoutException('模型回复超时')
        : error instanceof HttpException
          ? error
          : new BadGatewayException('聊天服务暂时不可用');
      if (!response.headersSent) throw failure;
      if (!response.writableEnded)
        response.write(
          `event: error\ndata: ${JSON.stringify({ statusCode: failure.getStatus(), message: failure.message })}\n\n`,
        );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      request.off('aborted', disconnect);
      response.off('close', disconnect);
      if (
        response.headersSent &&
        !response.destroyed &&
        !response.writableEnded
      )
        response.end();
    }
  }

  private async event(
    response: Response,
    signal: AbortSignal,
    name: string,
    data: unknown,
  ) {
    signal.throwIfAborted();
    if (!response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
      await once(response, 'drain', { signal });
  }
}
