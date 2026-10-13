import { AdminGuard } from '../auth/guards/admin.guard.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ArticleService } from './article.service.js';

@Controller('articles')
export class ArticleController {
  constructor(
    @Inject(ArticleService) private readonly articles: ArticleService,
  ) {}
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.articles.list(query);
  }
  @Get('manage')
  @UseGuards(AuthGuard, AdminGuard)
  manage(@Query() query: Record<string, unknown>) {
    return this.articles.list(query, true);
  }
  @Get('manage/:id')
  @UseGuards(AuthGuard, AdminGuard)
  edit(@Param('id') id: string) {
    return this.articles.get(id, true);
  }
  @Get(':id')
  get(@Param('id') id: string) {
    return this.articles.get(id);
  }
  @Post()
  @UseGuards(AuthGuard, AdminGuard)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.articles.create(req.user.id, body);
  }
  @Patch(':id')
  @UseGuards(AuthGuard, AdminGuard)
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.articles.update(id, body);
  }
  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AuthGuard, AdminGuard)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.articles.remove(id);
  }
}
