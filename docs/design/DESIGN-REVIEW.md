# 设计审查报告 — 第 1 轮

> 对象：`docs/design/DESIGN.md` v1.0
> 日期：2026-11-10 ｜ 审查方式：自审（逐节对照需求与实现可行性）
> 结论：**不通过**。发现 3 个高、6 个中、6 个低优先级问题；其中 F-01/F-02/F-03 会导致实现返工，必须先修。

---

## 1. 审查基准

1. 需求：Agent 拿不到连接信息；审批必须由人；网关可自启但要密码；四客户端（Web/桌面/DSH/MCP）；开源可发布。
2. 技术约束：TS + Node 24 + Electron，无 Rust；不引入账户隔离/KMS/BitLocker。
3. 判定：设计是否**可以直接照着写代码**——接口、状态、竞态、失败路径都要有确定答案。

---

## 2. 发现

| ID | 级别 | 位置 | 问题 | 影响 |
|---|---|---|---|---|
| F-01 | **高** | §4.3 / §8.1 / §8.3 | DSH 面板用 iframe 加载 `http://127.0.0.1:43119`，而 DSH 页面源是 `dsh-app://app`：跨站 iframe 下 `SameSite=Strict` Cookie **不会发送**，第三方 Cookie 也可能被浏览器拦截；同时 CSP `frame-ancestors` 与 `X-Frame-Options: DENY` 冲突。文档只说"跨源用 Bearer"，但没有定义 CORS、预检、frame-ancestors、token 如何传给 iframe。 | iframe 登录必失败；实现时才发现要重做鉴权 |
| F-02 | **高** | §6.3 / §7.2 | 批准没有定义"条件更新"：两个窗口同时点批准会读到同一 PENDING 并各执行一次。 | 同一查询执行两次；审计出现双 EXECUTING |
| F-03 | **高** | §4.1 / §4.3 / §7.2 | 锁定/会话超时与"执行中查询"的竞态未定义：锁定时 DEK 被擦、连接池关闭，正在跑的查询是被中止、还是继续、结果是否还能写？ | 数据不一致、密钥擦除后仍持有连接、结果泄漏 |
| F-04 | 中 | §7.2 | "流式取到 max_rows 再读一行判定 truncated 后取消"没有按驱动定义：mssql `request.cancel()` 后连接通常不可复用；pg 需要 cursor；取消与已读行的竞态未说明。 | 实现按驱动各写一套，行为不一致 |
| F-05 | 中 | §5 / §9 | 审计是"哈希链"但无密钥、无验证命令；"防篡改"表述过强（能改库的人可重算整链）。 | 安全声明不实；事后无法证明 |
| F-06 | 中 | §3.2 / §8 | 客户端如何发现 core 的端口/URL 未定义（端口可配置）。DSH/MCP 写死 43119 会在改端口时失效。 | 部署后客户端连不上 |
| F-07 | 中 | §8.2 | Electron 仅写了 contextIsolation/sandbox，缺：权限请求拒绝、导航拦截细则、webview 禁用、preload 为空、禁止 `webSecurity=false`、单实例与 core 子进程失败处理。 | 桌面壳成为薄弱点 |
| F-08 | 中 | §9 | 自启后是"托盘不弹窗"还是"直接弹登录"未定义；headless/Docker 首次 setup 的路径缺失（没有 GUI 怎么设密码？）。 | 无法部署到无头环境 |
| F-09 | 中 | §6.1 | Host 校验只防 DNS rebinding 的一半；缺 `Origin`/`Sec-Fetch-Site` 校验、CORS 允许清单、CSRF 的适用矩阵。 | 跨站请求伪造/被恶意页面调用 |
| F-10 | 中 | §6.2 / §8.3 | Agent token 的哈希算法、前缀、轮换、禁用、last_used 更新未定义；DSH 配置里的 token 可被同账户读取（可接受，但要写明）。 | 实现不一致；安全声明模糊 |
| F-11 | 低 | §7.1 | 策略覆盖不足：`WITH … DELETE`、`OPTION (...)`、`FOR XML/JSON`、`PIVOT`、注释/字符串中的关键字、Unicode 变体；缺负例语料。 | 误拒/漏拒 |
| F-12 | 低 | §7.2 | 结果总大小上限（8MB）与分页、压缩、单行超大值未定义；`row_json` 存 SQLite 的方式未定义（JSON 字符串还是列）。 | 实现分歧 |
| F-13 | 低 | §9 | 数据目录权限（Windows ACL/Unix 0700）、迁移备份、版本回滚未定义。 | 运维风险 |
| F-14 | 低 | §10 | 项目名/包名/许可证未核实是否与既有项目冲突；`@sql-approval` scope 可能已被占用。 | 发布前改名 |
| F-15 | 低 | §11 | 测试缺并发/竞态/迁移/断网/端口占用用例；缺"Agent 不能批准"的负向集成测试。 | 回归覆盖不足 |

