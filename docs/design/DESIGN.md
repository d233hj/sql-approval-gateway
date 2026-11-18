# SQL Approval Gateway — 设计文档

> 版本：v1.3（第 3 轮修订，对应 `DESIGN-REVIEW.md` G-01…G-12）｜ 日期：2026-11-10
> 定位：开源、可独立部署的"人批准、机器执行"的只读 SQL 网关。
> 技术栈（已定）：TypeScript + Node.js 24 + Electron；不使用 Rust。
> 目标读者：实现者、审查者、部署者。

---

## 1. 目标与非目标

### 1.1 目标

1. Agent 只能提交只读 SQL 提案；**永远拿不到**数据库地址、账号、密码。
2. 任何查询执行前，必须由**人**在已解锁的会话中逐条批准。
3. 数据源配置以密文落盘，密钥由用户密码派生；网关可开机自启，但启动后为 **LOCKED**。
4. 同一 core，四种客户端：Web、Windows 桌面、DSH 插件、MCP（泛用 agent 框架）。
5. 开源可发布：pnpm monorepo、npm 包、Docker 镜像、Electron 安装包、可复现测试。

### 1.2 非目标（v1 明确不做）

- SQL 写操作、DDL、存储过程。
- 多租户、团队 RBAC、SSO/OIDC。
- 独立 OS 账户/容器隔离/KMS/Vault/TPM（安全基线见 §2）。
- 防本机管理员、防同账户内已获得代码执行的恶意进程。
- 无人值守自动执行查询（批准必须有人）。

---

## 2. 威胁模型与安全基线

**基线：不高于本机 DBeaver 的凭据保护水平。**

| 资产 | 保护方式 | 明确不防 |
|---|---|---|
| 数据源配置（host/port/db/user/password） | 用户密码 → scrypt → 包裹 DEK → AES-256-GCM 加密落盘 | 同账户内可执行代码者（可读内存/键盘） |
| 管理员会话 | 内存会话 + HttpOnly Cookie（同源）/ Bearer（跨源）；短 TTL | 本机管理员 |
| 审批权 | 仅已解锁会话可批准；Agent token 无 approve 能力 | 用户主动批准恶意 SQL |
| 审计 | 追加式 SHA-256 哈希链 + 验证接口 | 能改写整库并重算链的管理员 |

**信任边界**：Agent 与 Gateway 同机同用户；Agent 可读文件、可提交提案，但**没有密码就解不开 vault**。

### 2.1 静态数据边界（G-09）

- **加密**：`vault.json` 中的连接信息（host/port/db/user/password）。
- **明文**：`control.db` 中的提案 SQL、参数、结果行、审计记录。它们受数据目录 ACL 保护，但同账户可读。
- 结论：本产品保护的是"连接信息与审批权"，**不是查询结果本身**；结果加密列为 v0.3 可选。

---

## 3. 架构

### 3.1 进程与组件

```
┌──────────────────────── core (Node 24, TS) ────────────────────────┐
│ HTTP :43119 (loopback)                                              │
│  ├─ /v1/agent/*   Bearer agent token（提交/查询/读结果/取消）        │
│  ├─ /v1/admin/*   session（登录/解锁/审批/数据源/审计）              │
│  ├─ /v1/health                                                   │
│  └─ /              Web SPA（React）                                 │
│ Vault（vault.json，AEAD） · SQLite（control.db） · 审计链            │
│ 连接器：sqlite / mssql（v1） · pg / mysql（v0.2）                    │
│ 执行器：worker_threads（查询不阻塞事件循环）                          │
└───────────────┬──────────────────────────────┬─────────────────────┘
                │ HTTP (Bearer agent token)    │ HTTP (session)
     ┌──────────┴─────────┐          ┌─────────┴──────────────┐
     │ MCP server (stdio) │          │ Web / Desktop / DSH UI │
     │ DSH 插件 Host 半    │          │ 同一份 SPA              │
     └────────────────────┘          └────────────────────────┘
```

### 3.2 部署形态与发现

| 形态 | core 怎么跑 | UI |
|---|---|---|
| Web | `npx @sql-approval/core` / Docker，登录自启 | 浏览器打开 `http://127.0.0.1:43119` |
| Windows 桌面 | Electron 主进程 fork core（或连已有 core） | BrowserWindow 加载同一 URL |
| DSH 插件 | core 独立运行（自启） | 插件面板内嵌 iframe 加载 `?embed=1` |
| MCP | core 独立运行 | 无 UI；审批去 Web/桌面/DSH |

