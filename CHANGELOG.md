# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-18

### Added

- Core gateway (Node 24 + TypeScript): loopback HTTP API, scrypt + AES-256-GCM vault,
  SQLite control store (WAL) with SHA-256 audit hash chain, single-instance lock.
- Read-only enforcement: AST policy for single `SELECT` only (writes, DDL, `SELECT INTO`,
  cross-database, temp tables, metadata probes, dangerous lock hints rejected), strict
  read-only source verification (default on), read-only execution paths.
- Human approval workflow: proposals, approve/reject/cancel, policy-version and digest
  re-check at approval time, expiring approval window, worker-thread execution with
  timeout and cancellation.
- Four clients: Web approval console (dependency-free SPA), Windows Electron desktop shell
  (tray, single instance, autostart, portable exe packaging), DeepSeek Harness plugin with
  six `sql_*` tools and an in-app approval pane, MCP stdio server (zero dependencies).
- Live updates: SSE proposal stream (`GET /v1/events`) and Windows toast notifications for
  new proposals.
- Agent token management: one-time `sag_…` tokens, SHA-256 at rest, revocation, last-used
  tracking; `sql_submit_and_wait` convenience tool that never auto-approves.
- Settings UI: sessions/locking, execution limits, strict read-only toggle, data sources
  (connection test + read-only probe), audit.
- Deployment assets: Windows autostart/shortcut scripts, Dockerfile and compose file.
