export interface WorkExperience {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  username: string | null;
  location: string;
  website: string;
  bio: string;
  avatar: string;
  phone: string;
  about: string;
  skills: string[];
  workExperiences: WorkExperience[];
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

export interface ProfileUpdate extends UserUpdate {
  location?: string;
  website?: string;
  bio?: string;
  avatar?: string;
  phone?: string;
  about?: string;
  skills?: string[];
  workExperiences?: WorkExperience[];
}

// SQL 别名统一用户 CRUD 和认证接口的公开字段。
export const userFields =
  'id, name, email, username, location, website, bio, avatar, phone, about, skills, work_experiences AS "workExperiences", created_at AS "createdAt", updated_at AS "updatedAt"';
