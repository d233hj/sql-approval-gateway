# @sql-approval/web · Web 审批台（P3-a）

SQL Approval Gateway 的本机 Web 审批台。通过同源 Cookie 会话（普通 Web/桌面）或内存 Bearer 会话（DSH iframe，避免第三方 Cookie 被拦截）调用 core 的 `/v1/admin/*`，完成：

- 首次初始化（设置管理密码）与解锁；
- 待审批列表（状态筛选、搜索）、提案详情（完整 SQL / 参数 / 目的 / 摘要 / 来源 / 时间）；
- 批准并执行、拒绝（可填原因）；
- 查询结果分页表格（列来自 `columns`，支持空态、截断、`RESULT_EXPIRED`）；
- 设置页：会话与锁定、审批与执行参数（读写 `/v1/admin/settings`）、数据源列表/添加/删除/编辑/测试、Agent 客户端列表/创建 token/撤销、严格只读校验开关、修改管理密码、查看 core 版本；
- 手动锁定、可配置空闲倒计时、锁状态徽标、后端错误码中文映射。

## 0. 实现偏差（重要）

任务首选 **Vite + React + TypeScript**。本环境 npm 可以下载依赖，但沙箱禁止 Node 以管道方式 `spawn` 子进程（`spawn EPERM`），而 Vite 7 加载配置和构建时必须启动 esbuild 服务进程；`npm run build` 无法完成，且会话内审批提示被禁用、不能提权。

因此按任务预案降级为 **零运行时依赖的原生 TypeScript SPA**：

- `tsc` 将 `src/*.ts` 编译为原生 ESM（`dist/src/*.js`）；
- 自带的 `scripts/dev-server.mjs` 用 Node 内置 `http` 提供静态服务，并把 `/v1` 代理到 `127.0.0.1:43119`；
- 没有 React / Vite / 任何 CDN 或运行时 npm 依赖；`typescript` 仅是 devDependency（根 workspace 已安装）。

功能、认证与安全约束与首选方案一致；`package.json` 的 name 仍为 `@sql-approval/web`。

## 1. 快速开始

前置：Node.js ≥ 24（core 本身要求），core 运行在 `http://127.0.0.1:43119`。

```powershell
# 仓库根目录
npm install --ignore-scripts          # 如尚未安装 workspace 依赖
npm run start:core                    # 或 node packages/core/dist/src/cli.js

# 另开终端
npm run dev --workspace=@sql-approval/web
# 打开 http://127.0.0.1:5173
```

也可以：

```powershell
cd packages/web
npm run dev        # 开发服务器（直接转译 src/*.ts 后提供）
npm run build      # tsc 编译 + 复制静态壳 + 安全不变量检查
npm run preview    # 构建后预览 dist/，仍带 /v1 代理
npm run typecheck  # 仅类型检查
```

开发服务器固定监听 `127.0.0.1:5173`，`/v1` 代理到 `127.0.0.1:43119`：

- 浏览器始终停留在 `http://127.0.0.1:5173`，所以 `sag_session` Cookie 是同源 Cookie，无需 CORS `Allow-Credentials`；
- core 的 `Host` 校验要求端口必须等于 43119，代理会做 `changeOrigin`；
- Chromium 对同源 POST 也会发送 `Origin`，代理会把它改写成 `http://127.0.0.1:43119`，否则 core 返回 `ORIGIN_REJECTED`。

如 core 端口不是 43119，修改 `scripts/dev-server.mjs` 中的 `CORE_ORIGIN`（仅开发/预览需要）。

## 2. 生产部署假设

P3-a 只交付 Web 产物；当前 core 没有静态文件路由。正式部署时由 core 在自己的 origin 上提供 `dist/`：

