# My Blob API

面向 AI 工作台的后端服务，提供用户认证、个人资料管理、多轮流式聊天与知识库检索增强生成（RAG）。基于 NestJS、TypeScript 和 PostgreSQL 构建，通过 Chat Completions 兼容协议接入模型服务，使用 pgvector 保存和检索文档向量。

## 功能概览

- **用户认证**：注册、登录、注销与 Bearer Token 会话认证；密码使用随机盐与 scrypt 哈希，会话令牌仅以 SHA-256 哈希存储。
- **个人资料**：支持基本信息、头像、技能与工作经历的部分更新，仅允许操作当前账号。
- **流式聊天**：POST SSE、多轮上下文、模型白名单、思考档位、超时与取消处理、消息持久化。
- **知识库管理**：创建知识库，上传 UTF-8 TXT / Markdown，按字符切片、分页预览与删除文档。
- **文档向量化**：手动生成 BAAI/bge-m3 的 1024 维向量，批量调用远程服务，事务保存结果。
- **检索增强**：聊天时检索当前用户的已向量化资料，将匹配片段纳入模型上下文，并提示模型标注文档与片段来源。
- **数据隔离**：聊天和知识库操作均检查资源所有权；通过数据库生成租约控制同一会话的并发请求。

本仓库为后端项目；配套前端位于相邻的 `myBlob` 项目，独立构建和部署。

## 系统架构

```mermaid
flowchart LR
    UI[前端工作台] --> API[NestJS API]
    API --> Auth[认证与资源权限]
    API --> Chat[聊天与上下文管理]
    API --> KB[文档与切片管理]
    KB --> Embedding[远程 Embedding 服务]
    KB --> DB[(PostgreSQL / pgvector)]
    Chat --> RAG[知识检索]
    RAG --> Embedding
    RAG --> DB
    Chat --> Model[Chat Completions 模型服务]
    Chat --> DB
```

| 模块                      | 职责                                          |
| ------------------------- | --------------------------------------------- |
| `src/auth`                | 注册、登录、会话令牌与认证守卫                |
| `src/user`                | 当前用户的个人资料校验与更新                  |
| `src/database`            | PostgreSQL 连接池、启动时建表与增量结构初始化 |
| `src/ai`                  | 模型配置、白名单、上游调用与 SSE 解码         |
| `src/chat`                | 会话管理、消息持久化、上下文预算与流式响应    |
| `src/knowledge`           | 文档上传、切片、向量化、相似度检索与 RAG      |
| `examples/chat-client.js` | 支持取消与增量读取的浏览器调用示例            |
| `test`                    | 单元测试、HTTP 测试与数据库集成测试           |

## 快速开始

### 1. 准备环境

准备支持项目依赖的 Node.js LTS、npm 和 PostgreSQL。启用知识库向量化时，PostgreSQL 还需安装 pgvector 扩展。

```bash
npm ci
cp .env.example .env
```

创建数据库，并在 `.env` 中填写实际连接信息：

```sql
CREATE DATABASE my_blob_api;
```

应用启动时创建所需表，并通过增量 DDL 添加字段。数据库账号需要建表、修改表权限；配置 `EMBEDDING_MODEL` 时，还需要能够启用 `vector` 扩展。数据库本身需提前创建。

### 2. 配置服务

以下为最小配置示例，密钥和数据库凭据请替换为自己的值：

```dotenv
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=replace-with-your-password
PGDATABASE=my_blob_api
PORT=3000
CORS_ORIGINS=http://localhost:8082

AI_API_KEY=replace-with-your-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model-id

EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=replace-with-your-key
EMBEDDING_MODEL=BAAI/bge-m3
```

`AI_BASE_URL` 和 `EMBEDDING_BASE_URL` 应包含服务要求的版本路径，例如 `/v1`，不要附加 `/chat/completions` 或 `/embeddings`。两个服务可以使用不同供应商和密钥。文档片段与检索问题会发送至配置的向量服务，聊天上下文会发送至模型服务。

### 3. 启动

```bash
npm run start:dev
```

默认接口地址为 `http://localhost:3000/api`。生产构建：

```bash
npm run build
npm run start:prod
```

未配置 AI 时，认证、会话创建与历史查询仍可使用，发送消息返回 503。仅使用普通聊天时，可移除 `EMBEDDING_MODEL`，关闭自动 RAG 检索和启动时的向量扩展初始化。

## 配置参考

### 数据库与 HTTP

