import { Module } from '@nestjs/common';
import { UserModule } from './modules/user.module.js';

@Module({
  imports: [UserModule],
})
export class AppModule {}