- 路径按站点根 `/` 挂载（`dist/index.html`、`dist/styles.css`、`dist/assets/*`、`dist/src/*`）；
- 首页与 API 同源，否则 Cookie/CSRF 流程不成立；
- core 需为 SPA 文档设置 DESIGN §8.1 的 CSP，例如：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none';
frame-ancestors 'self' dsh-app://app
```

- 生产环境**不要**使用本仓库的 dev-server；它只服务于本机开发/预览。

## 3. 认证与安全约束

| 约束 | 实现 |
|---|---|
| 会话（同源） | HttpOnly `sag_session` Cookie；`fetch` 使用 `credentials: 'same-origin'` |
| 会话（嵌入） | `window.parent !== window` 或 URL 含 `embed=1` 时视为 DSH iframe：unlock 请求带 `X-SAG-Want-Token: 1`，响应中的 `token` 只放模块变量；后续 admin 请求带 `Authorization: Bearer <token>` |
| CSRF | Cookie 会话的写请求带 `X-SAG-CSRF`；Bearer 会话不需要 CSRF（DESIGN §4.3） |
| 解锁 | 非嵌入模式不发送 `X-SAG-Want-Token`，也忽略响应中的 `token`；嵌入模式只保存内存 Bearer token |
| 刷新/锁定 | 内存 CSRF/Bearer token 丢失，必须重新解锁；`lock()` 与任何会话失效路径都会清空两者 |
| XSS | 全部动态文本用 `textContent` / `createTextNode`；没有 `innerHTML`、`dangerouslySetInnerHTML`、`insertAdjacentHTML`、`document.write`、`eval`；SQL 放在 `<pre><code>` 文本中 |
| 资源 | 不使用外部 CDN、字体或脚本；图标全部内联 SVG |
| 空闲 | 读取 `session.idle_minutes`（默认 10 分钟，1–1440）；每次管理员请求成功后重置；到达后本地锁定并提示 |
| 绝对上限 | 读取 `session.absolute_hours`（默认 8 小时，1–24）；客户端从解锁时刻计算；服务端同样有绝对上限 |
| 构建检查 | `scripts/postbuild.mjs` 会扫描源码，出现上述危险 API、浏览器持久化 API 或外部 URL 时构建失败 |

注意：`expiresAt` 是 core 返回的滑动空闲期限，不是绝对上限；绝对上限按解锁时刻在客户端计算。`ui.show_countdown=false` 只隐藏头部倒计时，空闲锁定仍然生效。

## 4. API 使用

| 方法 | 路径 | CSRF | 用途 |
|---|---|---|---|
| GET | `/v1/admin/state` | — | `{configured, unlocked, version}`，启动/回到解锁页时刷新 |
| GET | `/v1/events` | — | 实时提案事件流（SSE，`text/event-stream`）：`event: proposal.created` / `proposal.updated`，`data` 仅 `{"id","source","at"}`（不含 SQL/参数/连接信息）；每 25s `: ping` 心跳；锁定时 423、会话失效 401 |
| POST | `/v1/admin/setup` | — | 首次设置密码 `{password, confirm}` |
| POST | `/v1/admin/unlock` | — | `{password}` → `{ok, csrfToken, expiresAt}`；带 `X-SAG-Want-Token: 1` 时额外返回 `token`（仅嵌入模式） |
| POST | `/v1/admin/lock` | Cookie 需要 / Bearer 不需要 | 手动锁定（服务端中止执行并清会话） |
| GET | `/v1/admin/proposals?status=&q=&limit=100` | — | 审批列表（core 返回数组，不是分页对象） |
| POST | `/v1/admin/proposals/{id}/approve` | 需要 | 批准并同步执行，返回最终状态与结果摘要 |
| POST | `/v1/admin/proposals/{id}/reject` | 需要 | `{reason?}`（≤500 字） |
| GET | `/v1/admin/proposals/{id}/rows?page=&page_size=` | — | `{columns, rows, page, page_size, total_rows, truncated, ...}` |
| GET | `/v1/admin/sources` | — | 设置页列表与来源名称映射（只返回 `id/name/dialect`） |
| POST | `/v1/admin/sources` | 需要 | `{name, dialect, connection}`；`connection` 按方言取 `{file}` 或 `{host, port, database, username, password}`（mssql 可加 `trustServerCertificate`），返回 `{id, name, dialect}` |
| PUT | `/v1/admin/sources/{id}` | 需要 | 部分更新 `{name?, dialect?, connection?}`；密码省略/留空 = 保留，修改方言时必须同时提供连接 |
| POST | `/v1/admin/sources/{id}/test` | 需要 | 连接与只读探测 → `{ok, latency_ms, readonly:{ok,checked,details}, server?}`；失败探测也是 HTTP 200（`ok:false`） |
| DELETE | `/v1/admin/sources/{id}` | 需要 | 删除数据源（连接信息同时从 vault 移除） |
| GET | `/v1/admin/clients` | — | Agent 客户端列表（只返回 `id/name/created_at/last_used_at/disabled`，不含 token 或 hash） |
| POST | `/v1/admin/clients` | 需要 | `{name}`（trim 后 1–100 字符）→ `{id, name, token, created_at}`；token 仅此一次返回，形如 `sag_...`（47 字符），之后只能看到元数据 |
| DELETE | `/v1/admin/clients/{id}` | 需要 | 撤销 Agent token（禁用客户端，历史与提案记录保留）→ `{ok: true}`；撤销后该 token 立即 401 |
| GET | `/v1/admin/settings` | — | `{settings, defaults, ranges}`；设置页用 `ranges` 渲染输入范围 |
| PUT | `/v1/admin/settings` | 需要 | 部分更新设置 → `{settings}`；会话/审批分组各自保存，安全分组单独保存 `security.require_readonly_source`（扁平 key，body 如 `{"security.require_readonly_source": true}`） |
| POST | `/v1/admin/password` | 需要 | `{current, new}` 修改管理密码；当前会话保留，其他会话失效 |

结果表格严格使用响应的 `columns`，每页大小可选 50/100/200/500；`truncated` 显示黄色徽标与提示。

### 错误码映射

必选：`NOT_UNLOCKED`（网关已锁定）、`INVALID_STATE`（提案状态已变化）、`CSRF_REJECTED`（安全令牌无效）、`RATE_LIMITED`（显示 `Retry-After` 秒数）。

另外覆盖：`UNAUTHENTICATED`、`ALREADY_CONFIGURED`、`RESULT_EXPIRED`（410 结果已过期）、`PROPOSAL_NOT_FOUND`、`POLICY_DENIED`、`SOURCE_NOT_FOUND`、`SOURCE_NOT_READONLY`、`SOURCE_PROBE_FAILED`、`QUERY_TIMEOUT`、`QUERY_FAILED`、`LOCKED`、`NETWORK_ERROR`、`ORIGIN_REJECTED`、`INTERNAL_ERROR` 等。错误框同时显示原始 `code` 与 `request_id`，便于对照 core 日志。

`UNAUTHENTICATED` / `NOT_UNLOCKED` / `CSRF_REJECTED` / `LOCKED` 会让前端回到解锁页并提示原因。解锁后列表/来源请求若返回 HTTP 401/403，会显示“会话未建立，请重新解锁。”并回到解锁页，不会停留在“已解锁”。

## 5. 页面流程

1. **未配置**：设置密码（≥12 位，字母 + 数字，两次一致）→ `setup`；成功后自动 `unlock` 进入审批台。若 setup 响应带 `agent_token`（core 未通过 `SAG_AGENT_TOKEN` 预置），在审批台顶部一次性显示/复制，关闭后不可再取。
2. **已配置**：解锁页。即使 core 的 `/state` 显示 `unlocked: true`（其他会话持有），本页刷新后仍必须输入密码以建立本页会话（普通页面取得 CSRF，嵌入模式取得内存 Bearer token）。
3. **已解锁**：
   - 头部：锁状态、空闲倒计时（剩余 <60s 变红）、core 版本、设置、锁定按钮；
   - 左侧：状态筛选、300ms 防抖搜索、刷新、列表；
   - 实时：解锁后用 `fetch` + `ReadableStream` 读取 `/v1/events`（不用 `EventSource`，以便嵌入模式携带 Bearer token）；收到 `proposal.created` / `proposal.updated` 立即拉取一次列表（150ms 合并突发事件），新待审批提案插到列表顶部并提示“收到 N 条新的 SQL 审批请求”（5 秒自动消失，可点关闭）；同一 id 只提示一次；被其他端处理的提案从列表移除但保留卡片展开状态；无变化不重绘、不抢输入焦点。断线按 1s→2s→5s→10s 退避重连，重连成功先全量刷新一次；连续 3 次失败显示一行“实时连接中断，正在重连”；实时徽标显示“已连接/重连中”。锁定、登出或会话失效时 `AbortController.abort()` 断开并清重连定时器，重新解锁后重连；回到可见的标签页时若连接已断立即重连（不做定时轮询）；
   - 右侧：完整详情；待审批提案可批准（二次确认）或拒绝（可填原因）；
   - 结果：动态列表格、分页、截断提示、空态；410 显示“结果已过期（RESULT_EXPIRED）”；
   - 设置页：会话与锁定（空闲锁定、会话绝对上限、显示倒计时）、审批与执行（默认/最大行数、默认/最大超时、审批窗口、结果保留）、安全（严格只读校验开关，值来自 `security.require_readonly_source`，默认开启；切换即 PUT 并显示成功/失败提示；修改密码（≥12 位字母+数字））、数据源列表（名称/方言/只读徽标，测试/编辑/删除，删除需确认；徽标按测试结果显示绿色「只读」、红色「可写风险 · 严格模式将阻止执行」、灰色「未验证」/「未校验」或红色「测试失败」+错误码，点击可展开判定详情；编辑时就地展开，连接留空保持原值、密码留空保持原密码）、添加数据源（sqlite 填文件路径，其余填主机/端口/数据库/用户名/密码，端口按方言默认）、Agent 客户端（位于数据源之后：名称/创建时间/最近使用/状态列表，撤销需确认并立即失效；创建 token 成功后在同区块顶部显示一次性面板——token 等宽可选中、复制按钮（`navigator.clipboard` 失败时提示手动复制）、「只显示一次」提示与「我已保存」按钮，面板关闭前不会被刷新覆盖）、core 版本；当严格模式开启且待审批提案的来源已被测试确认可写时，批准按钮旁显示红色提示“该数据源非只读，批准将被拒绝”，服务端仍会最终拦截；返回审批台保留当前列表与筛选状态；
   - 手动锁定或空闲超时后回到解锁页。

4. **嵌入模式**：被 DSH 插件以 `/?embed=1` 放进 iframe（或检测到 `window.parent !== window`）时：
   - 认证走内存 Bearer：`unlock` 带 `X-SAG-Want-Token: 1`，后续 `/v1/admin/*` 与 `/v1/events` 带 `Authorization: Bearer <token>`，不使用 CSRF；
   - SPA 在启动和 `window.load` 后各向父窗口发送一次常量握手 `{type:'sag:hello',version:1,embedded:true}`（不含 token、会话或来源信息），供 DSH 插件判断 iframe 是否可用；非嵌入模式不发送；
   - 若 unlock 后列表/来源请求仍 401/403，回到解锁页并显示“会话未建立，请重新解锁。”。

## 6. 文件结构

```text
packages/web/
  index.html              # 单页静态壳（无内联脚本/样式）
  styles.css              # 系统字体、无外部资源
  src/
    main.ts               # 状态机、渲染、交互、会话/倒计时
    api.ts                # /v1 客户端、Cookie/CSRF 与嵌入模式 Bearer、超时/错误
    api.embed.test.mjs    # 传输头测试（node:test，直接执行即可）
    errors.ts             # 错误码→中文文案
    format.ts             # 时间/时长/SQL 预览/结果单元格格式化
    types.ts              # 与 core/shared 对齐的 wire 类型
  scripts/
    dev-server.mjs        # 零依赖 dev/preview 静态服务 + /v1 代理
    postbuild.mjs         # 复制静态壳、安全不变量检查
    clean.mjs
  tsconfig.json           # outDir dist/src，NodeNext ESM
  dist/                   # npm run build 产物（git 忽略）
```

## 7. 已验证 / 未完成

已用真实 core（SQLite 数据源）和 jsdom DOM 集成测试验证：

- 首次 setup（含密码规则/确认不一致校验、自动解锁、一次性 Agent token）；
- 错误密码、正确解锁、列表加载、来源名称映射；
- 状态筛选、搜索、清空筛选；
- 结果 123 行分页（100 + 23）、50 行截断徽标/提示、失败提案；
- 详情中的完整 SQL、参数、目的、摘要；
- 批准并执行成功后加载结果；拒绝并记录原因；
- 手动锁定、重新解锁；
- 实时推送：提交提案后事件到达并渲染列表（core 集成测试实测 <1s；另用最小 DOM 桩对构建产物做无头冒烟，推送→渲染约 186ms，空闲 5.6s 内零列表请求，断线自动重连并全量刷新，锁定后中止连接）；
- mock 场景：`RESULT_EXPIRED`(410)、`CSRF_REJECTED`、`INVALID_STATE`、`RATE_LIMITED`（含 `Retry-After`）、`NOT_UNLOCKED`；
- 传输层测试（见下）：嵌入模式 unlock 带 `X-SAG-Want-Token`、后续 GET/POST 带 `Authorization` 且不带 CSRF、`lock()`/401 后清除 token、非嵌入模式完全不使用 Bearer；`adminAuthHeaders()` 只给嵌入模式加 Bearer（事件流用）；
- `npm run typecheck`、`npm run build` 成功，且源码无禁用 API。

```powershell
# 6 个用例；--test-isolation=none 避免沙箱禁止 node --test spawn 子进程
node --test --test-isolation=none packages/web/src/api.embed.test.mjs
# SSE 协议侧（连接收事件、断开清空订阅、心跳、认证/锁定）在 core 测试中：
node --test --test-isolation=none packages/core/dist/test/events.test.js
```

本沙箱内 Chromium/Edge 无头浏览器因同样的命名管道限制无法启动，故**没有浏览器截图/像素级视觉回归**；布局按 CSS 代码审查，DOM 行为已覆盖。

设置页（会话/审批设置、数据源增删改测、Agent 客户端列表/创建 token/撤销、密码修改）已通过 `npm run typecheck` 与 `npm run build`（含 postbuild 安全不变量扫描），但当前环境没有可用的 jsdom/浏览器，未做 DOM 级自动化回归。

未完成（不属于 P3-a 必选流程或需 core 侧配合）：

- 审计日志的管理 UI（core API 已存在）；
- core 静态托管 `dist/` 与生产 CSP（需在 core 侧实现）；
- 结果导出、单元格复制、结果表列宽拖拽；
- 列表键盘方向键漫游、i18n、深色主题；
- 真实浏览器 E2E（当前环境被沙箱阻断）。