---

## 3. 逐项修改要求

| ID | 必须改成 |
|---|---|
| F-01 | 明确双通道：①同源（Web/桌面）用 Cookie；②跨源（DSH iframe）用 **Bearer session token**，登录响应在 body 返回 token，SPA 仅存内存；core 增加 CORS 允许清单（`dsh-app://app`、`http://127.0.0.1:<port>`），处理 `OPTIONS` 预检（allow `authorization,content-type,x-sag-csrf`）；CSP 改为 `frame-ancestors 'self' dsh-app://app`，移除 `X-Frame-Options: DENY`（仅对 `/` 页面）。若预检失败，插件降级为"打开浏览器"。 |
| F-02 | 批准用单条条件更新：`UPDATE proposals SET status='APPROVED', ... WHERE id=? AND status='PENDING_APPROVAL'`，受影响行数为 0 则返回 `INVALID_STATE`；只有拿到该更新的请求才能进入 EXECUTING。 |
| F-03 | 定义锁定语义：`lock` 先标记 `locking`，中止该会话的 in-flight 查询（AbortController + driver cancel），等待 worker 退出，再擦 DEK、关池；执行中的提案置 `FAILED (LOCKED)`；结果不写。会话超时同样处理。 |
| F-04 | 按驱动定义：mssql 每条查询独立连接（不共享池），`request.cancel()` 后丢弃连接；pg 用 `pg-cursor` 读 n+1 行后 `close()`；mysql 用 `connection.pause()`/`destroy()`；sqlite 一次读 n+1 后关闭语句。统一返回 `{rows, truncated}`。 |
| F-05 | 审计降级为"哈希链 + 可验证"，明确**不防有写权限者**；新增 `GET /v1/admin/audit/verify`；导出 JSONL。 |
| F-06 | 数据目录写 `endpoint.json`（`{url, pid, version, startedAt}`，无秘密）；所有客户端优先读它，其次环境变量，最后默认 43119。 |
| F-07 | 补齐 Electron 安全清单（见 §8.2 修改后）；`utilityProcess` 启动失败时窗口显示诊断，不静默。 |
| F-08 | 自启默认"托盘常驻 + 不弹窗"；用户点击托盘/快捷方式才显示窗口（LOCKED）。headless：提供 `core setup --password-stdin` 与 `core unlock` 交互式命令，Docker 首启用 `SAG_SETUP_PASSWORD_FILE` 一次性引导（文件读后删除）。 |
| F-09 | 明确：所有写请求校验 `Origin`（存在时必须同源或在允许清单）与 `Host`（loopback）；Cookie 写请求必须带 CSRF；Bearer 写请求不需要 CSRF；CORS 仅对允许清单回 `Access-Control-Allow-Origin`，不回 `Allow-Credentials`。 |
| F-10 | token 形如 `sag_<32B base64url>`；存 `sha256(token)`；创建时只显示一次；`DELETE` 立即失效；`last_used_at` 每 5 分钟更新一次（避免写放大）。说明 DSH/MCP 配置中的 token 可被同账户读取，但只有提交/读权限。 |
| F-11 | 补负例语料（≥40 条），策略版本 `sag-policy-1`；`OPTION`/`FOR XML|JSON` 默认拒绝；`PIVOT` 允许但需测试；注释/字符串先剥离再判定；解析失败一律拒绝。 |
| F-12 | `row_json` 存 TEXT（JSON.stringify）；单行 > 64KB 截断并标记；总大小 8MB 上限；分页默认 100、最大 500；结果接口不压缩（本机）。 |
| F-13 | 数据目录创建时设 0700（Unix）/仅当前用户 ACL（Windows）；迁移前复制 `control.db.bak-<version>`；启动迁移失败则拒绝启动并提示回滚。 |
| F-14 | 发布前查 npm scope/名称；暂用 `@sql-approval/*`，License Apache-2.0；冲突则改 `@sag/*`。 |
| F-15 | 测试补：并发批准、锁定中止、会话超时、迁移失败、端口占用、CORS 预检、CSRF、token 失效。 |