**端口发现**：core 启动后写 `<dataDir>/endpoint.json`：

```json
{ "url": "http://127.0.0.1:43119", "pid": 1234, "version": "1.0.0", "startedAt": "…" }
```

客户端解析顺序：`SAG_URL` 环境变量 → 插件配置 → `endpoint.json` → 默认 `http://127.0.0.1:43119`。
读到 `endpoint.json` 后必须请求 `/v1/health` 校验 `pid`/`version`；不一致则视为残留文件，回退默认端口（G-08）。

**单实例**：`instance.lock`（PID + 端口 + 启动时间）。已有实例时，第二个进程只做"探活 + 打印 URL + 退出"。

---

## 4. 解锁、密钥与会话

### 4.1 状态机

```
UNCONFIGURED ──setup(password)──▶ LOCKED
LOCKED ──unlock(password)──▶ UNLOCKED（创建会话，解出 DEK 与数据源配置）
UNLOCKED ──lock/logout/timeout/restart──▶ LOCKED（中止执行、擦 DEK、关连接）
```

LOCKED 时：Agent 可提交提案、可读其历史结果（结果按 §2.1 为明文）、可列数据源**元数据**；管理员页面需解锁后才能审批（admin API 需要会话）。不可批准、不可执行、不建立任何数据库连接。
待审批提案以 `expires_at` 为审批窗口（默认 24h），到期转 `EXPIRED` 终态（G-05）。

### 4.2 Vault 格式

```json
{
  "version": 1,
  "kdf": { "algo": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "b64" },
  "wrapped_dek": { "iv": "b64", "tag": "b64", "data": "b64" },
  "sources": [
    { "id": "…", "name": "生产库", "dialect": "mssql",
      "secret": { "iv": "b64", "tag": "b64", "data": "b64" } }
  ]
}
```

- `KEK = scrypt(password, salt, 32B)`；`DEK = random 32B`；`wrapped_dek = AES-256-GCM(KEK, DEK, AAD="sag:v1:dek")`。
- 每个源的 `secret` 用 DEK 加密，AAD 为 `sag:v1:source:<id>`，防密文搬运。
- 密码校验 = 能否解开 `wrapped_dek`；不存密码哈希。
- 修改密码：重新包裹 DEK；数据源密文不动。
- 忘记密码：`core reset --confirm` 把 vault 改名备份并回到 UNCONFIGURED（数据源需重录）。
- `vault.json` 只由 UNLOCKED 状态写入；LOCKED 下数据源管理接口返回 `NOT_UNLOCKED`。

### 4.3 会话与传输（修订 F-01）

| 场景 | 传输 | CSRF | 说明 |
|---|---|---|---|
| Web / 桌面（同源） | `sag_session` Cookie（HttpOnly、SameSite=Strict、Path=/） | 写操作需要 `X-SAG-CSRF` | 登录响应同时下发 CSRF token；**不返回会话 token** |
| DSH iframe | `Authorization: Bearer <session>` | 不需要 | iframe 文档本身是 core 的 origin，`fetch` 为**同源请求**；Bearer 用于绕开第三方 Cookie 限制。token 仅当登录请求带 `X-SAG-Want-Token: 1` 时在 body 返回，SPA 只存内存 |

- **CORS 只在直连时使用**：DSH 插件若不使用 iframe、而是从 `dsh-app://app` 直接 fetch core，才需要 CORS。允许清单精确匹配 `dsh-app://app`、`http://127.0.0.1:<port>`、`http://localhost:<port>`；不回 `Allow-Credentials`；处理 `OPTIONS` 预检（`authorization,content-type,x-sag-csrf`，`Max-Age: 600`）。iframe 同源路径不触发 CORS。
- **frame-ancestors**：主值 `frame-ancestors 'self' dsh-app:`；同时准备回退值 `frame-ancestors 'self' http://127.0.0.1:*`。**已实测（2026-11-11）：`none`/`self` 被拒、`'self' dsh-app:` 放行，Chromium 接受该自定义 scheme 源**；不发送 `X-Frame-Options`。
- 会话：32B 随机 token；`session_id → {dek, createdAt, lastSeen, ip, ref}`；空闲 10 分钟、绝对 8 小时；每次 admin 请求滑动。
- 多会话共享同一 DEK，引用计数；**最后一个会话结束时擦除 DEK**。
- **锁定语义（修订 F-03）**：
  1. 标记 `locking`，新请求一律 `NOT_UNLOCKED`；
  2. 中止该会话关联的 in-flight 查询（AbortController + 驱动 cancel），等待 worker 退出；
  3. 执行中的提案置 `FAILED`，`status_message=locked`，不写结果；
  4. 关闭连接、`dek.fill(0)`、清空会话表。
