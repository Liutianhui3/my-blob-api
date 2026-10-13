import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ArticleService } from './article.service.js';
import { ArticleController } from './article.controller.js';
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ArticleController],
  providers: [ArticleService],
})
export class ArticleModule {}