| 变量                                                     | 默认值 / 行为        | 说明                             |
| -------------------------------------------------------- | -------------------- | -------------------------------- |
| `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE` | 由 pg 驱动读取       | PostgreSQL 连接配置              |
| `PORT`                                                   | `3000`               | HTTP 监听端口                    |
| `CORS_ORIGINS`                                           | 未设置时允许所有来源 | 允许的前端来源，多个使用逗号分隔 |

### 模型与上下文

| 变量                   | 默认值                     | 说明                                               |
| ---------------------- | -------------------------- | -------------------------------------------------- |
| `AI_API_KEY`           | 无                         | 上游模型密钥                                       |
| `AI_BASE_URL`          | 无                         | Chat Completions 兼容 API 基础地址                 |
| `AI_MODEL`             | 无                         | 默认模型 ID                                        |
| `AI_MODELS`            | 仅提供 `AI_MODEL`          | JSON 模型白名单，必须包含默认模型                  |
| `AI_SYSTEM_PROMPT`     | 你是一个有帮助的中文助手。 | 后端系统提示词                                     |
| `AI_TIMEOUT_MS`        | `120000`                   | 聊天处理总超时，范围 1000–600000 毫秒              |
| `AI_MAX_TOKENS`        | `2048`                     | 最大输出 token 数                                  |
| `AI_CONTEXT_MAX_BYTES` | `24000`                    | 输入上下文的保守 UTF-8 字节预算，并非精确 token 数 |

模型服务需要支持 `messages`、`stream: true`，以及包含 `choices[0].delta.content`、`finish_reason` 和 `[DONE]` 的 SSE 响应。

`AI_MODELS` 在 `.env` 中配置为单行 JSON，例如：

```json
[
  {
    "id": "your-model-id",
    "label": "默认模型",
    "reasoningEfforts": ["low", "medium", "high"],
    "defaultEffort": "auto",
    "tokenParameter": "max_tokens"
  }
]
```

只填写供应商实际支持的模型与档位。可配置档位为 `low`、`medium`、`high`、`xhigh`、`max`；`auto` 表示不向上游传递 `reasoning_effort`。需要 `max_completion_tokens` 的模型应相应调整 `tokenParameter`。模型列表接口不会公开密钥或基础地址。

### 向量服务

| 变量                 | 要求                                          |
| -------------------- | --------------------------------------------- |
| `EMBEDDING_API_KEY`  | 向量服务密钥                                  |
| `EMBEDDING_BASE_URL` | 兼容 Embeddings 协议的基础地址                |
| `EMBEDDING_MODEL`    | 当前仅支持 `BAAI/bge-m3`，输出维度必须为 1024 |

## API 参考

所有接口统一使用 `/api` 前缀。除注册和登录外，下表接口均需有效会话令牌：

```http
Authorization: Bearer <token>
```

### 用户与认证

| 方法  | 路径                  | 功能                                                      |
| ----- | --------------------- | --------------------------------------------------------- |
| POST  | `/api/users/register` | 注册，提交 `username`、`email`、`password`                |
| POST  | `/api/users/login`    | 登录，提交 `username`、`password`，返回 `{ user, token }` |
| GET   | `/api/users/me`       | 获取当前用户                                              |
| PATCH | `/api/users/me`       | 部分更新个人资料                                          |
| POST  | `/api/users/logout`   | 注销当前令牌，返回 204                                    |

用户名为 3–32 位字母、数字或下划线，忽略大小写且唯一；注册密码为 8–128 位，需包含字母和数字。登录会话有效期一天。

个人资料支持 `name`、`email`、`location`、`website`、`bio`、`avatar`、`phone`、`about`、`skills`、`workExperiences`。省略字段保持原值，未知字段返回 400。头像支持 PNG / JPEG / WebP 的 Base64 Data URL，解码后最多 300 KB；JSON 请求体上限为 1 MB。技能最多 30 项，工作经历最多 20 段。

工作经历格式：

```json
{
  "workExperiences": [
    {
      "id": "experience-1",
      "company": "示例公司",
      "position": "软件工程师",
      "startDate": "2024-01",
      "endDate": "",
      "description": "负责应用开发与维护"
    }
  ]
}
```

当前未提供管理员用户管理接口，用户列表与按 ID 操作账号的接口返回 404。

### 聊天