- 超时与手动锁定走同一条路径。

---

## 5. 数据模型（SQLite，WAL）

| 表 | 关键列 |
|---|---|
| `sources` | `id, name, dialect, created_at, updated_at`（**不含秘密**） |
| `clients` | `id, name, token_hash, created_at, last_used_at, disabled` |
| `proposals` | `id, client_id, source_id, sql, params_json, purpose, max_rows, timeout_s, status, status_message, digest, policy_version, created_at, updated_at, expires_at, request_key` |
| `result_meta` | `proposal_id, columns_json, total_rows, truncated, freshness, executed_at, duration_ms` |
| `result_rows` | `proposal_id, row_index, row_json`（TEXT，JSON） |
| `audit` | `seq, at, actor, action, proposal_id, detail_json, prev_hash, hash` |
| `settings` | `key, value`（schema_version 等） |

- 状态：`PENDING_APPROVAL → APPROVED → EXECUTING → SUCCEEDED`；终态另有 `FAILED/REJECTED/CANCELLED/EXPIRED`。
- **崩溃恢复**（G-03）：启动时 `EXECUTING`/`APPROVED` → `FAILED(interrupted)`，不重试；`PENDING_APPROVAL` 到期 → `EXPIRED`。
- 唯一键：`(client_id, request_key)`；索引：`(status, created_at)`、`(client_id, created_at)`。
- 审计：`hash = SHA-256(prev_hash || canonical_json(record))`；提供 `GET /v1/admin/audit/verify`；明确**不防**有数据库写权限者重算整链。
- 结果 TTL 24h（**从执行完成时刻起算**，与提案审批窗口 `expires_at` 分开）；启动与每小时清理；`journal_mode=WAL`、`foreign_keys=ON`。
- 迁移：`user_version` 单调递增；迁移前复制 `control.db.bak-<v>`；失败拒绝启动并提示回滚。
- 单行 > 64KB 截断并标记；单提案结果总大小 8MB 上限。

---

## 6. HTTP API（v1）

### 6.1 安全矩阵（修订 F-09）

| 检查 | 规则 |
|---|---|
| 监听 | 仅 `127.0.0.1`；`SAG_HOST` 可改，但必须回环 |
| Host | 必须是 `127.0.0.1[:port]` / `localhost[:port]`，否则 400 |
| Origin | 存在时必须与 Host 同源或在允许清单；否则 403 |
| CORS | 仅允许清单回 ACAO；预检 204 |
| CSRF | Cookie 会话的写请求必须带 `X-SAG-CSRF`；Bearer 会话不需要 |
| Body | ≤ 256KB；`content-type: application/json` |
| 限流 | 登录/解锁 10 次/分钟/IP；连续 10 次失败后指数退避（30s 起，逐次翻倍，上限 5 分钟），并写审计（G-06） |

### 6.2 Agent（Bearer `sag_…`，修订 F-10）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/agent/sources` | `[{id,name,dialect}]`（无连接信息） |
| POST | `/v1/agent/proposals` | `{source_id, sql, purpose?, params?, max_rows?, timeout_s?, request_key?}` → `{id,status,expires_at}` |
| GET | `/v1/agent/proposals/{id}` | 状态（仅本人） |
| GET | `/v1/agent/proposals/{id}/rows?page&page_size` | 结果分页 |
| POST | `/v1/agent/proposals/{id}/cancel` | 仅 PENDING 可取消 |

- token：`sag_` + 32B base64url；存 `sha256(token)`；创建时只显示一次；`DELETE` 立即失效；`last_used_at` 最多每 5 分钟写一次。
- 明确：DSH/MCP 配置中的 token 可被同账户读取，但只有提交/读权限。

