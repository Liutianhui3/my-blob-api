import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captcha } from 'tencentcloud-sdk-nodejs-captcha';
import { CaptchaService } from '../dist/auth/captcha.service.js';
import { AuthService } from '../dist/auth/auth.service.js';

test('Tencent CAPTCHA passes only validated tickets and fails closed', async () => {
  const keys = [
    'TENCENT_CAPTCHA_APP_ID',
    'TENCENT_CAPTCHA_APP_SECRET_KEY',
    'TENCENT_SECRET_ID',
    'TENCENT_SECRET_KEY',
  ];
  const original = keys.map((key) => process.env[key]);
  const prototype = captcha.v20190722.Client.prototype;
  const originalCall = prototype.DescribeCaptchaResult;
  const service = new CaptchaService();
  const proof = { captchaTicket: 'test-ticket', captchaRandstr: 'test-random' };
  let calls = 0;
  try {
    await assert.rejects(service.verify({}, '127.0.0.1'), /完成真人验证/);
    await assert.rejects(
      service.verify(
        { ...proof, captchaTicket: 'trerror-fallback' },
        '127.0.0.1',
      ),
      /完成真人验证/,
    );
    keys.forEach((key) => delete process.env[key]);
    await assert.rejects(service.verify(proof, '127.0.0.1'), /尚未配置/);
    keys.forEach(
      (key, i) => (process.env[key] = i === 0 ? '123' : 'test-only'),
    );
    prototype.DescribeCaptchaResult = async function (params) {
      calls++;
      assert.equal(params.Ticket, proof.captchaTicket);
      assert.equal(params.Randstr, proof.captchaRandstr);
      assert.equal(params.CaptchaType, 9);
      assert.equal(params.CaptchaAppId, 123);
      assert.equal(params.UserIp, '127.0.0.1');
      return { CaptchaCode: 1 };
    };
    await service.verify(proof, '127.0.0.1');
    assert.equal(calls, 1);
    await assert.rejects(service.verify(proof, 'spoofed'), /尚未配置/);
    for (const code of [7, 8, 9, 21, 100, undefined]) {
      prototype.DescribeCaptchaResult = async () => ({ CaptchaCode: code });
      await assert.rejects(
        service.verify(proof, '127.0.0.1'),
        /未通过或已过期/,
      );
    }
    prototype.DescribeCaptchaResult = async () => {
      throw new Error('private SDK details');
    };
    await assert.rejects(
      service.verify(proof, '127.0.0.1'),
      (error) => error.message === '真人验证服务暂不可用，请稍后重试',
    );
  } finally {
    prototype.DescribeCaptchaResult = originalCall;
    keys.forEach((key, i) =>
      original[i] === undefined
        ? delete process.env[key]
        : (process.env[key] = original[i]),
    );
  }
});

test('login rejects CAPTCHA before any database or password work', async () => {
  let queried = false;
  const service = new AuthService(
    {
      pool: {
        query: async () => {
          queried = true;
        },
      },
    },
    {
      verify: async (_body, ip) => {
        assert.equal(ip, '127.0.0.1');
        throw new Error('verification failed');
      },
    },
  );
  await assert.rejects(
    service.login(
      {
        username: 'reader',
        password: 'Secure123!',
        captchaTicket: 't',
        captchaRandstr: 'r',
      },
      '127.0.0.1',
    ),
    /verification failed/,
  );
  assert.equal(queried, false);
});
