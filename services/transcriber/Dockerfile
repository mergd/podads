FROM oven/bun:1.3-debian

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY tsconfig.json ./
COPY src/ src/

ENV PORT=8000
ENV SPEED_MULTIPLIER=2

EXPOSE 8000
CMD ["bun", "run", "src/index.ts"]
