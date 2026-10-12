import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';

@Module({
  imports: [AuthModule, DatabaseModule, AiModule, KnowledgeModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
