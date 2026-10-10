import type { Request } from 'express';

export function sessionToken(request: Request): string {
  return (
    request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ?? ''
  );
}