---

## 4. 审查结论

- **不通过**。F-01/F-02/F-03 是架构级缺口，必须先写入设计再开发。
- 其余问题可在 v1.1 一并修正。
- 下一轮：按上表修改 DESIGN 至 v1.1，再逐项复核。

---

# 第 2 轮审查（v1.1 → v1.2）

> 对象：`DESIGN.md` v1.1 ｜ 方式：逐项复核 F-01…F-15，并对修订引入的新表述做一致性检查
> 结论：**有条件通过**。F-01…F-15 均已落实；新发现 5 个中等问题（G-01…G-05）与 4 个低优先级问题，需在 v1.2 修正后放行。

## 1. F-01…F-15 复核

| ID | 结论 | 证据（v1.1） |
|---|---|---|
| F-01 | ✅ 已修 | §4.3 双通道 + CORS 清单 + frame-ancestors；§8.3 降级路径 |
| F-02 | ✅ 已修 | §7.2 条件 UPDATE；§11.1 验收 6 |
| F-03 | ✅ 已修 | §4.3 锁定四步 + 中止执行 |
| F-04 | ✅ 已修 | §7.2 按驱动表 |
| F-05 | ✅ 已修 | §5 哈希链 + `audit/verify` + 明确"不防写权限者" |
| F-06 | ✅ 已修 | §3.2 endpoint.json + 解析顺序 |
| F-07 | ✅ 已修 | §8.2 安全清单 |
| F-08 | ✅ 已修 | §9 托盘自启 + headless setup |
| F-09 | ✅ 已修 | §6.1 安全矩阵 |
| F-10 | ✅ 已修 | §6.2 token 规则 |
| F-11 | ✅ 已修 | §7.1 补 `OPTION/FOR XML/JSON`、剥离注释、fail-closed |
| F-12 | ✅ 已修 | §7.2 结果上限/分页/row_json |
| F-13 | ✅ 已修 | §9 目录权限 + 迁移备份 |
| F-14 | ⚠️ 待办 | §10 只写"发布前核实"，尚未定案（不阻塞开发） |
| F-15 | ✅ 已修 | §11 增补并发/锁定/迁移/端口/预检用例 |

## 2. 新发现

| ID | 级别 | 位置 | 问题 | 要求 |
|---|---|---|---|---|
| G-01 | 中 | §4.3 | iframe 加载的是 core 自己的 origin（`http://127.0.0.1:43119`），**iframe 内的 fetch 是同源请求，根本不需要 CORS**；把 CORS 写成 iframe 的前提，会让实现者误加跨源逻辑。CORS 只在"DSH 插件直接 fetch core（不走 iframe）"时才需要。另外 `frame-ancestors` 里的自定义 scheme `dsh-app:` 需要实测，非法源可能导致整条 CSP 行为不确定。 | 明确：iframe 同源 + Bearer（绕开第三方 Cookie）；CORS 仅用于直连降级路径；CSP 增加回退写法并列入 POC。 |
| G-02 | 中 | §6.3 | 登录响应无条件返回 `token`，同源 Web 也会拿到；一旦页面有 XSS，token 比 HttpOnly Cookie 更容易被带走。 | 仅当请求带 `X-SAG-Want-Token: 1`（iframe/直连客户端）时返回 token；同源 Web 只用 Cookie + CSRF。 |
| G-03 | 中 | §5/§7.2 | 未定义崩溃恢复：进程在 `APPROVED/EXECUTING` 时被杀，提案会永久卡住；重启后是否重试不明确。 | 启动时把 `EXECUTING` → `FAILED(interrupted)`，不重试；`APPROVED` 回退 `PENDING`。 |
| G-04 | 中 | §6.3 | "改密码"只在 §4.2 文字里，没有 API；也没有"需要当前密码/是否使其他会话失效"的规则。 | 增 `POST /v1/admin/password {current,new}`；要求 UNLOCKED；改后其他会话失效、当前会话保留。 |
| G-05 | 中 | §4.1/§5 | 提案没有过期语义：`expires_at` 只用于结果，待审批提案可以无限期挂着。 | 明确 `expires_at` 同时是审批窗口；到期 → `EXPIRED` 终态；批准/取消返回 `INVALID_STATE`。 |
| G-06 | 低 | §6.1 | 登录锁定 5 分钟可被 Agent 故意触发，形成 DoS（把你锁在门外）。 | 改为指数退避（10 次失败后 30s，逐次翻倍，上限 5 分钟），并记录审计。 |
| G-07 | 低 | §9 | Docker 里 core 绑定 127.0.0.1 时端口映射不可达。 | 明确容器内 `SAG_HOST=0.0.0.0`，宿主发布 `127.0.0.1:43119:43119`；Host 校验仍只认 loopback。 |
| G-08 | 低 | §3.2 | `endpoint.json` 可能是崩溃残留的旧数据。 | 客户端读取后必须 `GET /v1/health` 校验 `pid/version`，失败则忽略并回退默认端口。 |
| G-09 | 低 | §2 | 未声明"静态数据边界"：vault 加密，但提案 SQL、结果行、审计是明文（受目录 ACL 保护）。Agent 能读文件，就能直接读这些数据。 | 在 §2 增加"静态数据边界"说明；明确受保护的是连接信息，不是查询结果；如要加密结果列为 v0.3 可选。 |

