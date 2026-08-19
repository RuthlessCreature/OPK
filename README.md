# OPK — One Person Kanban

一个故意保持简单的一人公司项目进度看板。

**目标只有一个：打开页面以后，马上知道有哪些项目、下一步干什么、哪些节点卡住、哪些问题没解决；同时让各种 Agent 可以直接读写同一份项目状态。**

## 技术结构

- Cloudflare Worker：REST API、网页登录、Session
- Cloudflare D1：项目 / 节点 / 问题
- Workers Static Assets：原生 HTML / CSS / JavaScript
- Custom Domain：`mes.fhkq.best`
- Agent / 第三方程序：直接 REST API，**无需 API Key**
- 机器可读接口：`/openapi.json`
- 无 React、Vue、Next.js、数据库服务器、ChatGPT Site 或其他运行时依赖

## API 与网页安全模型

这是一个单人自用系统，故意采用两套入口：

1. **网页 UI**：仍使用共享密码 + Session Cookie。
2. **`/api/v1/*` Agent API**：无需 Bearer Token / API Key，可直接调用。

因此任何能访问 `https://mes.fhkq.best/api/v1/*` 的程序都可以读写 OPK。这个设计是为了让不同 Agent 零配置接入。

网页仍依赖两个 Worker Secret：

```text
DASHBOARD_PASSWORD
SESSION_SECRET
```

不再需要 `API_KEY`。

## 项目首次接入流程

为了避免 Agent 重复创建项目，推荐流程：

```text
项目没有固定 project_id
  ↓
GET /api/v1/projects/similar?q=<项目名>
  ↓
是否有同名/相似项目？
  ├─ 无 → POST /api/v1/project-ids → POST /api/v1/projects
  └─ 有 → Agent 必须告诉用户候选项目
          用户选择：新提交 / 覆盖已有项目
```

“覆盖”建议只 PATCH 已有项目本体，保留原里程碑和问题历史。

## 新 project-id API

```bash
curl -X POST https://mes.fhkq.best/api/v1/project-ids
```

返回：

```json
{
  "ok": true,
  "data": {
    "project_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

创建项目时可以把该 ID 传回来：

```bash
curl -X POST https://mes.fhkq.best/api/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "project_id":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name":"Example Project",
    "status":"active",
    "priority":"medium"
  }'
```

## 同名 / 相似项目检测

```bash
curl 'https://mes.fhkq.best/api/v1/projects/similar?q=OPK%20Skill'
```

返回候选项目和 `similarity` 分数，供 Agent 展示给用户选择。

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

```text
GET /api/v1/export
```

可导出全部 JSON。

## 目录

```text
OPK/
├── src/
│   ├── index.js          # 原有网页登录和核心 CRUD
│   └── public-api.js     # 对 Agent 开放的零鉴权 API 入口
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── openapi.json
├── migrations/
├── .dev.vars.example
├── package.json
└── wrangler.jsonc
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
```

`.dev.vars`：

```env
DASHBOARD_PASSWORD=<your-password>
SESSION_SECRET=<long-random-secret>
```

然后创建/配置 D1、应用 migration：

```bash
npm run db:migrate:local
npm run dev
```

## 生产部署

GitHub Actions `deploy` 会自动：

1. 验证 Cloudflare 凭证；
2. 查找/创建 `opk-db`；
3. 应用 D1 migration；
4. 上传网页登录所需两个 Secret；
5. 部署 Worker + `mes.fhkq.best`；
6. 检查 `/api/health`；
7. **无鉴权检查 `/api/v1/projects` 和 `/api/v1/project-ids`。**

## API

| Method | Path | 功能 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/login` | 网页密码登录 |
| POST | `/api/auth/logout` | 网页退出 |
| GET | `/api/auth/me` | 网页 Session 状态 |
| GET | `/api/v1/dashboard` | 总览 |
| POST | `/api/v1/project-ids` | 生成新的 project-id |
| GET | `/api/v1/projects/similar?q=...` | 查同名/相似项目 |
| GET / POST | `/api/v1/projects` | 项目查询 / 新建 |
| GET / PATCH / DELETE | `/api/v1/projects/:id` | 项目详情 / 修改 / 删除 |
| GET / POST | `/api/v1/projects/:id/milestones` | 项目节点查询 / 新建 |
| GET | `/api/v1/milestones` | 全部节点查询 |
| PATCH / DELETE | `/api/v1/milestones/:id` | 节点修改 / 删除 |
| GET / POST | `/api/v1/projects/:id/issues` | 项目问题查询 / 新建 |
| GET | `/api/v1/issues` | 全部问题查询 |
| PATCH / DELETE | `/api/v1/issues/:id` | 问题修改 / 删除 |
| GET | `/api/v1/export` | 全量 JSON 备份 |

完整规范：

```text
https://mes.fhkq.best/openapi.json
```

## 当前边界

故意不做：多用户、RBAC、团队/部门、评论流、文件附件、甘特图、通知中心、工时、财务。
