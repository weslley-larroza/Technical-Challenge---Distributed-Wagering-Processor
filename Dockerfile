# Bun runs TypeScript directly: no build step, the image ships the sources.
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# SIGTERM triggers the ordered graceful shutdown in src/main.ts
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/main.ts"]
