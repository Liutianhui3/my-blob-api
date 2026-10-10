import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { UserModule } from './user/user.module.js';

@Module({
  // 先注册认证静态路由（/users/me），再注册 /users/:id。
  imports: [AuthModule, UserModule],
})
export class AppModule {}
