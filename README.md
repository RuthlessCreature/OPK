# OPK — One Person Kanban

一个故意保持简单的一人公司项目进度看板，部署在 Cloudflare Workers + D1。

- 前端：原生 HTML / CSS / JavaScript，无 React/Vue，无任何 ChatGPT Site 依赖
- 后端：Cloudflare Worker
- 数据库：Cloudflare D1
- 域名：`mes.fhkq.best`
- 浏览器访问：共享密码登录，密码通过 Worker Secret 保存，不写进前端代码
- 第三方 App / LLM：标准 REST API + Bearer API Key
- API 描述：`https://mes.fhkq.best/openapi.json`

## 功能范围

只做四件事：

1. 项目
2. 计划节点
3. 问题
4. 状态 / 下一步动作 / 备注

为了让看板真正能用于每天推进工作，项目额外保留 `priority`、`start_date`、`due_date`、`next_action`。没有用户、角色、部门、评论流、附件、甘特图等复杂功能。

## 数据状态

### 项目状态

- `active`：进行中
- `paused`：暂停
- `done`：完成
- `archived`：归档

### 节点状态

- `planned`：计划
- `in_progress`：进行中
- `blocked`：阻塞
- `done`：完成
- `skipped`：跳过

### 问题状态

- `open`：待处理
- `in_progress`：处理中
- `waiting`：等待外部条件
- `resolved`：已解决
- `closed`：关闭

## 本地启动

```bash
npm install
npx wrangler d1 create opk-db
```

把命令返回的 D1 `database_id` 写入 `wrangler.jsonc`：

```jsonc
"database_id": "你的 D1 database_id"
```

应用本地 migration：

```bash
npm run db:migrate:local
```

创建 `.dev.vars`：

```env
DASHBOARD_PASSWORD=wotamade
SESSION_SECRET=local-development-session-secret-change-me
API_KEY=local-development-api-key-change-me
```

启动：

```bash
npm run dev
```

## Cloudflare 正式部署

### 1. 创建 D1

```bash
npx wrangler d1 create opk-db
```

将输出的 `database_id` 替换到 `wrangler.jsonc`。

### 2. 应用远端数据库 migration

```bash
npm run db:migrate:remote
```

### 3. 设置 Secrets

网页密码固定按当前需求设为 `wotamade`：

```bash
printf 'wotamade' | npx wrangler secret put DASHBOARD_PASSWORD
```

生成 Session Secret：

```bash
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
```

生成第三方 API Key：

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEY
```

**API Key 只保存一次。** 后续第三方 App 或大模型用：

```http
Authorization: Bearer YOUR_API_KEY
```

### 4. 部署

```bash
npm run deploy
```

`wrangler.jsonc` 已配置 Custom Domain：

```text
mes.fhkq.best
```

Cloudflare 会把这个子域名指向 Worker。域名所在的 `fhkq.best` zone 必须在同一个已授权的 Cloudflare 账号中，并且 `mes.fhkq.best` 不能存在冲突的 CNAME。

## API 快速使用

### 健康检查

```bash
curl https://mes.fhkq.best/api/health
```

### 新建项目

```bash
curl -X POST https://mes.fhkq.best/api/v1/projects \
  -H "Authorization: Bearer $OPK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "客户A自动化项目",
    "priority": "high",
    "due_date": "2026-09-30",
    "next_action": "完成方案评审"
  }'
```

### 查询全部项目

```bash
curl https://mes.fhkq.best/api/v1/projects \
  -H "Authorization: Bearer $OPK_API_KEY"
```

### 新建节点

```bash
curl -X POST https://mes.fhkq.best/api/v1/projects/PROJECT_ID/milestones \
  -H "Authorization: Bearer $OPK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "机械方案冻结",
    "status": "planned",
    "due_date": "2026-08-25"
  }'
```

### 新建问题

```bash
curl -X POST https://mes.fhkq.best/api/v1/projects/PROJECT_ID/issues \
  -H "Authorization: Bearer $OPK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "客户未提供最终3D模型",
    "severity": "high",
    "status": "waiting",
    "next_action": "8月20日前催客户确认"
  }'
```

### 更新状态

```bash
curl -X PATCH https://mes.fhkq.best/api/v1/issues/ISSUE_ID \
  -H "Authorization: Bearer $OPK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"resolved"}'
```

### 全量 JSON 备份

```bash
curl https://mes.fhkq.best/api/v1/export \
  -H "Authorization: Bearer $OPK_API_KEY" \
  > opk-backup.json
```

## API 路由

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查，无需鉴权 |
| GET | `/api/v1/dashboard` | 首页统计、逾期节点、重点问题 |
| GET/POST | `/api/v1/projects` | 项目查询 / 新建 |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | 项目详情 / 修改 / 删除 |
| GET/POST | `/api/v1/projects/:id/milestones` | 项目节点查询 / 新建 |
| GET | `/api/v1/milestones` | 全局节点查询 |
| PATCH/DELETE | `/api/v1/milestones/:id` | 节点修改 / 删除 |
| GET/POST | `/api/v1/projects/:id/issues` | 项目问题查询 / 新建 |
| GET | `/api/v1/issues` | 全局问题查询 |
| PATCH/DELETE | `/api/v1/issues/:id` | 问题修改 / 删除 |
| GET | `/api/v1/export` | 全量 JSON 导出 |

完整机器可读接口说明见 `/openapi.json`。

## 安全边界

这个项目没有“用户权限系统”，但不是裸奔：

- 浏览器密码只在 Worker Secret 中存在，不写入 HTML/JS
- 登录成功后使用 `HttpOnly + Secure + SameSite=Strict` Session Cookie
- 第三方 API 使用独立 Bearer API Key，不复用网页密码
- D1 操作全部使用 prepared statement
- API 支持 CORS，跨域调用仍必须提供 API Key
- 删除项目会级联删除节点和问题

这套安全级别适合个人内部工具。如果未来要开放给团队或客户，再加 Cloudflare Access / 正式用户体系，不要现在提前把系统做重。
