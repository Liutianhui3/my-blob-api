import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { sessionToken } from './session-token.js';

// 保留现有 /users 认证地址，前端无需调整。
@Controller('users')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: unknown) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() request: Request) {
    return this.auth.login(
      body,
      request.ip || request.socket.remoteAddress || '',
    );
  }

  @Get('me')
  me(@Req() request: Request) {
    return this.auth.me(sessionToken(request));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request) {
    await this.auth.logout(sessionToken(request));
  }
}
