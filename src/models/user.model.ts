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