### 6.3 Admin（session）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/admin/state` | `{configured, unlocked, version}` |
| POST | `/v1/admin/setup` | `{password, confirm}`（仅 UNCONFIGURED） |
| POST | `/v1/admin/unlock` | `{password}` → `{ok, csrfToken?, expiresAt}`；仅当带 `X-SAG-Want-Token: 1` 时额外返回 `token`（G-02） |
| POST | `/v1/admin/lock` | 锁定（见 §4.3） |
| POST | `/v1/admin/password` | `{current,new}`；需 UNLOCKED；改后其他会话失效、当前会话保留（G-04） |
| GET | `/v1/admin/proposals?status=&q=&limit=` | 审批列表 |
| POST | `/v1/admin/proposals/{id}/approve` | 批准并执行（条件更新，见 §7.2） |
| POST | `/v1/admin/proposals/{id}/reject` | `{reason?}` |
| GET | `/v1/admin/proposals/{id}/rows` | 结果 |
| GET/POST/DELETE | `/v1/admin/sources[/{id}]` | 数据源管理（需 UNLOCKED） |
| POST | `/v1/admin/sources/{id}/test` | 连接与只读预检 |
| GET/POST/DELETE | `/v1/admin/clients[/{id}]` | Agent token 管理 |
| GET | `/v1/admin/audit?after=` | 审计导出 |
| GET | `/v1/admin/audit/verify` | 链校验 |
| GET | `/v1/events` | SSE 提案事件流（cookie/Bearer；`proposal.created`/`proposal.updated`；载荷仅 `{id,source,at}`；25s 心跳；锁定 423） |

### 6.4 实时更新与桌面通知（R12）

- 审批台不再轮询：`GET /v1/events` 保持一条 SSE 长连接，提案创建与状态变化即时推送；Web 端用 `fetch` + `ReadableStream` 读取（嵌入 iframe 需要携带 Bearer，`EventSource` 不支持自定义头），断线退避重连并在重连后全量刷新一次。
- 载荷最小化：事件只含 `{id, source, at}`，不含 SQL、参数、连接信息；锁定时服务端关闭全部流并返回 423。
- 新提案 Toast：仅 win32、`SAG_TOAST≠0`、进程级 3 秒 1 条；`ToastText02` 显示"来源：目的（≤80 码点）"，PowerShell 单引号转义；**spawn 不得使用 `detached` 或 `windowsHide`**（两者都会让 WinRT 通知静默失效），用 `-WindowStyle Hidden` 隐藏窗口；通知失败不影响提案创建。

### 6.5 错误码（节选）

`EMPTY_SQL`、`SQL_TOO_LONG`、`MULTI_STATEMENT`、`NOT_SELECT`、`FORBIDDEN_STATEMENT`、
`SELECT_INTO`、`DANGEROUS_LOCK_HINT`、`CROSS_DATABASE`、`TEMP_OBJECT`、`EXTERNAL_SOURCE`、
`METADATA_FORBIDDEN`、`POLICY_DENIED`、`SOURCE_NOT_FOUND`、`NOT_UNLOCKED`、`INVALID_STATE`、
`PROPOSAL_NOT_FOUND`、`RESULT_EXPIRED`、`QUERY_TIMEOUT`、`QUERY_FAILED`、`RATE_LIMITED`、
`UNAUTHENTICATED`、`CSRF_REJECTED`、`LOCKED`。

---

## 7. SQL 策略与执行

### 7.1 策略（fail-closed，修订 F-11）

- 单条 `SELECT` 或 `WITH … SELECT`；AST 解析（`node-sql-parser`，按源方言）。
- 拒绝：非 SELECT、多语句、`SELECT INTO`、DML/DDL/EXEC、锁提示、临时表、三段名（跨库）、
  `OPENROWSET/OPENQUERY/OPENDATASOURCE`、`sp_/xp_`、`@@*`、`DB_NAME/@@SERVERNAME/SUSER_*/HOST_NAME`、
  系统目录（`sys.*`、`information_schema.*`、`pg_catalog.*`、`sqlite_master`）、DMV、
  `OPTION (...)`、`FOR XML/JSON`。
- `PIVOT/UNPIVOT` 允许，但必须有正例测试。
- 先剥离注释与字符串字面量再判定；解析失败一律拒绝（`POLICY_DENIED`）。
- 每数据源可配 `allow_schemas` / `allow_tables`（v0.2）。
- 策略版本 `sag-policy-1` 写入提案；批准时复核版本。

### 7.2 执行（修订 F-02/F-04/F-12）

**批准必须原子**：

