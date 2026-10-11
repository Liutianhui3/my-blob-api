# 用户与 AI 聊天 API

先填写项目根目录 `.env` 中的 PostgreSQL 连接信息（模板见 `.env.example`）。
在 pgAdmin 或 psql 中先创建数据库：`CREATE DATABASE my_blob_api;`，也可使用自己的数据库名称。
启动：`npm.cmd run start:dev`，默认地址 `http://localhost:3000/api`。
启动时自动创建用户、登录会话、聊天会话和消息表，数据库账户需要建表权限。

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
  ai/
    ai.module.ts
    ai.service.ts
    sse.ts
  chat/
    chat.module.ts
    chat.controller.ts
    chat.service.ts
  app.module.ts
  main.ts
```

按业务模块组织代码：`user` 负责用户 CRUD，`auth` 负责注册、登录和会话，`database` 提供共享连接池。
用户 CRUD 统一使用 `AuthGuard` 校验身份；认证接口仍保留 `/api/users/register`、`login`、`me`、`logout` 地址。
`AppModule` 先导入 `AuthModule`，再导入 `UserModule`，保证 `/users/me` 优先于 `/users/:id` 匹配。
其他需要数据库的模块应导入 `DatabaseModule`，不要重复将 `DatabaseService` 加入自己的 providers。
`ChatModule` 导入 `AuthModule`、`DatabaseModule` 和 `AiModule`，通过 `AiService` 调用模型。`AuthGuard` 校验令牌后将当前用户挂到 `request.user`，聊天接口还会验证会话所有权。

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
| PATCH | /api/users/me      | 编辑当前登录用户的个人资料，返回更新后的用户       |
| POST | /api/users/logout   | 注销当前令牌                                      |

用户名为 3–32 位字母、数字或下划线，忽略大小写且唯一。注册密码为 8–128 位且包含字母和数字，使用随机盐和 scrypt 哈希存储，响应不包含密码哈希。
会话有效期一天，数据库只保存会话令牌的 SHA-256 哈希。启动会自动新增 username、password_hash 和 user_sessions，保留已有用户数据；旧用户不自动获得密码。
认证请求设置 `Authorization: Bearer <token>`，前端缓存令牌并在退出时清除。推荐前端通过同源 `/api` 代理访问，生产环境使用 HTTPS。

### 编辑个人资料

`PATCH /api/users/me` 只使用登录会话中的用户 ID。允许部分更新，不能提交 `id`、`username`、密码或其他字段；原有 `/api/users/:id` 管理接口保持仅编辑 name、email。

```json
{
  "name": "新昵称",
  "email": "hello@example.com",
  "location": "中国 · 上海",
  "website": "https://example.com",
  "bio": "热爱开发与设计",
  "avatar": ""
}
```

昵称非空且最多 40 字符，邮箱必须有效且唯一（忽略大小写）；所在地最多 60 字符、网站最多 240 字符且仅允许 HTTP/HTTPS、简介最多 200 字符。所在地、网站、简介和头像可用空字符串清空，省略字段保持原值。邮箱重复返回 409，参数错误返回 400，登录过期返回 401。

头像使用 `data:image/png|jpeg|webp;base64,...`，检查图片文件头和大小，解码后最多 300 KB；前端先裁剪缩小到 256×256，原始文件不直接提交。JSON 请求体上限为 512 KB。

启动时在现有迁移事务中以 `ADD COLUMN IF NOT EXISTS` 新增 `users.location VARCHAR(60)`、`website VARCHAR(240)`、`bio VARCHAR(200)`、`avatar TEXT`，均非空并默认空字符串，保留已有用户数据。数据库账号需具有修改表权限。登录、注册、`GET /api/users/me` 和用户查询响应均包含这些资料字段，不返回密码哈希。
默认允许跨域；CORS_ORIGINS 环境变量可以指定允许的前端地址，多个用逗号分隔。PORT 可修改端口。

验证：`npm.cmd run build`、`npm.cmd run lint`。
数据库接口测试：先设置 `TEST_DATABASE_URL` 指向专用测试数据库，再运行 `node --test test/users.integration.mjs`。
未设置测试数据库时自动跳过；测试会建表并清理自己创建的用户。

## AI 配置与多轮聊天

先把 `.env.example` 中的 `AI_*` 配置复制到 `.env`，填写自己的密钥、供应商 API 基础地址和模型名称。基础地址应包含供应商要求的版本路径（如 `/v1`），不要附加 `/chat/completions`。

当前适配器支持 **Chat Completions 兼容的文本模型**：供应商需支持 `messages`、`stream: true`，返回包含 `choices[0].delta.content`、`finish_reason` 和 `data: [DONE]` 的 SSE。输出上限参数默认使用 `max_tokens`，可按模型配置为 `max_completion_tokens`。仅有 Responses 或原生其他协议的模型需要调整适配器；当前未实现工具调用和多模态。官方协议参考：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

密钥只保存在后端，不发送给前端。未配置模型时，用户接口、创建会话和查询历史仍可使用；发送消息返回 503。

| 配置                   | 默认值                     | 说明                                                                |
| ---------------------- | -------------------------- | ------------------------------------------------------------------- |
| `AI_API_KEY`           | 无                         | 模型服务密钥                                                        |
| `AI_BASE_URL`          | 无                         | API 基础地址                                                        |
| `AI_MODEL`             | 无                         | 供应商支持的模型名称                                                |
| `AI_MODELS`            | 仅 `AI_MODEL`              | JSON 模型白名单及各模型的思考档位，必须包含 `AI_MODEL`                |
| `AI_SYSTEM_PROMPT`     | 你是一个有帮助的中文助手。 | 后端系统提示词                                                      |
| `AI_TIMEOUT_MS`        | 120000                     | 请求处理与模型生成超时，允许 1000–600000 毫秒                       |
| `AI_MAX_TOKENS`        | 2048                       | 请求的最大输出 token 数，需符合具体模型限制                         |
| `AI_CONTEXT_MAX_BYTES` | 24000                      | 系统提示词、历史和当前输入的 UTF-8 字节预算，含每条消息 32 字节余量 |

字节预算用于保守限制输入长度，不是精确 token 计数。应根据模型上下文窗口设置输入预算和输出上限。每次最多选择最近 50 个成功完成的轮次，在预算内保留连续的最近轮次；超出部分按整轮丢弃，目前不生成历史摘要。历史中的失败、取消或尚未完成的轮次不发送给模型，当前问题仅加入一次。

`AI_MODELS` 示例（在 `.env` 中写为单行 JSON）：

```json
[
  {"id":"gpt-6.1-sol","label":"6.1 Sol","reasoningEfforts":["low","medium","high","xhigh","max"],"defaultEffort":"auto","tokenParameter":"max_tokens"},
  {"id":"another-model","label":"另一个模型","reasoningEfforts":["low","high"],"tokenParameter":"max_completion_tokens"}
]
```

只配置供应商实际提供的模型和档位。`reasoningEfforts` 可包含 `low`、`medium`、`high`、`xhigh`、`max`；`auto` 始终可用，表示不传 `reasoning_effort`、由供应商决定。`defaultEffort` 默认为 `auto`，其他默认值必须属于该模型可用档位。前端最高档 **Ultra** 对应接口 `max`，不会向供应商发送非标准 `ultra` 值。未设置 `AI_MODELS` 时兼容旧配置，仅提供 `AI_MODEL` 和自动档位。接口只返回公开模型信息，不返回 API 密钥、基础地址和 token 参数配置。

### 聊天接口

所有接口都需要 `Authorization: Bearer <登录令牌>`，只可访问自己的聊天会话；他人的会话统一返回 404。

| 方法 | 地址                                     | 请求/响应                                          |
| ---- | ---------------------------------------- | -------------------------------------------------- |
| POST | `/api/conversations`                     | 请求 `{}` 或 `{"title":"新对话"}`，返回会话（201） |
| GET  | `/api/conversations`                     | 最近更新的最多 100 个会话                          |
| GET  | `/api/conversations/models`              | 返回 `{defaultModel,models}` 与各模型可用思考档位   |
| GET  | `/api/conversations/:id/messages`        | 最近 100 条消息，按顺序升序返回                    |
| POST | `/api/conversations/:id/messages/stream` | 请求 `{"content":"你好","model":"gpt-6.1-sol","reasoningEffort":"high"}`，返回 SSE（200） |

消息查询可传 `?before=<sequence>&limit=50` 加载更早的历史，`limit` 范围是 1–100。`sequence` 返回字符串，避免 JavaScript 丢失 bigint 精度。消息包含 `id`、`turnId`、`sequence`、`role`、`content`、`status`、`createdAt`，助手消息额外包含该次使用的 `model` 和 `reasoningEffort`；同一轮的用户消息和助手回复共用 `turnId`。标题最多 100 字符，发送内容最多 16000 字符，同时受输入字节预算限制。`model` 和 `reasoningEffort` 可省略，使用后端默认；模型必须在白名单内，档位必须受该模型支持，否则在写入消息之前返回 400。不能覆写系统提示词或会话所有者。同一会话可以逐轮切换模型，保留成功完成的上下文。

启动时以 `ADD COLUMN IF NOT EXISTS` 新增 `messages.model TEXT` 和 `messages.reasoning_effort VARCHAR(16)`，保留历史数据；旧消息这两个字段为 `null`。

流事件格式如下；`start` 返回消息 ID，`delta` 返回增量文本，成功保存完整回复后才发送 `done`：

```text
event: start
data: {"conversationId":"...","userMessageId":"...","messageId":"...","model":"gpt-6.1-sol","reasoningEffort":"high"}

