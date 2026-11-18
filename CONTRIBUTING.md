# 贡献指南

欢迎 Issue 与 Pull Request。这个项目的核心约束是**安全边界不能退化**，因此修改安全相关代码时请附上测试。

## 开发环境

- Node.js ≥ 24
- Windows 10/11 x64（桌面端开发）；服务端在 Linux/macOS 也可运行
- npm workspaces（仓库根目录执行）

```bash
npm install
npm run build        # shared + core
npm run build:web
npm run typecheck
npm test             # core 测试（约 1 分钟）
```

## 分支与提交

- 从 `main` 切分支：`feat/…`、`fix/…`、`docs/…`；
- 提交信息用英文祈使句，一行说清做了什么（示例：`feat(core): reject SELECT INTO`）；
- 一个 PR 只做一件事；安全相关改动请在描述里写清威胁模型与回归测试。

## 安全相关改动的额外要求

以下区域改动必须补测试，并说明"为什么仍然安全"：

- `packages/core/src/policy.ts`（AST 只读策略）—— 新的放行/拦截规则；
- `packages/core/src/vault.ts`（加密与密钥派生）；
- `packages/core/src/http.ts` 的认证/CSRF/审批路径；
- 执行器的只读连接、超时与取消；
- 审计哈希链。

SQL 策略负例请加到 `packages/core/test/policy-*.test.ts` 的对抗语料中。

## 代码风格

- TypeScript strict；ESM（core）与 CommonJS（Electron 主进程）按各自包内约定；
- 不引入运行时依赖，除非确有必要并在 PR 中说明；
- 不把 SQL、参数、token、连接信息写进日志或错误消息。

## 文档

行为变化请同步更新：

- 公开接口：`README.md` 与 `docs/design/DESIGN.md`；
- 各客户端使用方式：对应包的 `README.md`；
- 部署/运维：`deploy/README.md`。
