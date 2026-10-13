import {
  Body,
  Controller,
  Inject,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RolesService } from './roles.service.js';
@Controller('admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.roles.list(query);
  }
  @Patch(':id/role')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.roles.update(req.user.id, id, body);
  }
}
