import { Module } from '@nestjs/common';
import { UserController } from '../controllers/user.controller.js';
import { UserService } from '../services/user.service.js';
import { DatabaseService } from '../database/database.service.js';

@Module({
  controllers: [UserController],
  providers: [UserService, DatabaseService],
})
export class UserModule {}
