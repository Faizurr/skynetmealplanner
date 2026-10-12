# Single container: API + background worker + owner PWA (static).
# Build:  docker build -t attendance .
# Run:    docker run --env-file .env -p 8080:8080 attendance
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIST_DIR=/app/web
WORKDIR /app/server
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY server/package.json ./
COPY server/migrations ./migrations
COPY --from=web /web/dist /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server.js"]
