import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { EmbeddingService } from './embedding.service.js';
import { RagService } from './rag.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, EmbeddingService, RagService],
  exports: [RagService],
})
export class KnowledgeModule {}
