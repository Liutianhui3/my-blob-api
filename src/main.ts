import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Only explicitly trusted reverse proxies may supply the original client IP.
  const trustedProxies = process.env.TRUST_PROXY?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (trustedProxies?.length) app.set('trust proxy', trustedProxies);
  // The profile editor sends a resized avatar, including its base64 representation.
  app.useBodyParser('json', { limit: '12mb' });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.enableCors({
    origin:
      process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) ??
      '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
