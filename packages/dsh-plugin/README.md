# @sql-approval/dsh — DSH 插件版（P3-b）

SQL Approval Gateway 的 DSH 插件：Host 半向模型暴露 6 个 Agent 工具，Client 半在右侧栏内嵌审批台。
本包**不包含**数据库连接信息、数据库凭据或任何批准/拒绝工具；批准只能由人在 core 的审批台中完成。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包名 `@sql-approval/dsh`、`dsh.bundle.patch`、`dsh.client`（platform `web`，inject `@deepseek-ai/dsh-client-ui-sidebar-right`） |
| `cordis.patch.yml` | `insert` 一行 Loader 条目，id 为 `sql-approval` |
| `index.js` | Host 半：注册 `sql_submit` / `sql_submit_and_wait` / `sql_status` / `sql_result` / `sql_cancel` / `sql_list_sources`，转发到 core 的 `/v1/agent/*`；`sql_submit_and_wait` 只轮询等待人工审批，绝不代批 |
| `client.js` | Client 半：注册 `sidebar.right.pane.tab`，内嵌 `<iframe src="{core}/?embed=1">`，顶部「打开审批台」，CSP 拦截时降级 |
| `locale/*.json`、`icon.svg` | 插件管理器的标题、描述与图标 |
| `test-host.mjs` | 零依赖契约测试：本地 mock HTTP 验证 6 个工具的转发与错误映射，含提交并等待的成功/失败/超时 pending/取消路径 |

## 前置条件

1. core 已在运行（默认 `http://127.0.0.1:43119`），且已设置管理员密码。
2. 已创建一个 Agent token（`sag_…`）。该 token 只有提交/读取权限，不是管理员密码。
3. DSH profile 已启用 `@deepseek-ai/dsh-client-ui-sidebar-right`（本插件在 `dsh.client.inject` 中声明）。

## 配置

插件 config 优先于环境变量：

| config | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `url` | `SAG_URL` | `http://127.0.0.1:43119` | 必须是回环地址（`127.0.0.1` / `localhost` / `::1`） |
| `token` | `SAG_TOKEN` | 无 | Agent token，必须以 `sag_` 开头 |

> config 中也接受 `SAG_URL` / `SAG_TOKEN` 这两个键名；`url` / `token` 优先。

推荐用环境变量，避免 token 进入 profile 配置：

```powershell
$env:SAG_URL = 'http://127.0.0.1:43119'
$env:SAG_TOKEN = 'sag_…'
```

若 `cordis.patch.yml` 的 `config: {}` 需要显式填写，可改为：

```yaml
- insert:
    - id: sql-approval
      name: '@sql-approval/dsh'
      config:
        url: http://127.0.0.1:43119
        token: sag_…
```

缺少 token 或 URL 非回环时插件仍会加载，但每个工具调用会返回 `CONFIG_INVALID` 工具错误，便于在 UI 中看到配置问题。

Host 半还会注册只读的 `GET /sql-approval/client-config`（及 `/api/sql-approval/client-config` 别名），让 Client 半取得当前 core 地址；响应只含 `core_url` / `embed_url`（配置有问题时附加 `config_error`），**不含 token**。

## 安装

安装需要主会话在 DSH 中人工审批；本任务不执行安装。把下面的 `target` 换成绝对路径后调用 `plugin_manager`：

```json
{
  "action": "install_bundle",
  "target": "<repo>/packages/dsh-plugin"
}
```

- 必须是**绝对路径**（不要用 `~`、相对路径或 `file:` URL）。
- 安装后确认返回的 `application` 为 `applied`，并在 `cordis_inspect_query`（Tool / Slots）中确认 6 个工具与 `sidebar.right.pane.tab` 已注册。
- 若 profile 中仍启用旧版 `@local/dsh-sql-approval`：两者会注册同名工具，且旧版同样插入 id `sql-approval`。请先停用/移除旧 bundle，避免工具重名或 patch 行冲突。
- 修改 `client.js` 后需要刷新 DSH 页面；JS 模块代际变化可能需要重启 DSH 进程（以安装结果中的提示为准）。

## 使用

