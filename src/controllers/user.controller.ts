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
} from '@nestjs/common';
import type { Request } from 'express';
import { UserService } from '../services/user.service.js';

@Controller('users')
export class UserController {
  constructor(@Inject(UserService) private readonly users: UserService) {}

  @Post('register')
  register(@Body() body: unknown) {
    return this.users.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.users.login(body);
  }

  @Get('me')
  me(@Req() request: Request) {
    return this.users.me(this.sessionToken(request));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request) {
    await this.users.logout(this.sessionToken(request));
  }

  private sessionToken(request: Request) {
    const authorization = request.headers.authorization;
    return authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? '';
  }

  @Get()
  async list(@Req() request: Request) {
    await this.users.me(this.sessionToken(request));
    return this.users.list();
  }

  @Get(':id')
  async find(@Param('id') id: string, @Req() request: Request) {
    await this.users.me(this.sessionToken(request));
    return this.users.find(id);
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: Request) {
    await this.users.me(this.sessionToken(request));
    return this.users.create(body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    await this.users.me(this.sessionToken(request));
    return this.users.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() request: Request) {
    await this.users.me(this.sessionToken(request));
    await this.users.remove(id);
  }
}
