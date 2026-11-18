# 部署与运维

本目录提供 Windows 下的后台服务、开机自启、桌面快捷方式与 Docker 辅助文件。

> 所有脚本都以 **仓库根目录** 为基准（默认 `-RepoPath` 是脚本上两级），可整体拷贝仓库后直接运行。
> 运行前先完成构建：`npm run build` + `npm run build:web`。

## Windows：后台服务 + 开机自启

```powershell
# 安装自启（登录时以隐藏窗口启动 core）
npm run autostart:install

# 查看状态（进程、端口、健康检查）
npm run autostart:status

# 卸载自启
npm run autostart:uninstall
```

默认：

- 数据目录 `%LOCALAPPDATA%\SQLApprovalGateway\data`（可用 `-DataDir` 覆盖）；
- 端口 `43119`（可用 `-Port` 覆盖）；
- core 日志写入仓库 `logs\core.log`；
- 自启项指向 `deploy\windows\run-core-hidden.vbs`，无控制台窗口。

```powershell
# 自定义数据目录与端口
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/windows/install-autostart.ps1 `
  -DataDir "D:\sql-gateway-data" -Port 43119
```

## Windows：桌面端与快捷方式

```powershell
# 创建桌面快捷方式（存在打包 exe 时同时创建便携版快捷方式）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/windows/install-shortcut.ps1
```

- `SQL网关.lnk` → `deploy/windows/start-desktop.vbs`（Electron 运行时 + 桌面壳，启动快）；
- `SQL审批网关-便携版.lnk` → 仓库根目录的 `SQL审批网关.exe`（单文件便携版，若已构建）。

手动启动器：

| 文件 | 用途 |
|---|---|
| `deploy/windows/start-desktop.vbs` | 启动 Electron 桌面端（设置 `SAG_DATA_DIR`、清理 `ELECTRON_RUN_AS_NODE`） |
| `deploy/windows/start-gateway.vbs` | 启动 core 并打开浏览器审批台（无桌面端时的回退方式） |
| `deploy/windows/run-core-hidden.vbs` | 隐藏窗口启动 core（自启项使用） |

## Docker（可选）

```bash
npm run docker:build
docker compose up -d
```

- 镜像只把 `127.0.0.1:43119` 发布到宿主；
- 容器内以 `SAG_ALLOW_NON_LOOPBACK_BIND=1` 允许绑定容器网卡，Host/Origin 仍只认回环；
- 首次设置可用一次性密码文件（`deploy/compose.setup.yml`）：

```bash
docker compose -f docker-compose.yml -f deploy/compose.setup.yml up -d
```

把首次密码写入卷内 `setup-password.txt`，设置完成后删除该文件。

## 数据与备份

| 文件 | 内容 | 是否加密 |
|---|---|---|
| `data/vault.json` | 数据源连接信息（host/port/db/user/password） | ✅ scrypt + AES-256-GCM |
| `data/control.db` | 提案、结果、审计链、设置、Agent 客户端 | ❌ 明文（受 OS ACL 保护） |
| `data/endpoint.json` | 运行中实例的 pid/端口/版本（桌面端发现用） | — |

备份：**先停服务**，整体复制 `data/` 即可。

## 升级

1. 停止 core / 退出桌面端；
2. 替换程序文件（保留 `data/`）；
3. 重新启动。控制库声明了 schema 版本，启动时自动迁移并生成 `control.db.bak-<version>`。

## 安全边界

- 只监听回环，不要改 `SAG_HOST` 或端口映射到 `0.0.0.0`；
- `data/` 使用操作系统 ACL 限制为运行账号；
- 数据库使用独立只读账号；
- 审计日志（`data/control.db` 中的哈希链）定期导出归档到独立系统。