event: delta
data: {"text":"你好"}

event: done
data: {"messageId":"...","finishReason":"stop"}

```

`finishReason: "length"` 表示回复达到了输出上限，内容仍会保存，前端可提示用户。发生异常时，如果尚未开始 SSE，则返回正常 HTTP JSON 错误；流已经开始则发送 `error` 事件（`statusCode`、`message`）并关闭，不发送 `done`。

用户消息先保存，助手回复先标为 `generating`；完成后标为 `completed`，失败或超时标为 `failed`，客户端断开标为 `cancelled`。失败/取消时尽量保存已输出的部分文本。生成期间文本暂存在进程内，历史查询看到的 `generating` 回复内容为空；进程意外退出时尚未保存的增量可能丢失。流式读取异常后应刷新历史确认最终状态。

同一会话的并发发送返回 409，通过数据库租约在多个服务实例之间互斥。租约时长为生成超时加 30 秒；意外退出后，下一次发送会回收过期租约并将残留的 `generating` 回复标为 `failed`。不同会话可以同时生成。

### 前端调用与停止生成

可直接使用 `examples/chat-client.js`，它通过 POST `fetch` 读取 SSE，支持跨数据块事件和中文字符解码，不使用 `EventSource`。以下代码应在前端项目中运行，根据前端部署方式调整 import 路径：

```js
import { sendMessage } from './chat-client.js';

