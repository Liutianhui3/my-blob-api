import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { captcha } from 'tencentcloud-sdk-nodejs-captcha';

@Injectable()
export class CaptchaService {
  async verify(body: unknown, userIp: string) {
    const value = body as Record<string, unknown>;
    const ticket = value?.captchaTicket;
    const randstr = value?.captchaRandstr;
    if (
      typeof ticket !== 'string' ||
      !ticket ||
      ticket.length > 4096 ||
      typeof randstr !== 'string' ||
      !randstr ||
      randstr.length > 256 ||
      ticket.startsWith('trerror')
    ) {
      throw new BadRequestException('请完成真人验证后重试');
    }
    const appId = process.env.TENCENT_CAPTCHA_APP_ID || '';
    const appSecretKey = process.env.TENCENT_CAPTCHA_APP_SECRET_KEY;
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    if (
      !/^\d+$/.test(appId) ||
      !appSecretKey ||
      !secretId ||
      !secretKey ||
      !isIP(userIp)
    ) {
      throw new ServiceUnavailableException(
        '真人验证服务尚未配置，请联系管理员',
      );
    }
    let code: number | undefined;
    try {
      const client = new captcha.v20190722.Client({
        credential: { secretId, secretKey },
        region: '',
        profile: {
          httpProfile: {
            endpoint: 'captcha.tencentcloudapi.com',
            reqTimeout: 10,
          },
        },
      });
      const result = await client.DescribeCaptchaResult({
        CaptchaType: 9,
        Ticket: ticket,
        Randstr: randstr,
        UserIp: userIp,
        CaptchaAppId: Number(appId),
        AppSecretKey: appSecretKey,
      });
      code = result.CaptchaCode;
    } catch {
      // Never expose SDK errors, which may contain request details or secrets.
      throw new ServiceUnavailableException('真人验证服务暂不可用，请稍后重试');
    }
    if (code !== 1)
      throw new BadRequestException('真人验证未通过或已过期，请重新验证');
  }
}