- 右侧栏的「+」/ guide 中出现 **SQL 审批** 卡片，打开后即加载 `{core}/?embed=1`。
- 顶部「打开审批台」在新窗口打开同一地址，可用于 CSP 降级或独立使用。
- 模型工具：
  - `sql_list_sources` → `{sources:[{id,name,dialect}]}`
  - `sql_submit` → `{proposal_id,status,expires_at,next_step}`（只创建待审批记录）
  - `sql_submit_and_wait` → 提交后每 1s 轮询，直到终态或 `wait_seconds`（默认 120，5–300）用完；**不会自动批准，只是在等待用户在审批台操作**。`SUCCEEDED` → `{proposal_id,status,result:{columns,rows,total_rows,truncated}}`（首页 `page_size=min(max_rows,100)`）；其他终态 → `{proposal_id,status,error_code}`；超时仍待审批 → `{proposal_id,status:'PENDING_APPROVAL',pending:true,message}`。相同 `source_id+sql+params` 的并发调用会被拒绝（`SUBMIT_IN_FLIGHT`），响应 `exec.signal` 取消（`SAG_CANCELLED`）。
  - `sql_status` → 提案状态对象（`proposal_id/status/…`）
  - `sql_result` → `{proposal_id,status:'SUCCEEDED',columns,rows,page,page_size,total_rows,truncated,…}`
  - `sql_cancel` → `{proposal_id,status:'CANCELLED'}`
- 参数名与 core Agent API 一致：`source_id`、`sql`、`purpose`、`max_rows`、`timeout_s`、`request_key`（另支持可选 `params`；`sql_submit_and_wait` 另有 `wait_seconds`，不支持 `request_key`）。

## CSP 与降级

- 本插件不修改 core 或 DSH 的 CSP；core 需要允许被 DSH 页面 frame（设计 §8.1/§8.3）。
- Client 半监听父页面的 `securitypolicyviolation`（`frame-src` / `child-src` / `default-src`）。若拦截的是本 core origin，面板显示「审批台无法内嵌显示」及原因，并提供「打开审批台」和「重试」。
- 按设计 §8.3，`iframe load` 在 frame 被拒时也会触发，因此判定以 core origin 的 `postMessage` 握手（child hello）为准；4 秒内未收到握手会显示非阻断警告。
- Client 半不读取、不写入 `localStorage` 中的 token；登录态只在 iframe 文档内维护。

## 验证

```powershell
node --check packages/dsh-plugin/index.js
node --check packages/dsh-plugin/client.js
node --check packages/dsh-plugin/test-host.mjs
node packages/dsh-plugin/test-host.mjs
```

`test-host.mjs` 不依赖任何第三方包，也不连接真实数据库；它在 `127.0.0.1` 上启动 mock HTTP 服务，覆盖 6 个工具的转发、鉴权头、分页参数、幂等响应，以及 `PROPOSAL_NOT_FOUND` / `NOT_SELECT` / `UNAUTHENTICATED` / `SAG_TIMEOUT` / `SAG_UNREACHABLE` / `INVALID_RESPONSE` / `CONFIG_INVALID` 等错误映射；`sql_submit_and_wait` 另覆盖成功取数、终态失败、超时仍 pending（不发批准请求）、并发重复提交被拒（`SUBMIT_IN_FLIGHT`）、`exec.signal` 取消（`SAG_CANCELLED`）与 `wait_seconds` 参数校验，共 22 项断言。

## 未完成 / 已知限制

- 未执行 `plugin_manager install_bundle`（需主会话审批）。
- 未在真实 DSH 页面点击验证 slot 渲染与 iframe 全流程；本任务只完成静态检查与 Host 契约测试。
- iframe 依赖 core 提供 `?embed=1` 的 SPA 与 child hello；core 当前仓库尚未包含 Web SPA 时，面板会显示握手警告/降级提示。
- Client 半从 Host 的 `/sql-approval/client-config` 读取 core 地址；若该路由不可达（例如未注册 webServer），退回默认 `http://127.0.0.1:43119` 并显示配置提示。
- 没有批准/拒绝工具，也不读取 core 的管理员密码或数据库连接信息。