const base = 'http://localhost:3000/api';
const token = localStorage.getItem('token');
const response = await fetch(`${base}/conversations`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ title: '聊天示例' }),
});
const conversation = await response.json();
if (!response.ok) throw new Error(conversation.message);

const controller = new AbortController();
// 将停止按钮绑定到：controller.abort()
await sendMessage({
  base,
  token,
  conversationId: conversation.id,
  content: '我叫小明，请记住我的名字。',
  signal: controller.signal,
  onDelta: (text, fullReply) => {
    // 用 textContent 或框架文本绑定显示 fullReply，避免直接写入 innerHTML。
    console.log(fullReply);
  },
  onDone: ({ finishReason }) => console.log('完成：', finishReason),
});

// 第二轮复用同一个 conversationId，后端自动读取成功完成的历史。
await sendMessage({
  base,
  token,
  conversationId: conversation.id,
  content: '我叫什么？',
  onDelta: (text, fullReply) => console.log(fullReply),
});
```

服务每 15 秒发送 SSE 注释心跳。部署到 Nginx 等代理时，需要关闭该接口的响应缓冲/缓存并设置足够的读取超时；服务也会返回 `X-Accel-Buffering: no` 和 `Cache-Control: no-cache, no-transform`。

### 验证聊天功能

`npm test` 使用本地模拟模型 HTTP 服务测试流式协议、跨分段中文、多轮上下文、异常、超时、客户端取消及前端读取示例，无需真实模型密钥。设置 `TEST_DATABASE_URL` 指向专用测试数据库后，还会执行 `test/chat.integration.mjs`，验证真实 PostgreSQL 下的所有权、历史持久化、分页、跨服务实例互斥和过期租约恢复。集成测试会清理自己创建的账号和聊天数据。

## 开发命令

个人资料 `PATCH /api/users/me` 另外支持 `phone`（最多 30 字符，支持国际区号）、`about`（2000 字符）、`skills`（最多 30 项，每项 1–40 字符）和 `workExperiences`（最多 20 段）。每段工作经历为 `{id, company, position, startDate, endDate, description}`：公司／职位必填，各最多 100 字符；月份格式为 `YYYY-MM`，结束月份可为空表示至今，不能早于开始月份；描述最多 2000 字符，按纯文本使用。`id` 必须唯一且仅包含字母、数字、下划线或连字符。数组传 `[]` 可清空，未传字段保留原值，未知字段返回 400。

启动时自动添加 `users.phone`、`users.about`、`users.skills JSONB` 和 `users.work_experiences JSONB`，不替换已有资料；新字段默认空字符串／空数组。登录、注册和 `GET /api/users/me` 同时返回这些字段；请求体上限为 1 MB，覆盖处理后的头像及完整工作经历。资料集成测试验证新增字段、清空与服务重启后的持久化。

- `npm run start:dev`：开发模式，监听文件变化。
- `npm run build`：编译 TypeScript。
- `npm run start:prod`：运行编译后的服务。
- `npm run format`：格式化源码。
- `npm run lint`：检查源码和测试。
- `npm test`：构建并执行全部测试；未设置 `TEST_DATABASE_URL` 时跳过 PostgreSQL 集成测试。

`test/users.integration.mjs` 是 PostgreSQL 集成测试；设置 `TEST_DATABASE_URL` 后可通过 `npm test` 执行，也可在构建后单独执行。
