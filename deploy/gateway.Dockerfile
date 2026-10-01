# LUMINA gateway. Build from the assignment root:
#   fly deploy . --config deploy/fly.gateway.toml --dockerfile deploy/gateway.Dockerfile
# reports/report.json (from /fde-lumina-eval) is copied in, and served at /evals/report.json.
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway && npm run build -w @lumina/web

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/backend/gateway
EXPOSE 8787
CMD ["node", "dist/index.js"]
