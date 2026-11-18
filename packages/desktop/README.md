# @sql-approval/desktop — Windows 桌面壳（Electron）

P4-a：Electron 壳加载 **core 托管的 SPA**（`http://127.0.0.1:43119`）。core 可以由壳启动，也可以复用已在运行的实例。实现依据 `docs/design/DESIGN.md` §8.2 / §9（G-08、F-07/F-08）。默认窗口 1280×720（最小 900×600），应用图标 `assets/app.ico`。

```
packages/desktop/
├─ main.js            # 主进程：单实例、core 生命周期、窗口/托盘/自启
├─ lib.js             # 纯函数（URL 校验、健康检查、endpoint 发现、停机状态机、托盘锁定钩子），供测试复用
├─ preload.js         # 空 preload：module.exports = {}
├─ assets/tray.png    # 托盘图标（32×32）
├─ test-helpers.mjs   # node --test，仅纯函数，不启动 GUI
└─ package.json
```

## 前置

- Node.js ≥ 24（仓库 `engines`）。
- Electron 45（Node 24.x 运行时）。**不要降到 Electron 33**：core 使用 `node:sqlite`，
  而 Electron 33 内置的 Node 20.18 没有该模块，`utilityProcess.fork(core)` 会启动失败。
- 已构建 core 与 Web SPA：

  ```powershell
  npm install
  npm run build -w @sql-approval/shared
  npm run build -w @sql-approval/core
  npm run build -w @sql-approval/web
  ```

  壳使用的 core 入口固定为 `packages/core/dist/src/cli.js`。core 默认从仓库
  `packages/web/dist` 提供 SPA；也可用 `SAG_WEB_DIST` 指向其它构建输出。

## 开发运行

```powershell
npm install -w @sql-approval/desktop
npm run start -w @sql-approval/desktop
```

等价于在 `packages/desktop` 下执行 `electron .`。

> 若从已内嵌 Electron 的宿主（如 DSH 桌面端）终端启动，环境里可能带着
> `ELECTRON_RUN_AS_NODE=1`，此时 `electron .` 会以纯 Node 模式运行并在
> `app.setName` 处报错。先清除该变量再启动：
>
> ```powershell
> $env:ELECTRON_RUN_AS_NODE = $null
> npm run start -w @sql-approval/desktop
> ```

| 环境变量 | 说明 |
|---|---|
| `SAG_URL` | 覆盖目标地址，默认 `http://127.0.0.1:43119`。只接受 `http://` + loopback（`127.0.0.1` / `localhost` / `::1`）+ 显式端口，且必须是 origin（不能带 path/query/hash）。 |
| `SAG_DATA_DIR` | 覆盖数据目录（默认 `<userData>/data`）。部署启动器把它指向 `<repo>\data`，让桌面端与后台服务 core 共用同一个 vault/控制库，避免两边各自 spawn core 时看到两套数据。 |
| `SAG_WEB_DIST` | core 的 SPA 静态目录（沿用 core 配置）。 |
| `--hidden` | 启动后只驻留托盘、不弹窗（开机自启项使用此参数）。 |

启动顺序：

1. 优先读 `<dataDir>/endpoint.json`（core 用同一个 `--data-dir` 写入；`dataDir` = `SAG_DATA_DIR` 或 `<userData>/data`）：解析 `{url,pid,version}` 并 `GET <url>/v1/health`（2s 超时），pid/version 必须与 endpoint.json 一致；通过则直接复用该实例。
2. endpoint.json 缺失、损坏、对应实例不健康或 pid/version 不一致时，回落到 `SAG_URL`（默认 `http://127.0.0.1:43119`）并 `GET /v1/health`（2s 超时）。
3. 仍不通则 `utilityProcess.fork(packages/core/dist/src/cli.js, ['--data-dir', <dataDir>, '--port', <目标端口>])`，并轮询健康检查最多 15s。
4. 健康后校验 `<dataDir>/endpoint.json` 的 pid/version（以及 url 端口）与 `/v1/health` 一致（G-08）；不一致拒绝连接。`endpoint.json` 缺失（例如 core 用其它 data-dir 启动）只记警告并复用。
5. 失败时弹错误框，包含目标端口、数据目录、core 入口与日志路径，不静默失败。

运行时文件（均在 Electron `userData` 下，Windows 通常为
`%APPDATA%\SQL Approval Gateway`）：

