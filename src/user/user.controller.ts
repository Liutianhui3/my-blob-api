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
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { UserService } from './user.service.js';

@Controller('users')
@UseGuards(AuthGuard)
export class UserController {
  constructor(@Inject(UserService) private readonly users: UserService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Get(':id')
  find(@Param('id') id: string) {
    return this.users.find(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.users.create(body);
  }

  @Patch('me')
  updateProfile(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.users.updateProfile(request.user.id, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.users.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.users.remove(id);
  }
}