| 方法 | 路径                                     | 功能                                           |
| ---- | ---------------------------------------- | ---------------------------------------------- |
| POST | `/api/conversations`                     | 创建会话，提交 `{}` 或 `{ "title": "新对话" }` |
| GET  | `/api/conversations`                     | 查询最近更新的最多 100 个会话                  |
| GET  | `/api/conversations/models`              | 获取默认模型、模型列表与可用思考档位           |
| GET  | `/api/conversations/:id/messages`        | 查询历史，支持 `before` 和 `limit`             |
| POST | `/api/conversations/:id/messages/stream` | 发送消息并读取 SSE 回复                        |

发送示例：

```json
{
  "content": "请根据资料介绍产品功能",
  "model": "your-model-id",
  "reasoningEffort": "auto"
}
```

`model` 和 `reasoningEffort` 可省略。消息最多 16000 字符，同时受上下文字节预算限制。历史分页的 `limit` 为 1–100，`before` 使用消息 `sequence`；该字段返回字符串以保留 bigint 精度。

#### SSE 协议

```text
event: start
data: {"conversationId":"...","userMessageId":"...","messageId":"...","model":"your-model-id","reasoningEffort":"auto"}

event: delta
data: {"text":"根据资料，"}

event: done
data: {"messageId":"...","finishReason":"stop"}
```

- `start`：返回本轮消息标识与生成设置。
- `delta`：增量文本，客户端按顺序拼接。
- `done`：完整回复已成功保存；`finishReason: "length"` 表示触及输出上限。
- `error`：流开始后的失败事件，包含 `statusCode` 和 `message`，随后关闭连接。

流开始前的失败返回 HTTP JSON 错误。服务每 15 秒发送注释心跳。浏览器使用 POST `fetch` 读取流，调用 `AbortController.abort()` 停止等待；完整示例见 [`examples/chat-client.js`](examples/chat-client.js)。

消息状态为 `generating`、`completed`、`failed` 或 `cancelled`。失败和取消时尽量保存部分文本；生成中的增量暂存在进程内，进程异常退出可能丢失未保存内容。同一会话并发发送返回 409，数据库租约支持跨实例互斥与过期恢复。

上下文仅使用成功完成的历史轮次，最多读取最近 50 轮，在预算内按整轮保留连续的最近历史；当前问题仅加入一次，不自动生成历史摘要。

### 知识库

| 方法   | 路径                                                        | 功能                                          |
| ------ | ----------------------------------------------------------- | --------------------------------------------- |
| GET    | `/api/knowledge-bases`                                      | 查询当前用户知识库                            |
| POST   | `/api/knowledge-bases`                                      | 创建知识库，提交 `name`、可选 `description`   |
| GET    | `/api/knowledge-bases/:id/documents`                        | 查询文档，包含 `chunkCount`、`embeddedChunks` |
| POST   | `/api/knowledge-bases/:id/documents`                        | multipart 上传文件并切片                      |
| GET    | `/api/knowledge-bases/:id/documents/:documentId/chunks`     | 分页查询切片，`page` 从 1 开始，每页 20 条    |
| POST   | `/api/knowledge-bases/:id/documents/:documentId/embeddings` | 向量化整份文档                                |
| POST   | `/api/knowledge-bases/:id/search`                           | 检索指定知识库                                |
| DELETE | `/api/knowledge-bases/:id/documents/:documentId`            | 删除文档及关联切片                            |

上传字段：

| 字段           | 类型       | 约束                                       |
| -------------- | ---------- | ------------------------------------------ |
| `file`         | 文件       | 单个 UTF-8 `.txt` / `.md`，非空，最多 1 MB |
| `chunkSize`    | 整数字符串 | 默认 500，范围 100–2000                    |
| `chunkOverlap` | 整数字符串 | 默认 50，需非负且小于 `chunkSize`          |

切片以 Unicode 字符计数，重叠长度不是 token 数。文档和切片通过同一事务保存，失败时回滚。

## RAG 工作流程

### 文档入库

```text
上传文本 → 清理换行与切片 → 保存文档和片段
                                  ↓ 手动点击“向量化”
                         调用 Embedding → 保存向量
```

**上传成功只代表切片已保存，文档必须完成向量化才能参与检索。** 配套前端在文档操作栏提供“向量化”按钮，并显示处理状态。

向量化每批最多 16 个片段，每批上游请求超时 60 秒。全部向量生成后通过事务写入数据库；远程调用失败不会覆盖已有向量。重新调用会计算整份文档，大文档需为客户端和代理预留足够等待时间。

成功响应示例：