- 数据目录：`<userData>/data`（传给 core 的 `--data-dir`），可用 `SAG_DATA_DIR` 覆盖。
- 日志：`<userData>/logs/desktop.log`，JSON Lines；超过 2 MB 轮转为 `.1`。
  包含 core 的 stdout/stderr（`core_output`），不含 SQL、参数或凭据。
- 偏好：`<userData>/desktop-settings.json`（仅 `minimizeToTray`）。

## 部署运行（当前采用的免安装方式）

不打包 NSIS，直接把 Electron 运行时与 app 目录放到部署目录，用 VBS 启动：

```
<repo>\
├─ electron\                 # 从 node_modules\electron\dist 复制（electron.exe + 资源）
├─ packages\desktop\         # 本目录（main.js/lib.js/preload/assets）
├─ packages\core\dist\...    # core 构建产物
├─ packages\web\dist\...     # SPA 构建产物
├─ data\                     # vault.json / control.db（SAG_DATA_DIR 指向这里）
├─ runtime\agent-token.txt   # 部署用 agent token（启动器读取后注入 SAG_AGENT_TOKEN）
└─ deploy\windows\start-desktop.vbs
```

`start-desktop.vbs` 做三件事后启动 `electron.exe packages\desktop`：

1. `SAG_DATA_DIR=<repo>\data`，桌面端与后台 core 共用数据目录；
2. 从 `runtime\agent-token.txt` 读取 `sag_…` 写入 `SAG_AGENT_TOKEN`（文件不存在则跳过）；
3. 删除 `ELECTRON_RUN_AS_NODE`（父进程若是 Electron 宿主会带该变量；**空值也算设置**，必须 `Remove`，否则 electron.exe 以纯 Node 运行并报 `Cannot find module 'electron'`）。

桌面快捷方式指向 `wscript.exe "…\deploy\windows\start-desktop.vbs"`，图标为 `packages\desktop\assets\app.ico`。core 已由后台服务启动时，桌面端通过 `endpoint.json` 复用；core 未运行时会自己 `utilityProcess.fork` 同一个数据目录的 core。

## 打包（便携版 exe）

`electron-builder` 配置在 `packages/desktop/electron-builder.yml`（`win.target: portable`），产物是单文件
`SQL审批网关-<version>-portable.exe`。

前置（配置头注释同样写明）：

1. `packages/{core,web,shared}/dist` 已构建。
2. 运行时依赖预置在仓库 `.work/portable-runtime/node_modules`：`mssql`、`node-sql-parser`、`zod`
   及全部传递依赖，并把 `@sql-approval/shared`（package.json + dist）放进
   `node_modules/@sql-approval/shared`，否则 core dist 的裸导入会失败。

```powershell
cd packages/desktop
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist:portable
```

