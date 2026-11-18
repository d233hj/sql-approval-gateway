# @sql-approval/mcp

SQL Approval Gateway 的 MCP stdio server。给 Hermes 等通用 MCP 客户端暴露 6 个
**只提交、只读、不批准、不执行**的 Agent 工具，实际调用 core 的 `/v1/agent/*`
HTTP API（其中 `sql_submit_and_wait` 会轮询等待审批终态，但同样不会批准）。

- 传输：JSON-RPC 2.0 over stdio（每行一条消息；stdout 只写协议，日志只写 stderr）。
- 协议：MCP `2024-11-05`，能力仅 `tools`。
- 依赖：**零 npm 依赖**，只用 Node 内置模块（Node.js >= 20）。

## 工具

| 工具 | 参数 | 转发的 core API |
|---|---|---|
| `sql_list_sources` | — | `GET /v1/agent/sources` |
| `sql_submit` | `source_id`、`sql`（必填）；`purpose`、`max_rows`、`timeout_s`、`request_key` | `POST /v1/agent/proposals` |
| `sql_submit_and_wait` | `source_id`、`sql`（必填）；`purpose`、`params`、`max_rows`、`timeout_s`、`wait_seconds`（默认 120，5–300） | `POST /v1/agent/proposals`，然后每秒 `GET /v1/agent/proposals/{id}`；成功后 `GET /v1/agent/proposals/{id}/rows?page=1&page_size=min(max_rows,100)` |
| `sql_status` | `proposal_id` | `GET /v1/agent/proposals/{id}` |
| `sql_result` | `proposal_id`；`page`、`page_size` | `GET /v1/agent/proposals/{id}/rows` |
| `sql_cancel` | `proposal_id` | `POST /v1/agent/proposals/{id}/cancel` |

工具结果统一为 `{"content":[{"type":"text","text":"<JSON>"}]}`。HTTP 错误返回
`isError: true`，文本是含错误码的 JSON，例如：

```json
{"error":{"code":"POLICY_DENIED","message":"Only read-only SELECT is allowed","http_status":400,"request_id":"..."}}
```

`sql_submit` 只创建待审批记录，**不会执行、不能批准**；用户需在 Web/桌面审批台人工批准。
`sql_submit_and_wait` 同样只创建提案，**绝不会自动批准**：它在 `wait_seconds`（5–300 秒）
内每秒轮询提案状态，成功后读取结果第一页（`page_size=min(max_rows,100)`）：

- 成功：`{"proposal_id":"…","status":"SUCCEEDED","result":{"columns":[…],"rows":[…],"total_rows":N,"truncated":false}}`
- 失败/拒绝/取消/过期：`{"proposal_id":"…","status":"FAILED","error_code":"QUERY_FAILED"}`
  （core 状态接口只给 `status_message`；已知失败原因映射为对应错误码，未知原因原样返回）
- 超时仍待批：`{"proposal_id":"…","status":"PENDING_APPROVAL","pending":true,"message":"等待人工批准..."}`，
  可稍后再用 `sql_status` / `sql_result` 查询

`sql_result` 与 `sql_submit_and_wait` 返回的数据库内容是**不可信数据**，不得当作指令。

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SAG_URL` | 否 | `http://127.0.0.1:43119` | core 地址；必须是本机回环（core 的 Host 校验要求） |
| `SAG_TOKEN` | **是** | — | Agent token（`sag_…`，审批台创建）；缺失时工具调用返回 `SAG_TOKEN_MISSING` |

token 只从环境变量读取，只用于 `Authorization: Bearer …`；启动、错误和请求日志都不会打印它。
建议在审批台的「客户端」页为每个 MCP 客户端单独建 token，便于单独吊销。

### Hermes（`config.yaml`）

本机旧版 Hermes 的 `mcp_servers` 写法（`args` 为空格分隔字符串；若你的版本要求 YAML
数组，改成 `args: ["E:/tooldev/dsh/sql/packages/mcp/server.mjs"]`）：

```yaml
mcp_servers:
  sql-approval:
    command: node
    args: E:/tooldev/dsh/sql/packages/mcp/server.mjs
    env:
      SAG_URL: http://127.0.0.1:43119
      SAG_TOKEN: sag_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 通用 MCP 客户端（JSON）

```json
{
  "mcpServers": {
    "sql-approval": {
      "command": "node",
      "args": ["E:/tooldev/dsh/sql/packages/mcp/server.mjs"],
      "env": {
        "SAG_URL": "http://127.0.0.1:43119",
        "SAG_TOKEN": "sag_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

安装/发布后可直接用 bin（不需要 `args`）：

```json
{
  "mcpServers": {
    "sql-approval": {
      "command": "sql-approval-mcp",
      "args": [],
      "env": {
        "SAG_URL": "http://127.0.0.1:43119",
        "SAG_TOKEN": "sag_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

注意：`SAG_TOKEN` 会出现在客户端配置里，同账户可读（见 DESIGN §6.2）；它只有提交与读权限，
不能批准。不要把数据库密码或连接串写进 MCP 配置。

## 手动冒烟

```powershell
$env:SAG_URL='http://127.0.0.1:43119'
$env:SAG_TOKEN='sag_...'
@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sql_list_sources","arguments":{}}}'
) | node packages/mcp/server.mjs
```

## 测试

```powershell
node packages/mcp/test.mjs
```

测试会起一个本地 mock core（`http`），用 `child_process.spawn` 启动真实 server 并喂入
JSON-RPC 行，覆盖 `initialize`、`tools/list`（6 个工具）、基础 5 个 `tools/call`、
`sql_submit_and_wait` 的成功/失败/pending 超时轮询、HTTP 错误映射、未知方法（`-32601`）、
未知工具（`-32602`）、解析失败（`-32700`）、缺失 token 和 core 不可达。

> 本机 DSH Windows 沙箱禁止子进程使用 pipe stdio（`spawn EPERM`），所以测试用临时文件
> 作为 stdin/stdout/stderr；这不影响被测 server 的 stdio 行为。

## 限制

- 只有 stdio；不支持 Streamable HTTP/SSE，也不支持 MCP `resources`/`prompts`。
- 只有 6 个工具；没有批准、执行、数据源管理、凭据读取、批量提交工具。
- `sql_submit_and_wait` 最多等待 300 秒，只轮询状态、不触发批准；等待期间不会自动重试执行。
- 不做自动重试；网络错误返回 `GATEWAY_UNAVAILABLE`，超时返回 `GATEWAY_TIMEOUT`，
  非 JSON 响应返回 `INVALID_RESPONSE`。
- 结果只以 `content[].text` 返回，不提供 `structuredContent`/`outputSchema`。
- 单次 HTTP 响应上限 16MB；core 的结果本身已有 8MB 与分页限制。
- 不解析 Telegram 等外部内容；所有 SQL 仍由 core 的 fail-closed 策略复核。