```json
{
  "documentId": "...",
  "model": "BAAI/bge-m3",
  "dimensions": 1024,
  "embeddedChunks": 3
}
```

文档列表的 `embeddedChunks` 表示与当前配置模型匹配、已保存向量的片段数。

### 检索与回答

指定知识库搜索：

```json
{
  "query": "产品有哪些功能？",
  "limit": 5
}
```

`limit` 为 1–20，默认 5。响应包含片段正文、文档名称、位置和余弦相似度 `score`；相似度不等于答案置信度。

聊天时自动以本轮问题检索当前用户全部知识库，取相似度至少 **0.35** 的最多 **5** 个片段，在输入预算内作为参考资料加入上下文。指定知识库搜索接口不使用聊天的 0.35 阈值。

未配置 embedding、没有已向量化片段或没有匹配片段时，聊天继续使用普通模型回答。已有可检索资料但向量服务调用失败时，返回错误。来源标注由提示词约束，目前不返回结构化引用，不能保证每次回答都正确标注来源。

## 开发与测试

| 命令                 | 用途                   |
| -------------------- | ---------------------- |
| `npm run start:dev`  | 开发模式，监听源码变化 |
| `npm run build`      | 编译 TypeScript        |
| `npm run start:prod` | 运行 `dist/main.js`    |
| `npm run lint`       | 检查源码与测试         |
| `npm run format`     | 格式化源码             |
| `npm test`           | 构建并运行测试         |

常规测试使用模拟模型服务，不需要真实模型密钥，覆盖认证、权限、流式协议、上下文、取消、超时、向量响应校验与 RAG 行为。

设置 `TEST_DATABASE_URL` 后会执行 PostgreSQL 集成测试，否则自动跳过。请使用专用测试数据库；测试会创建并清理测试账号及关联数据。

```bash
TEST_DATABASE_URL='postgresql://user:password@localhost:5432/my_blob_api_test' npm test
```

## 部署与故障排查

推荐前端通过同源 `/api` 反向代理访问后端。跨域直连时，`CORS_ORIGINS` 必须包含实际网页来源，例如 `http://192.168.50.22:8082`。从其他设备访问时，前端 API 地址不能使用指向访问者本机的 `localhost`。

SSE 路由需关闭代理响应缓冲和缓存，并配置大于聊天超时的读取超时；文档向量化路由也需适当延长代理等待时间。服务会为聊天流返回 `X-Accel-Buffering: no` 与 `Cache-Control: no-cache, no-transform`。生产环境使用 HTTPS，模型密钥保留在后端，`.env` 不应提交到版本控制。

| 现象                     | 检查方向                                                  |
| ------------------------ | --------------------------------------------------------- |
| 无法连接服务             | Network 中的实际请求地址、后端端口、`/api` 代理与跨域配置 |
| HTTP 304                 | 正常缓存校验结果，不能据此判断服务连接失败                |
| HTTP 401                 | 登录令牌缺失、过期或已注销                                |
| 发送消息返回 503         | 模型配置或模型白名单是否有效                              |
| 向量化返回 502           | 向量服务网络、额度、密钥、模型与响应维度                  |
| 上传成功但聊天未引用文档 | 是否已向量化、账号是否一致、相似度是否达到阈值            |
| 回复集中在最后出现       | 代理是否开启 SSE 缓冲                                     |
| 同一会话返回 409         | 是否已有生成任务尚未结束                                  |

常规错误响应使用 NestJS JSON 格式，例如：

```json
{
  "statusCode": 400,
  "message": "错误原因",
  "error": "Bad Request"
}
```

## 当前边界与后续方向

当前实现适合基础 RAG 开发、功能验证与范围明确的内部试点，尚未覆盖完整企业生产能力。

- 文档仅支持 TXT / Markdown；PDF、OCR、表格与版式解析尚未实现。
- 使用精确向量检索，未引入近似索引、关键词混合检索或重排序。
- 向量化为同步请求，未提供后台队列、任务进度和自动重试。
- 聊天检索范围为当前用户全部知识库，未提供知识库选择、多轮问题改写和严格的资料不足拒答模式。
- 权限按用户隔离，未提供企业租户、部门、管理员与文档级授权。
- 模型适配器当前处理文本 Chat Completions，不支持原生 Responses 协议、工具调用或多模态。
- 数据库结构由启动时 DDL 初始化，尚未采用独立版本化迁移流程。

建议优先扩展 PDF 解析与页码来源，再建立真实问题评测集，根据结果完善检索策略、后台任务和权限体系。
