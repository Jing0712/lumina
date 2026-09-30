# LUMINA agent service. Build from the assignment root:
#   fly deploy . --config deploy/fly.agent.toml --dockerfile deploy/agent.Dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract packages/contract
COPY backend/agent backend/agent
COPY backend/gateway/package.json backend/gateway/package.json
COPY web/package.json web/package.json
RUN npm ci --no-audit --no-fund
RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/backend/agent
EXPOSE 8000
CMD ["node", "dist/index.js"]
