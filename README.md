# OPK — One Person Kanban

一个故意保持简单的一人公司项目进度看板。

**目标只有一个：打开页面以后，马上知道有哪些项目、下一步干什么、哪些节点卡住、哪些问题没解决。**

## 技术结构

- Cloudflare Worker：REST API、登录、Session
- Cloudflare D1：项目 / 节点 / 问题
- Workers Static Assets：原生 HTML / CSS / JavaScript
- Custom Domain：`mes.fhkq.best`
- 第三方 App / LLM：REST + Bearer API Key
- 机器可读接口：`/openapi.json`
- 无 React、Vue、Next.js、数据库服务器、ChatGPT Site 或其他运行时依赖

## 功能

### 项目

- 新建 / 查询 / 修改 / 删除
- 状态：进行中、暂停、完成、归档
- 优先级：低、中、高、紧急
- 开始日期 / 截止日期
- 下一步动作
- 项目说明 / 备注

### 计划节点

- 新建 / 查询 / 修改 / 删除
- 状态：计划、进行中、阻塞、完成、跳过
- 截止日期
- 备注

### 问题

- 新建 / 查询 / 修改 / 删除
- 可关联具体计划节点
- 状态：待处理、处理中、等待、已解决、关闭
- 严重度：低、中、高、严重
- 下一步动作
- 问题说明 / 备注

### 首页总览

- 活跃项目
- 未完成节点
- 未解决问题
- 逾期节点
- 高优先问题

### 数据导出

`GET /api/v1/export` 可一次性导出全部 JSON，方便备份或交给其他程序处理。

## 安全模型

本项目**没有用户系统和角色权限**，但不是裸 API：

1. 浏览器使用共享密码登录。
2. 登录成功后 Worker 签发 `HttpOnly + Secure + SameSite=Strict` Session Cookie。
3. 第三方 App / LLM 使用独立 Bearer API Key。
4. 密码、Session Secret、API Key 全部使用 Cloudflare Worker Secrets，**禁止提交到 GitHub**。
5. 密钥比较使用 `crypto.subtle.timingSafeEqual`。
6. D1 查询全部使用 prepared statement。

> 仓库是 public，因此实际共享密码不会写进代码、README 或 `.dev.vars.example`。部署时再把你指定的密码写入 Cloudflare Secret。

## 目录

```text
OPK/
├── src/
│   └── index.js
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── openapi.json
├── migrations/
│   └── 0001_init.sql
├── .dev.vars.example
├── .gitignore
├── package.json
└── wrangler.jsonc
```

## 本地开发

要求 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```env
DASHBOARD_PASSWORD=<your-password>
SESSION_SECRET=<long-random-secret>
API_KEY=<long-random-api-key>
```

创建 D1：

```bash
npx wrangler d1 create opk-db
```

将返回的 `database_id` 写入 `wrangler.jsonc`，替换：

```text
REPLACE_WITH_D1_DATABASE_ID
```

应用本地 migration：

```bash
npm run db:migrate:local
```

启动：

```bash
npm run dev
```

## 生产部署

**不要在错误的 Cloudflare 账号下执行以下步骤。** `fhkq.best` 所在 zone 必须属于当前正确授权的 Cloudflare 账号。

### 1. 创建 D1

```bash
npx wrangler d1 create opk-db
```

把返回的 `database_id` 写进 `wrangler.jsonc`。

### 2. 应用远端 migration

```bash
npm run db:migrate:remote
```

### 3. 设置 Secrets

```bash
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put API_KEY
```

其中 `DASHBOARD_PASSWORD` 在正式部署时设为你指定的共享密码。

建议随机生成另外两个值：

```bash
openssl rand -hex 32
```

### 4. Dry run

```bash
npm run check
```

### 5. 部署

```bash
npm run deploy
```

`wrangler.jsonc` 已预配置 `mes.fhkq.best` 作为 Worker Custom Domain。若该 hostname 已存在 CNAME，需要先处理冲突。

## API 鉴权

第三方 App / LLM：

```http
Authorization: Bearer YOUR_API_KEY
```

示例：

```bash
curl https://mes.fhkq.best/api/v1/projects \
  -H "Authorization: Bearer $OPK_API_KEY"
```

## API

| Method | Path | 功能 |
|---|---|---|
| GET | `/api/health` | 健康检查，无需鉴权 |
| POST | `/api/auth/login` | 浏览器密码登录 |
| POST | `/api/auth/logout` | 浏览器退出 |
| GET | `/api/auth/me` | 检查浏览器 Session |
| GET | `/api/v1/dashboard` | 总览 |
| GET / POST | `/api/v1/projects` | 项目查询 / 新建 |
| GET / PATCH / DELETE | `/api/v1/projects/:id` | 项目详情 / 修改 / 删除 |
| GET / POST | `/api/v1/projects/:id/milestones` | 项目节点查询 / 新建 |
| GET | `/api/v1/milestones` | 全部节点查询 |
| PATCH / DELETE | `/api/v1/milestones/:id` | 节点修改 / 删除 |
| GET / POST | `/api/v1/projects/:id/issues` | 项目问题查询 / 新建 |
| GET | `/api/v1/issues` | 全部问题查询 |
| PATCH / DELETE | `/api/v1/issues/:id` | 问题修改 / 删除 |
| GET | `/api/v1/export` | 全量 JSON 备份 |

完整规范：`/openapi.json`

## 当前边界

故意不做：多用户、RBAC、团队/部门、评论流、文件附件、甘特图、通知中心、工时、财务。

如果以后真出现刚需，再加；现在提前加这些只会把一个一人公司的推进工具做成维护负担。
