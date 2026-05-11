FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 8080
ENV PORT=8080

CMD ["bun", "src/server.ts"]
