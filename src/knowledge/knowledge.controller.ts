import type {} from 'multer';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { KnowledgeService } from './knowledge.service.js';

@Controller('knowledge-bases')
@UseGuards(AuthGuard)
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
  ) {}
  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.knowledge.list(req.user.id);
  }
  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: { name?: unknown; description?: unknown },
  ) {
    return this.knowledge.create(req.user.id, body);
  }
  @Get(':id/documents')
  documents(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.knowledge.documents(req.user.id, id);
  }
  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024, files: 1, fields: 2, fieldSize: 100 },
    }),
  )
  upload(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { chunkSize?: string; chunkOverlap?: string },
  ) {
    return this.knowledge.upload(req.user.id, id, file, body);
  }
  @Get(':id/documents/:documentId/chunks')
  chunks(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Query('page') page?: string,
  ) {
    return this.knowledge.chunks(req.user.id, id, documentId, page);
  }
  @Delete(':id/documents/:documentId')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.knowledge.removeDocument(req.user.id, id, documentId);
  }

  @Post(':id/documents/:documentId/embeddings')
  embedDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.knowledge.embedDocument(req.user.id, id, documentId);
  }

  @Post(':id/search')
  search(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { query?: unknown; limit?: unknown },
  ) {
    return this.knowledge.search(req.user.id, id, body);
  }
}
