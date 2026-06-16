# syntax=docker/dockerfile:1.6

# ─── Stage 1: build Baileys library ───────────────────────────────────────────
FROM node:20-bookworm-slim AS lib

WORKDIR /lib
COPY package.json yarn.lock* package-lock.json* engine-requirements.js ./
COPY tsconfig*.json ./
COPY proto-extract ./proto-extract
COPY WAProto ./WAProto
COPY src ./src

# Instalar deps (incluyendo dev) y compilar a lib/ vía prepare → npm run build.
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --legacy-peer-deps --include=dev

# ─── Stage 2: build server ────────────────────────────────────────────────────
# Layout: /app es la lib raíz (con lib/ compilada), /app/server es el wrapper.
# El server tiene "baileys": "file:..", que resuelve a /app correctamente.
FROM node:20-bookworm-slim AS server-build

WORKDIR /app
# Lib compilada a la raíz /app
COPY --from=lib /lib /app
# Server queda como sub-paquete dentro
COPY server /app/server

WORKDIR /app/server
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --legacy-peer-deps --omit=dev

# ─── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001
ENV SESSIONS_PATH=/app/sessions

WORKDIR /app
COPY --from=server-build /app /app

WORKDIR /app/server

RUN mkdir -p /app/sessions
VOLUME /app/sessions

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
