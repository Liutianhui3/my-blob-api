import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { UserModule } from './user/user.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  // 用户接口仅提供认证和当前账号的个人资料操作。
  imports: [AuthModule, UserModule, ChatModule],
})
export class AppModule {}
