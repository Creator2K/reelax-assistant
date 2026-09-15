# ---- 构建前端 ----
FROM node:22-alpine AS webbuild
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --no-audit --no-fund
COPY web/ web/
RUN npm run build -w web

# ---- 运行镜像 ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false --no-audit --no-fund
COPY server/ server/
COPY --from=webbuild /app/web/dist web/dist
ENV PORT=8580 HOST=0.0.0.0
EXPOSE 8580
VOLUME ["/app/server/data"]
CMD ["node", "server/src/index.js"]