```sql
UPDATE proposals SET status='APPROVED', updated_at=?
 WHERE id=? AND status='PENDING_APPROVAL';
-- 受影响行数 = 0 → 409 INVALID_STATE
```

拿到该更新的请求才可写入 `EXECUTING`；同一提案的并发批准只有一个成功。

**中断恢复**：启动时把残留的 `APPROVED`/`EXECUTING` 置为 `FAILED(interrupted)`，不自动重试；查询连接按驱动超时自然回收。

**按驱动的行数上限**：

| 驱动 | 做法 |
|---|---|
| sqlite | 逐行读取，读到 `max_rows` 后再取一行判定 truncated，关闭 statement |
| mssql | 连接池复用；`request.stream` 读 n+1 行后 `request.cancel()`。**POC 实测：cancel 后同连接/池可复用（同 SPID、0 行、无串包、池不增长）；仅在 `cancelTimeout`/`ESOCKET` 时丢弃连接** |
| pg | `pg-cursor` 读 n+1 行后 `close()` |
| mysql | `connection.pause()` 读 n+1 行后 `destroy()` |

- 超时：驱动超时 + `AbortController`；锁定/超时会中止执行（见 §4.3）。
- 实测依据（2026-11-11，SQL Server 2025 / tedious 20.3.8）：A 3/3、B 5/5、C 全 PASS；取消均收到 `ECANCEL`，同连接与池内复用同 SPID，超时 2s 实际 2017ms，之后 3.1ms 可用。详见 `POC-RESULTS.md`。
- 失败只回错误码与数据库错误号。
- 结果：`row_json` 存 TEXT；单行 > 64KB 截断；总 8MB 上限；分页默认 100、最大 500。

---

## 8. 客户端

### 8.1 Web（同一份 SPA）

- 页面：解锁 → 待审批（筛选/搜索）→ 详情（SQL/参数/目的/摘要）→ 批准/拒绝 → 结果；
  数据源、Agent token、审计、锁定按钮与倒计时。
- token 只存内存；刷新后重新解锁。
- 安全头：CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' <allowed origins>; frame-ancestors 'self' dsh-app://app`、nosniff、no-referrer。

### 8.2 Windows 桌面（Electron，修订 F-07）

- 主进程：单实例锁；core 未运行则 `utilityProcess.fork(coreEntry)` 启动（以打包后的 JS 入口为准），轮询 `/v1/health` 最多 15s；失败时窗口显示诊断（端口/日志路径/错误码），不静默。若已有 core 在跑，先校验 `endpoint.json` 的 pid/version 与 `/v1/health` 一致，再连接（G-08）。
- 托盘：打开 / 锁定 / 退出；开机自启开关（`app.setLoginItemSettings`）。
- 渲染进程安全清单：`contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`、`webviewTag=false`、
  preload 为空或仅暴露版本号；禁止 `webSecurity=false`；`will-navigate` 只允许 `http://127.0.0.1:<port>`；
  `setWindowOpenHandler` 一律 deny；`setPermissionRequestHandler` 一律 deny。
- 安装包：electron-builder（NSIS）。

### 8.3 DSH 插件（修订 F-01/F-10）

- Host 半（Node）：注册 `sql_submit / sql_status / sql_result / sql_cancel / sql_list_sources`，
  调 Agent API；token 从插件配置读（仅提交/读）。
- Client 半：注册右侧栏 tab，内容为 `<iframe src="{core}/?embed=1">`；
  iframe 内用 Bearer session（登录响应 body 的 token，存内存）。
- 若 CSP/桌面壳禁止 iframe，或 CORS 预检失败：降级为"打开审批台"按钮（系统浏览器），并显示原因。
- **已实测（2026-11-11，DSH 桌面壳）**：`frame-ancestors 'self' dsh-app:` 放行；iframe 内 Bearer 全流程通过（hello → 登录 → `/me` → `/approve` 200 → 409 → 刷新重登）。判据须看 `child hello`，`iframe load` 被拒时也会触发。
- 插件不含任何数据库信息。

### 8.4 MCP server

- `stdio`；工具同 DSH Host 半；配置 `SAG_URL`/`SAG_TOKEN` 或参数；日志只写 stderr。
- 工具返回结构化 JSON；错误映射为 MCP 错误。

---

## 9. 自启与运维（修订 F-08/F-13）

