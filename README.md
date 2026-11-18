# SQL Approval Gateway · SQL 审批网关

> **AI 写只读 SQL，人批准，网关执行。** 让大模型查数据库这件事变得可审计、可控、可撤销。
>
> 一个本地优先（local-first）的只读 SQL 网关：Agent 只能**提交**只读查询提案，永远拿不到数据库凭据；
> 人必须在已解锁的会话里**逐条批准**，由网关代为执行并回传结果。同一套 core 服务四种客户端：
> Web 审批台、Windows 桌面端、DeepSeek Harness 插件、MCP stdio server。

<p align="center"><em>Status: v0.1.0 — 早期可用版本，接口与数据格式仍可能调整。</em></p>

---

## 目录

- [为什么需要它](#为什么需要它)
- [核心保证](#核心保证)
- [功能一览](#功能一览)
- [架构](#架构)
- [安全模型与等级对齐](#安全模型与等级对齐)
- [运行环境](#运行环境)
- [快速开始](#快速开始)
- [首次使用](#首次使用)
- [接入客户端](#接入客户端)
- [配置参考](#配置参考)
- [运维与备份](#运维与备份)
- [API 速览](#api-速览)
- [质量与测试](#质量与测试)
- [已知限制与路线图](#已知限制与路线图)
- [安全披露](#安全披露)
- [License](#license)

---

## 为什么需要它

把数据库交给 AI 查询，常见的做法有两种，都不太理想：

- **直接把只读账号给模型**：模型可以直接执行任意 SQL，没有人工闸门，出了问题无法追溯"是谁在什么时候查了什么"；
- **让模型拼 SQL、人复制到客户端执行**：靠人肉复制粘贴，流程不可控，也没有统一的审计。

SQL Approval Gateway 把这件事拆成三方：**Agent 提交 → 人审批 → 网关执行**。

```
Agent (LLM / MCP / DSH 插件)     人（审批台）                数据库
         │  提交只读提案              │  解锁 + 批准               │
         └──────────────▶ core ◀─────┘                            │
                         │  校验策略、执行、审计                    │
                         └────────────────────────────────────────▶
```

关键点：**凭据只在 core 的加密 vault 里**，Agent 侧只有提交/读取权限的 token；没有人的批准，任何 SQL 都不会执行。

---

## 核心保证

1. **Agent 拿不到凭据**：数据库地址、账号、密码保存在 vault（scrypt 派生密钥 + AES-256-GCM 加密），只在下述时刻存在于 core 内存：解锁后、执行时。
2. **没有人工批准就不执行**：提案创建后处于 `PENDING_APPROVAL`；批准必须来自已解锁的管理会话（Web/桌面），Agent token 没有 approve 能力。
3. **只读是双保险**：AST 策略层先拒绝一切非单条 `SELECT`（写操作、DDL、`SELECT INTO`、跨库、临时表、元数据探测、危险锁提示等），执行层再由数据源只读校验/只读连接兜底。
4. **一切可审计**：提案、批准、执行、设置变更都写入追加式 SHA-256 哈希链，提供链校验接口。

---

## 功能一览

- **四种客户端，一个 core**：Web SPA（同源托管）、Windows Electron 桌面端（托盘/单实例/自启）、DSH 插件（右侧边栏）、MCP stdio server（Hermes 等通用 Agent 框架）。
- **响应式审批台**：SSE 推送，Agent 提交后页面秒级出现新提案（不是轮询）；右下角 Windows 通知（可关）。
- **人工审批闭环**：批准前二次校验 SQL 摘要与策略版本；执行可取消；超时/过期自动收敛。
- **Agent 体验**：`sql_submit_and_wait` —— 提交后等待人工批准并自动回读结果，但**绝不代批准**。
- **凭据与权限**：Agent token `sag_…` 只在创建时显示一次，服务端只存 SHA-256；可在设置页随时吊销。
- **严格只读模式**（默认开启）：数据源必须先通过只读预检，否则拒绝执行。
- **审计**：哈希链 + 校验接口，导出接口供 SIEM/归档。
- **部署**：单机后台服务 + 桌面端/便携 exe；可选 Docker（仅回环发布）。

---

## 架构

```
┌────────────────────────────── core（Node 24 / TypeScript）──────────────────────────────┐
│ HTTP :43119（默认仅 loopback）                                                          │
│  ├─ /v1/agent/*    Bearer agent token：提交、查询、读结果、取消                          │
│  ├─ /v1/admin/*    session（Cookie 或 Bearer）：解锁、审批、数据源、设置、审计             │
│  ├─ /v1/events     SSE：提案创建/状态变化实时推送                                         │
│  ├─ /v1/health     健康检查                                                              │
│  └─ /              同源托管的 Web 审批台（SPA）                                           │
│                                                                                          │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ SQL 策略   │  │ 提案存储/审计 │  │ vault        │  │ 执行器     │  │ 会话/限流/单实例  │ │
│  │ AST 校验   │  │ SQLite WAL   │  │ scrypt+GCM   │  │ worker线程 │  │ 锁、空闲锁定      │ │
│  └───────────┘  └──────────────┘  └──────────────┘  └───────────┘  └──────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                         ▲                        ▲
   Web SPA              DSH 插件                  Windows 桌面端              MCP server
（同源 iframe）      （侧边栏 + 6 工具）          （Electron 45 + 托盘）      （stdio JSON-RPC）
```

组件：

| 包 | 说明 |
|---|---|
| `packages/shared` | Zod 请求/响应 schema、常量、错误码（core 与插件共用） |
| `packages/core` | HTTP 服务、SQL 策略（AST）、提案存储、vault、执行器（worker_threads）、审计链、SSE |
| `packages/web` | 无框架 TypeScript SPA：审批台、设置、数据源、Agent 客户端管理 |
| `packages/desktop` | Electron 桌面壳：窗口、托盘、单实例、开机自启、便携打包 |
| `packages/dsh-plugin` | DSH 插件：6 个 `sql_*` 工具 + 右侧边栏审批面板 |
| `packages/mcp` | MCP stdio server：零依赖，JSON-RPC 2.0，6 个工具 |

数据流（一次查询）：

1. Agent 调用 `sql_submit`（或 `sql_submit_and_wait`）→ `POST /v1/agent/proposals`；
2. core 做 AST 只读策略校验、绑定摘要与策略版本、落库为 `PENDING_APPROVAL`，并通过 SSE 推送；
3. 用户在审批台批准 → `POST /v1/admin/proposals/{id}/approve`（二次校验摘要/策略/来源只读）；
4. core 在 worker 线程中执行（超时、行数上限、可取消），结果落库并回传分页；
5. 全链路写审计（哈希链）。

---

## 安全模型与等级对齐

**基线：不高于本机 DBeaver 的凭据保护水平**（用户密码加密本地配置；不防御同账户内已获得代码执行的进程）。
在此基础上，本产品额外提供"人工审批 + 只读策略 + 审计链"三层约束。

| 资产 | 保护方式 | 明确不防 |
|---|---|---|
| 数据源连接信息 | 用户密码 → scrypt → 包裹 DEK → AES-256-GCM 加密落盘（`vault.json`） | 同账户内可执行代码者（可读内存/键盘记录） |
| 管理员会话 | 内存会话 + HttpOnly Cookie（同源）/ Bearer（跨源）；空闲自动锁定 + 绝对上限 | 本机管理员 |
| 审批权 | 仅已解锁会话可批准；Agent token 无审批能力 | 用户主动批准恶意 SQL |
| 查询执行 | AST 只读策略 + 数据源只读校验（严格模式默认开启）+ 执行层只读连接/只读打开 | 数据库账号本身权限过大（部署时须用独立只读账号） |
| 审计 | 追加式 SHA-256 哈希链 + 校验接口 | 能改写整库并重算链的本机管理员 |
| Agent token | `sag_` + 32 字节随机；服务端仅存 SHA-256；可吊销；记录最近使用时间 | 同账户可读 token 文件的环境（token 文件应与 core 同权限保护） |

**信任边界**：Agent 与 Gateway 同机同用户；Agent 可提交提案、读取自己提案的结果，但**没有管理密码就解不开 vault**。

**部署建议（生产环境必读）**

- 为网关创建**独立的数据库只读账号**，只授予目标库/表的 `SELECT`；
- core 只监听回环地址，不要暴露到网络（默认 `127.0.0.1:43119`）；
- `data/` 目录用操作系统 ACL 限制为运行账号 + 管理员；整机磁盘加密；
- Windows 通知/托盘等便利功能不承载任何凭据；
- 审计导出定期归档到独立系统。

**明确不在范围内的威胁**（v1）：本机管理员、同账户恶意进程/键盘记录、内存转储、数据库侧旁路、社会工程骗取批准、
多租户/RBAC/SSO、无人值守自动执行。

---

## 运行环境

| 项 | 要求 / 默认 |
|---|---|
| 操作系统 | **Windows 10/11 x64（主目标）**；core 本身跨平台，Linux/macOS 可跑服务端 |
| Node.js | **≥ 24**（使用内置 `node:sqlite`；桌面端 Electron 45 内置 Node 24） |
| 桌面端 | Electron 45（打包产物随附，无需单独安装） |
| 数据库 | **SQLite**（内置，零依赖）、**SQL Server**（`mssql` 驱动）；PostgreSQL / MySQL 目前仅支持连通性与只读预检，执行待实现 |
| 监听 | 默认 `127.0.0.1:43119`，仅回环 |
| 存储 | `data/vault.json`（加密凭据）+ `data/control.db`（SQLite WAL：提案/审计/设置/客户端） |
| 容器 | 可选 Docker（镜像仅发布到宿主回环） |
| 浏览器 | 任意现代浏览器（Web 审批台无外部依赖） |

---

## 快速开始

### 方式 A：Windows 便携版（推荐给最终用户）

1. 从 Releases 下载 `SQL审批网关-<version>-portable.exe`；
2. 首次运行若出现 SmartScreen，点「更多信息 → 仍要运行」；
3. 双击后等待窗口出现（便携版每次启动需解压运行时，首次约 1–2 分钟，属正常现象）；
4. 按[首次使用](#首次使用)完成设置。

> 便携版数据保存在 exe 同目录的 `data\`，整个目录可整体拷贝/迁移。

### 方式 B：源码运行（开发者）

```bash
git clone https://github.com/d233hj/sql-approval-gateway.git
cd sql-approval-gateway

npm install
npm run build        # shared + core
npm run build:web    # Web SPA（core 同源托管）

npm run start:core -- --data-dir ./data --port 43119
# 打开 http://127.0.0.1:43119
```

桌面端（可选）：

```bash
npm install -w @sql-approval/desktop
npm run start -w @sql-approval/desktop
```

> 若在 Electron 宿主的终端里启动，先清除 `ELECTRON_RUN_AS_NODE`，否则 Electron 会以纯 Node 运行。

### 方式 C：Docker（可选）

```bash
npm run docker:build
# 首次设置可用一次性密码文件（详见 deploy/README.md）
docker compose up -d
# 仅发布 127.0.0.1:43119
```

---

## 首次使用

1. **设置管理密码**：打开 <http://127.0.0.1:43119>，首次进入设置密码（≥12 位，字母+数字）。密码只用于解锁 vault，**不会保存明文**。
2. **添加数据源**：设置 → 数据源 → 新增。SQLite 填文件路径；SQL Server 填主机/端口/库/用户名/密码。保存后点「测试」做连通性与只读预检。
3. **创建 Agent token**：设置 → Agent 客户端 → 新建，复制一次性的 `sag_…` token（只显示一次）。
4. **接入客户端**（见下一节），或直接在浏览器审批台里手动提交/审批。
5. **锁定**：审批台右上角锁定，或直接退出桌面端（托盘 → 退出）；空闲超时也会自动锁定。

默认会话策略：空闲 10 分钟锁定，会话绝对上限 8 小时（可在设置中调整，1–1440 分钟 / 1–24 小时）。

---

## 接入客户端

### Web 审批台

core 同源托管，浏览器打开 `http://127.0.0.1:43119` 即可；无需额外配置。

### Windows 桌面端

- 源码运行：`npm run start -w @sql-approval/desktop`；
- 便携版：见[方式 A](#方式-a-windows-便携版推荐给最终用户)；
- 桌面端会复用已在运行的 core（或自己拉起同一个 data 目录），支持托盘、单实例、开机自启、锁定。

### DeepSeek Harness（DSH）插件

在 DSH profile 的 `cordis.patch.yml` 中注册插件（路径为本仓库 `packages/dsh-plugin`），或安装为本地包：

```yaml
- insert:
    - id: sql-approval
      name: '@sql-approval/dsh'
      config:
        url: http://127.0.0.1:43119
```

token 建议用环境变量 `SAG_TOKEN`（`sag_…`）注入，避免写进 profile。插件提供 6 个工具：
`sql_list_sources`、`sql_submit`、`sql_submit_and_wait`、`sql_status`、`sql_result`、`sql_cancel`。
详见 [`packages/dsh-plugin/README.md`](packages/dsh-plugin/README.md)。

### MCP（通用 Agent 框架）

```json
{
  "mcpServers": {
    "sql-approval": {
      "command": "node",
      "args": ["<repo>/packages/mcp/server.mjs"],
      "env": {
        "SAG_URL": "http://127.0.0.1:43119",
        "SAG_TOKEN": "sag_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

MCP 与 DSH 插件使用同一组工具语义：**只提交、只读、不批准、不执行**。详见 [`packages/mcp/README.md`](packages/mcp/README.md)。

---

## 配置参考

### core

| 环境变量 / 参数 | 默认 | 说明 |
|---|---|---|
| `--data-dir <path>` | `./data` | 数据目录（vault + 控制库 + 日志） |
| `--port <port>` | `43119` | 监听端口（仅回环） |
| `SAG_HOST` | `127.0.0.1` | 监听地址；不要改成 `0.0.0.0` |
| `SAG_WEB_DIST` | `packages/web/dist` | Web SPA 构建产物目录 |
| `SAG_SETUP_PASSWORD_FILE` | — | 首次设置的一次性密码文件（容器/自动化） |
| `SAG_AGENT_TOKEN` | — | 启动时确保存在一个默认 Agent token（可选） |
| `SAG_ALLOW_NON_LOOPBACK_BIND` | `0` | 仅容器内需要显式通配 bind 时设为 `1`；Host/Origin 仍只认回环 |

### 客户端

| 环境变量 | 说明 |
|---|---|
| `SAG_URL` | core 地址（默认 `http://127.0.0.1:43119`） |
| `SAG_TOKEN` | Agent token（`sag_…`，只在创建时显示一次） |
| `SAG_DATA_DIR` | 桌面端数据目录覆盖（便携版默认 exe 同目录 `data\`） |
| `SAG_TOAST=0` | 关闭新提案的 Windows 通知 |

> 其余 `SAG_SESSION_*` / `SAG_*_TTL_MS` 为测试/调试用覆盖项，生产请使用审批台内的设置项。

### 默认策略参数

| 项 | 默认 | 可调范围 |
|---|---|---|
| 默认返回行数 / 最大行数 | 500 / 5000 | 设置页 |
| 查询超时 | 30s / 最大 120s | 设置页 |
| 审批窗口 | 24h | 设置页 |
| 结果保留 | 24h | 设置页 |
| 严格只读校验 | 开启 | 设置页 |

---

## 运维与备份

- **数据文件**：`vault.json`（加密凭据）、`control.db`（提案/审计/设置）+ `control.db-wal`；停服务后整体复制即完成备份。
- **升级**：替换程序文件后重启即可；控制库带 schema 版本，启动时自动迁移并生成 `.bak-<version>` 备份。
- **开机自启（Windows）**：`npm run autostart:install`；状态 `npm run autostart:status`；卸载 `npm run autostart:uninstall`。
- **端口边界**：不要将 `:43119` 暴露到局域网；Docker 场景只映射到宿主回环。
- **锁定**：审批台手动锁定、桌面托盘锁定、空闲/绝对超时都会清会话；锁定后 `/v1/events` 返回 423。

---

## API 速览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/health` | 健康检查（无认证） |
| `GET` | `/v1/events` | SSE 提案事件流（cookie/Bearer；锁定 423） |
| `POST` | `/v1/admin/setup` | 首次设置密码 |
| `POST` | `/v1/admin/unlock` | 解锁，返回会话（嵌入模式可返回 Bearer） |
| `POST` | `/v1/admin/lock` | 立即锁定 |
| `GET` | `/v1/admin/proposals` | 审批列表 |
| `POST` | `/v1/admin/proposals/{id}/approve` | 批准并执行 |
| `POST` | `/v1/admin/proposals/{id}/reject` | 拒绝（可填原因） |
| `GET` | `/v1/admin/proposals/{id}/rows` | 结果分页 |
| `GET/POST/PUT/DELETE` | `/v1/admin/sources*` | 数据源管理与只读预检 |
| `GET/POST/DELETE` | `/v1/admin/clients*` | Agent token 管理 |
| `GET` | `/v1/admin/audit`、`/v1/admin/audit/verify` | 审计导出与链校验 |
| `GET` | `/v1/agent/sources` | Agent 可见的数据源元数据（无连接信息） |
| `POST` | `/v1/agent/proposals` | 提交只读提案 |
| `GET` | `/v1/agent/proposals/{id}` | 提案状态 |
| `GET` | `/v1/agent/proposals/{id}/rows` | 结果分页 |
| `POST` | `/v1/agent/proposals/{id}/cancel` | 取消待审批提案 |

错误码、字段与鉴权细节见 [`docs/design/DESIGN.md`](docs/design/DESIGN.md)。

---

## 质量与测试

```bash
npm run typecheck
npm test            # core：231 项（含 SQL 策略对抗语料 76/76）
npm run build:web
```

- SQL 策略：76 条对抗语料（多语句、CTE 绕过、`SELECT INTO`、跨库、临时表、元数据函数、锁提示等）全部拦截；
- core：单元 + 集成 + 真机 socket 测试（SSE、审批并发、审计链篡改检测、单实例锁、vault 往返）；
- Web：传输层/嵌入模式测试；桌面：托盘锁、停机、endpoint 发现、数据目录解析等纯函数测试。

CI：见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

---

## 已知限制与路线图

**已知限制**

- PostgreSQL / MySQL 目前只有连通性与只读预检，**执行未实现**；执行支持 SQLite 与 SQL Server。
- 查询结果（SQL、参数、结果行）在控制库中是明文，受 OS ACL 保护；不防同账户读取。
- Windows 桌面/便携产物**未签名**，首次运行会触发 SmartScreen。
- 便携版每次启动解压运行时，冷启动较慢；日常建议用安装/运行时版。
- 暂无多租户、RBAC、SSO/OIDC、审计导出到 SIEM 的连接器。
- 桌面端目前仅 Windows 构建；Linux/macOS 仅服务端可用。

**路线图**

- [ ] PostgreSQL / MySQL 执行器
- [ ] 结果列级加密 / 结果 TTL 策略细化
- [ ] 多用户与角色（审批人/审计员/管理员）
- [ ] 审计导出（CSV/JSONL）与外部 SIEM 对接
- [ ] 代码签名与自动更新
- [ ] macOS / Linux 桌面构建

---

## 安全披露

发现安全问题请**不要**公开提 Issue，按 [SECURITY.md](SECURITY.md) 的流程私下报告。

---

## License

[MIT](LICENSE) © 2026 SQL Approval Gateway contributors

<sub>English abstract: A local-first, human-in-the-loop read-only SQL gateway. LLM agents can only submit read-only proposals; a human must approve each one in an unlocked session; the gateway executes with credentials that never leave its encrypted vault. Four clients (Web, Windows desktop, DSH plugin, MCP) share one auditable core.</sub>
