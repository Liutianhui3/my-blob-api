import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
