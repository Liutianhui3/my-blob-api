# 用户 CRUD API

先填写项目根目录 `.env` 中的 PostgreSQL 连接信息（模板见 `.env.example`）。
在 pgAdmin 或 psql 中先创建数据库：`CREATE DATABASE my_blob_api;`，也可使用自己的数据库名称。
启动：`npm.cmd run start:dev`，默认地址 `http://localhost:3000/api`。
启动时自动创建 users 表和邮箱唯一索引，数据库账户需要建表权限。

目录：

```text
src/
  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    guards/auth.guard.ts
    session-token.ts
  user/
    user.module.ts
    user.controller.ts
    user.service.ts
    user.model.ts
  database/
    database.module.ts
    database.service.ts
  app.module.ts
  main.ts
```

按业务模块组织代码：`user` 负责用户 CRUD，`auth` 负责注册、登录和会话，`database` 提供共享连接池。
用户 CRUD 统一使用 `AuthGuard` 校验身份；认证接口仍保留 `/api/users/register`、`login`、`me`、`logout` 地址。
`AppModule` 先导入 `AuthModule`，再导入 `UserModule`，保证 `/users/me` 优先于 `/users/:id` 匹配。
其他需要数据库的模块应导入 `DatabaseModule`，不要重复将 `DatabaseService` 加入自己的 providers。
后续 `ChatModule` 可以导入 `AuthModule` 和 `DatabaseModule`，并通过导入 `AiModule` 使用其导出的 `AiService`。

| 方法   | 地址           | 功能                  |
| ------ | -------------- | --------------------- |
| GET    | /api/users     | 列表（数组）          |
| GET    | /api/users/:id | 详情                  |
| POST   | /api/users     | 创建（201）           |
| PATCH  | /api/users/:id | 部分更新              |
| DELETE | /api/users/:id | 删除（204，无响应体） |

创建请求：`{"name":"张三","email":"zhangsan@example.com"}`。
更新可以只传 name 或 email。响应包含 id（UUID）、name、email、createdAt、updatedAt。
参数错误返回 400，不存在返回 404，邮箱重复返回 409。邮箱忽略大小写。
错误格式：`{"statusCode":400,"message":"错误原因","error":"Bad Request"}`。

前端示例：

```js
const base = 'http://localhost:3000/api';
const token = localStorage.getItem('token'); // 登录接口返回后保存的令牌。
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}
const user = await api('/users', 'POST', {
  name: '张三',
  email: 'zhangsan@example.com',
});
const users = await api('/users');
await api(`/users/${user.id}`, 'PATCH', { name: '李四' });
await api(`/users/${user.id}`, 'DELETE');
```

数据直接保存到 PostgreSQL，使用 pg 驱动和参数化 SQL。不会读取原先的 JSON 数据。
支持账号注册和令牌登录，用户 CRUD 接口必须携带有效 Bearer Token，否则返回 401。登录用户可访问用户管理 CRUD；当前尚未区分管理员角色。

## 登录与注册

| 方法 | 地址                | 功能                                              |
| ---- | ------------------- | ------------------------------------------------- |
| POST | /api/users/register | 注册：username、email、password，返回公开用户信息 |
| POST | /api/users/login    | 登录：username、password，返回 { user, token }    |
| GET  | /api/users/me       | 获取当前登录用户，无有效会话返回 401              |
| POST | /api/users/logout   | 注销当前令牌                                      |

用户名为 3–32 位字母、数字或下划线，忽略大小写且唯一。注册密码为 8–128 位且包含字母和数字，使用随机盐和 scrypt 哈希存储，响应不包含密码哈希。
会话有效期一天，数据库只保存会话令牌的 SHA-256 哈希。启动会自动新增 username、password_hash 和 user_sessions，保留已有用户数据；旧用户不自动获得密码。
认证请求设置 `Authorization: Bearer <token>`，前端缓存令牌并在退出时清除。推荐前端通过同源 `/api` 代理访问，生产环境使用 HTTPS。
默认允许跨域；CORS_ORIGINS 环境变量可以指定允许的前端地址，多个用逗号分隔。PORT 可修改端口。

验证：`npm.cmd run build`、`npm.cmd run lint`。
数据库接口测试：先设置 `TEST_DATABASE_URL` 指向专用测试数据库，再运行 `node --test test/users.integration.mjs`。
未设置测试数据库时自动跳过；测试会建表并清理自己创建的用户。

## 开发命令

- `npm run start:dev`：开发模式，监听文件变化。
- `npm run build`：编译 TypeScript。
- `npm run start:prod`：运行编译后的服务。
- `npm run format`：格式化源码。
- `npm run lint`：检查源码和测试。
- `npm test`：构建并执行全部测试；未设置 `TEST_DATABASE_URL` 时跳过 PostgreSQL 集成测试。

`test/users.integration.mjs` 是 PostgreSQL 集成测试；设置 `TEST_DATABASE_URL` 后可通过 `npm test` 执行，也可在构建后单独执行。
