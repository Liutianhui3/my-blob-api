import { AdminGuard } from './guards/admin.guard.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './guards/auth.guard.js';
import { CaptchaService } from './captcha.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, AdminGuard, CaptchaService],
  exports: [AuthService, AuthGuard, AdminGuard],
})
export class AuthModule {}