## 3. 结论

- 修完 G-01…G-05（中）即可放行；G-06…G-09 一并写入 v1.2。
- 下一轮只做"是否引入新矛盾"的快速复核。

---

# 第 3 轮审查（v1.2 → v1.3，终审）

> 对象：`DESIGN.md` v1.2 ｜ 方式：只做"修订是否引入新矛盾"的快速复核
> 结论：**通过**。G-01…G-09 已落实；复核中发现 3 处表述矛盾（G-10…G-12），已在 v1.3 修正。

## 1. G-01…G-09 复核

| ID | 结论 | 证据 |
|---|---|---|
| G-01 | ✅ | §4.3 明确 iframe 同源 fetch 不走 CORS；CORS 只用于直连；CSP 给出回退值 |
| G-02 | ✅ | §6.3 `X-SAG-Want-Token` 条件返回；同源 Web 只有 Cookie |
| G-03 | ✅ | §5 崩溃恢复；§7.2 中断恢复 |
| G-04 | ✅ | §6.3 新增 `POST /admin/password` |
| G-05 | ✅ | §4.1 + §5 `EXPIRED` 终态 |
| G-06 | ✅ | §6.1 指数退避 |
| G-07 | ✅ | §9 Docker 绑定说明 |
| G-08 | ✅ | §3.2 + §8.2 health 校验 |
| G-09 | ✅ | §2.1 静态数据边界 |

## 2. 新增修正

| ID | 问题 | 修正 |
|---|---|---|
| G-10 | §4.1 写"LOCKED 可读历史结果"，但 admin API 需要会话，管理员实际读不到——表述矛盾 | 改为"Agent 可读其历史结果；管理员页面需解锁" |
| G-11 | 提案 `expires_at`（审批窗口）与结果 TTL 混用，23:59 批准的提案 1 分钟后结果就过期 | 明确结果 TTL 从执行完成起算，与审批窗口分开 |
| G-12 | 验收清单缺崩溃恢复/到期/改密码三项 | §11.1 补 10–12 条 |

## 3. 终审结论

- 设计**已可开工**：接口、状态、竞态、失败路径、四客户端、测试矩阵均有确定答案。
- 开工前需完成 3 个 POC（不影响主体开发）：
  1. CSP `frame-ancestors` 对自定义 scheme `dsh-app:` 的接受度与回退；
  2. DSH iframe 内登录 + Bearer 会话（含第三方 Cookie 限制）；
  3. mssql 流式取消后的连接处置。
- 非阻塞待办：npm scope/项目名核实（F-14）、`node-sql-parser` T-SQL 语料（≥40 条负例）。
- **v1.3 为本轮设计基线，可据此进入实现。**
