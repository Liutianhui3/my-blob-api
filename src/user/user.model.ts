export interface User {
  id: string;
  name: string;
  email: string;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

// 创建用户时，需要填写这两个字段。
export interface UserInput {
  name: string;
  email: string;
}

// 更新用户时，可以只填写其中一个字段。
export interface UserUpdate {
  name?: string;
  email?: string;
}

// SQL 别名统一用户 CRUD 和认证接口的公开字段。
export const userFields =
  'id, name, email, username, created_at AS "createdAt", updated_at AS "updatedAt"';
