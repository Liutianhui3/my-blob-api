import {
  Body,
  Controller,
  Inject,
  Patch,
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

  // Expose only self-service routes until administrator authorization exists.
  @Patch('me')
  updateProfile(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.users.updateProfile(request.user.id, body);
  }
}
