import type { Request } from 'express';
import type { User } from '../user/user.model.js';

export interface AuthenticatedRequest extends Request {
  user: User;
}
