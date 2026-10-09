# 用户 CRUD API

先填写项目根目录 `.env` 中的 PostgreSQL 连接信息（模板见 `.env.example`）。
在 pgAdmin 或 psql 中先创建数据库：`CREATE DATABASE my_blob_api;`，也可使用自己的数据库名称。
启动：`npm.cmd run start:dev`，默认地址 `http://localhost:3000/api`。
启动时自动创建 users 表和邮箱唯一索引，数据库账户需要建表权限。

目录：
```text
src/
  controllers/user.controller.ts
  models/user.model.ts
  modules/user.module.ts
  services/user.service.ts
  database/database.service.ts
  app.module.ts
  main.ts
```

| 方法 | 地址 | 功能 |
| --- | --- | --- |
| GET | /api/users | 列表（数组） |
| GET | /api/users/:id | 详情 |
| POST | /api/users | 创建（201） |
| PATCH | /api/users/:id | 部分更新 |
| DELETE | /api/users/:id | 删除（204，无响应体） |

创建请求：`{"name":"张三","email":"zhangsan@example.com"}`。
更新可以只传 name 或 email。响应包含 id（UUID）、name、email、createdAt、updatedAt。
参数错误返回 400，不存在返回 404，邮箱重复返回 409。邮箱忽略大小写。
错误格式：`{"statusCode":400,"message":"错误原因","error":"Bad Request"}`。

前端示例：
```js
const base = 'http://localhost:3000/api';
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}
const user = await api('/users', 'POST', { name: '张三', email: 'zhangsan@example.com' });
const users = await api('/users');
await api(`/users/${user.id}`, 'PATCH', { name: '李四' });
await api(`/users/${user.id}`, 'DELETE');
```

数据直接保存到 PostgreSQL，使用 pg 驱动和参数化 SQL。不会读取原先的 JSON 数据。
支持账号注册和令牌登录，用户 CRUD 接口必须携带有效 Bearer Token，否则返回 401。登录用户可访问用户管理 CRUD；当前尚未区分管理员角色。

## 登录与注册

| 方法 | 地址 | 功能 |
| --- | --- | --- |
| POST | /api/users/register | 注册：username、email、password，返回公开用户信息 |
| POST | /api/users/login | 登录：username、password，返回 { user, token } |
| GET | /api/users/me | 获取当前登录用户，无有效会话返回 401 |
| POST | /api/users/logout | 注销当前令牌 |

用户名为 3–32 位字母、数字或下划线，忽略大小写且唯一。注册密码为 8–128 位且包含字母和数字，使用随机盐和 scrypt 哈希存储，响应不包含密码哈希。
会话有效期一天，数据库只保存会话令牌的 SHA-256 哈希。启动会自动新增 username、password_hash 和 user_sessions，保留已有用户数据；旧用户不自动获得密码。
认证请求设置 `Authorization: Bearer <token>`，前端缓存令牌并在退出时清除。推荐前端通过同源 `/api` 代理访问，生产环境使用 HTTPS。
默认允许跨域；CORS_ORIGINS 环境变量可以指定允许的前端地址，多个用逗号分隔。PORT 可修改端口。

验证：`npm.cmd run build`、`npm.cmd run lint`。
数据库接口测试：先设置 `TEST_DATABASE_URL` 指向专用测试数据库，再运行 `node --test test/users.integration.mjs`。
未设置测试数据库时自动跳过；测试会建表并清理自己创建的用户。

## ????

- npm.cmd run start:dev????????????????
- npm.cmd run build??? TypeScript?
- npm.cmd run start:prod??????????
- npm.cmd run format????????
- npm.cmd run lint??????
- npm.cmd test??????????????

test/users.integration.mjs ???????????????????? src?
