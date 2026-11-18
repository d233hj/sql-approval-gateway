#
# SQL Approval Gateway — production image (DESIGN §9/§10, P4-b).
#
# Build:  docker build -t sql-approval-gateway:0.1.0 .
# Run:    docker compose up -d --build   (see deploy/README.md)
#
# The runtime image contains only built JavaScript, production dependencies and
# the Web SPA. It never contains source, tests, the vault, or the control DB.
# `node:sqlite` is built into Node 24, so no native compiler is required.

# ---------------------------------------------------------------------------
# Build stage: compile shared + core + the Web SPA, then drop dev dependencies.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Keep npm quiet/predictable and skip lifecycle scripts: none of the runtime
# dependencies need a native build, and this also skips Electron's binary
# download (the desktop workspace is present only so `npm ci` can link it).
ENV npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# Copy only manifests first so dependency installation is cached independently
# of source changes. Every workspace in package-lock.json needs its manifest.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/dsh-plugin/package.json ./packages/dsh-plugin/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json

RUN npm ci --ignore-scripts

# Build inputs (dist/ and node_modules/ are excluded by .dockerignore).
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/web ./packages/web

# `npm run build` = shared + core; the Web SPA is a separate workspace build.
RUN npm run build \
 && npm run build --workspace=@sql-approval/web \
 && npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime stage: non-root, read-only root filesystem except /data and /tmp.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Container-internal bind. SAG_ALLOW_NON_LOOPBACK_BIND=1 permits only the
# wildcard address; the host MUST still publish 127.0.0.1:43119 only
# (docker-compose.yml), and Host/Origin validation stays loopback-only.
ENV NODE_ENV=production \
    SAG_HOST=0.0.0.0 \
    SAG_ALLOW_NON_LOOPBACK_BIND=1 \
    SAG_PORT=43119 \
    SAG_WEB_DIST=/app/packages/web/dist

WORKDIR /app

# Dedicated unprivileged account; /data is the only persistent writable path.
RUN groupadd --gid 10001 sag \
 && useradd --uid 10001 --gid sag --create-home --shell /usr/sbin/nologin sag \
 && install -d -o sag -g sag -m 0700 /data

# Production dependencies plus the workspace links they resolve through.
COPY --from=build --chown=sag:sag /app/package.json ./package.json
COPY --from=build --chown=sag:sag /app/node_modules ./node_modules
COPY --from=build --chown=sag:sag /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=sag:sag /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=sag:sag /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=sag:sag /app/packages/core/dist/src ./packages/core/dist/src
COPY --from=build --chown=sag:sag /app/packages/web/dist ./packages/web/dist

# Vault (vault.json) and SQLite control.db live here; back up both (deploy/README.md).
VOLUME ["/data"]

USER sag

EXPOSE 43119

# Node 24 ships fetch; this avoids adding curl/wget to the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43119/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

STOPSIGNAL SIGTERM

ENTRYPOINT ["node","packages/core/dist/src/cli.js","--data-dir","/data"]