- **自启**：桌面版登录项；Web/服务版计划任务（Windows）或 systemd user unit（Linux）；Docker `restart: unless-stopped`。
- 自启后**托盘常驻、不弹窗**；用户打开窗口才显示 LOCKED 登录页。
- Headless/Docker 首次设置：
  - `core setup --password-stdin`；
  - 或 `SAG_SETUP_PASSWORD_FILE`（一次性读取后删除文件；仅首次启动生效）。
- 数据目录：Windows 仅当前用户 ACL；Unix `0700`；Docker `/data` 卷。
- **Docker 绑定**（G-07）：容器内 `SAG_HOST=0.0.0.0`，宿主只发布 `127.0.0.1:43119:43119`；应用层 Host 校验仍只认 `127.0.0.1`/`localhost`，因此对外不可达。
- 日志：JSON Lines，7 天轮转；字段白名单；不含 SQL/参数/连接信息。
- 备份：`vault.json` + `control.db`；恢复需密码。
- 升级：替换 core；自动迁移；失败回滚到 `.bak` 并拒绝启动。

---

## 10. 打包与发布

| 包 | 内容 | 渠道 |
|---|---|---|
| `@sql-approval/core` | core + SPA 静态资源 | npm、Docker |
| `@sql-approval/mcp` | MCP server | npm、Docker |
| `@sql-approval/dsh` | DSH 插件 | npm（DSH 安装） |
| `sql-approval-desktop` | Electron 安装包 | GitHub Releases |

- pnpm workspace：`packages/{shared,core,web,mcp,dsh-plugin,desktop}`。
- 构建：`tsup`、`vite`、`electron-builder`；Node `engines >= 24`；镜像 `node:24-alpine`，非 root。
- License Apache-2.0；发布前核实 npm scope 与项目名（冲突则改 `@sag/*`）。

---

## 11. 测试与验收（修订 F-15）

| 层 | 内容 |
|---|---|
| 单元 | vault（KDF/包裹/篡改/AAD 错配）、策略 ≥40 条正负例、状态机、错误码、限流 |
| 集成 | 提交→批准→执行→结果；LOCKED 拒绝；密码错误；会话超时；**并发批准只有一个成功**；**锁定中止执行**；迁移失败回滚；端口占用；CORS 预检；CSRF；token 失效；**崩溃恢复（EXECUTING→FAILED）**；**提案到期 EXPIRED**；**改密码后旧会话失效** |
| 安全 | Agent token 不能批准；未登录 401；日志/错误无秘密；暴力锁定；**同源登录不返回 token**（G-02） |
| 客户端 | Web 全流程；MCP 工具；DSH 工具；Electron 启动/单实例/托盘 |

### 11.1 验收清单

1. 首次启动 → 设置密码 → 重启 → LOCKED → 解锁 → 提交/批准/取数成功。
2. 未解锁：Agent 可提交，批准返回 `NOT_UNLOCKED`，核心不发起数据库连接。
3. 改密码后旧密码失效、数据源仍可解。
4. `vault.json` 拷走、无密码：无法解出连接信息。
5. Agent token 泄露：只能提交/查询，不能批准、不能读配置。
6. 两个窗口同时批准同一提案：一个 200、一个 409，只执行一次。
7. 执行中锁定：查询中止、提案 FAILED、不产生结果。
8. DSH iframe 可用；被 CSP 拦截时降级按钮可用。
9. 重启后 TTL 内结果可读、超期清理。
10. 崩溃恢复：EXECUTING 残留 → FAILED(interrupted)，不重复执行。
11. 待审批超 24h → EXPIRED，批准返回 409。
12. 改密码后其他会话失效、当前会话可继续审批。
13. 四个客户端各自完成"提交 + 审批 + 结果"。

---

## 12. 风险与开放问题

| 风险 | 说明 | 处置 |
|---|---|---|
| 同账户代码执行 | 解锁期间可读内存 | 接受（基线）；缩短会话、擦引用 |
| node-sql-parser 覆盖 | 误拒/漏拒 | fail-closed + 只读账号兜底 + 负例集 |
| iframe/CSP | DSH 内嵌失败 | 降级"打开审批台" |
| Electron 体积 | ~120MB | 接受 |
| 端口被抢占 | 假审批台 | 单实例锁 + 启动校验 + UI 指纹 |
| 忘记密码 | 数据不可恢复 | `reset` + 明确提示 |

**开放问题**：默认端口（暂定 43119）、结果保留时长（暂定 24h）、v1 是否含 pg/mysql（暂定不含）、npm scope 冲突。