产物布局：`resources/app.asar`（本目录）+ `resources/core/dist` + `resources/web/dist`
（运行 core 时注入 `SAG_WEB_DIST`）+ `resources/node_modules`。便携模式数据目录默认是
`<exe 所在目录>\data`（`PORTABLE_EXECUTABLE_DIR`），因此把 exe 放在 `sql-gateway\` 根目录即复用
现有 `data\`；`SAG_DATA_DIR` 仍然优先。

> 注意：便携 exe 每次启动都会把约 400 MB 运行时解压到 `%TEMP%`，本机实测冷启动约 90 秒
> （受杀软实时扫描影响）。日常使用建议桌面快捷方式指向部署里的 `electron\electron.exe` 运行时
> （同一份 app，秒开）；单文件 exe 用于拷贝到其他机器。首次运行未签名 exe 会有 SmartScreen
> 提示，需"更多信息 → 仍要运行"。

## 托盘行为

- **打开审批台**：显示/聚焦窗口。
- **锁定**：壳不直接调用 `POST /v1/admin/lock`（SPA 的 session 与 CSRF token 只在渲染进程内存里，cookie-only 请求会被 core 以 403 拒绝）。改为通过渲染进程 `sag:lock` 钩子锁定：`webContents.executeJavaScript("window.dispatchEvent(new Event('sag:lock'))", true)`（3s 超时），由 SPA 用自身 CSRF 完成锁定；1s 后主进程回读 `GET /v1/admin/state`，校验 `unlocked=false` 才算成功。无窗口、超时或校验失败都会记日志并用托盘气泡/通知提示“请先打开审批台解锁后再锁定”，不再静默忽略。
- **开机自启**：`app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })` 切换；默认关闭（不主动写入登录项）。开发模式下使用 `electron.exe <appPath> --hidden`，打包后才可靠。
- **关闭窗口时最小化到托盘**：默认开启，可在托盘菜单切换并持久化。
- **退出**：仅当 core 由本壳启动时执行 `kill()`（SIGTERM，优雅停机）→ 等 5s → 仍存活则 `SIGKILL`（Windows 上等价 `TerminateProcess`）→ 再等 2s；仍失败写 `core_stop_failed` 日志并弹一次错误框。`before-quit` 会等待停机序列完成，避免 core 残留；复用外部 core 时不动它。

## 渲染进程安全清单（DESIGN §8.2）

| 要求 | 实现 |
|---|---|
| 单实例 | `app.requestSingleInstanceLock()`；`second-instance` 聚焦已有窗口 |
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `nodeIntegration` | `false`（`nodeIntegrationInWorker` 亦为 `false`） |
| `webviewTag` | `false`；另在 `will-attach-webview` 阻止 |
| preload | 空文件 `module.exports = {}` |
| `webSecurity` | `true`（显式，绝不关闭） |
| `will-navigate` | 仅允许 `SAG_URL` 的精确 origin；`will-redirect` 同样校验 |
| `setWindowOpenHandler` | 一律 `{ action: 'deny' }`，不调用 `shell.openExternal` |
| 权限请求 | `setPermissionRequestHandler` 与 `setPermissionCheckHandler` 一律拒绝 |
| 其它 | 关闭 `allowRunningInsecureContent` / `experimentalFeatures`；不加载远程内容 |

## 测试

```powershell
npm test -w @sql-approval/desktop
# 或
node --test --test-isolation=none packages/desktop/test-helpers.mjs
```

覆盖：默认/覆盖 URL 的 loopback 校验、导航 origin 白名单、`--data-dir/--port` 组装、健康检查 2s 超时（含 fetch 永不返回）、15s 轮询预算、设置与登录项参数、`endpoint.json` 解析与 pid/version 校验及四种回落路径、托盘 `sag:lock` 的 `executeJavaScript` 调用参数/1s 回读/3s 超时、停机 `kill→5s→SIGKILL→2s` 状态机（假 child，可注入 kill 与定时器）。测试不启动 Electron/GUI。

> 使用 `--test-isolation=none` 是因为部分受限环境禁止 `node --test` 默认的
> 子进程管道（`spawn EPERM`）；该参数仍由 Node 内置 test runner 执行。

## 打包（后续）

electron-builder（NSIS）配置留作 P4-b 后续项，当前**没有**打包脚本。后续需要注意：

- `files` 需包含 `main.js`、`lib.js`、`preload.js`、`assets/`，并将已构建的 core 与 `packages/web/dist` 放入 `extraResources`（或一并打进 asar），同时把 `CORE_ENTRY_RELATIVE` 改为打包后的 core 入口。
- 安装包需固定应用名/AppUserModelId（`com.sqlapproval.gateway`）、图标与 NSIS 安装范围（当前用户）。
- 未配置代码签名，SmartScreen 会提示。

## 已知限制

- **GUI 已在本机交互式桌面验证**（窗口、无菜单栏、任务栏图标、复用/自启 core），但无自动化 UI 断言；换机器/远程会话仍需人工点一遍。
- **受限 CI 中的安装/测试**：如果 npm 的生命周期脚本被沙箱阻断（`spawn EPERM`），可先 `npm install --ignore-scripts -w @sql-approval/desktop`，再执行 `node node_modules/electron/install.js` 下载二进制；测试使用 `--test-isolation=none` 避免 Node test runner 的子进程管道限制。
- **开发模式开机自启不可靠**：注册的是 `electron.exe` 加应用路径；必须用打包后的 exe 验证。
- **单实例锁按 Electron 用户数据目录生效**：以不同 `userData` 启动可绕过。
- 壳不内置 core 构建产物；缺少 `packages/core/dist/src/cli.js` 时会在错误框中提示先构建。
- 未做自动更新、崩溃上报、英文界面与深色/浅色托盘图标适配。
