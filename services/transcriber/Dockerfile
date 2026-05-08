FROM oven/bun:1.3-debian

RUN for attempt in 1 2 3; do \
      apt-get update -o Acquire::Retries=3 && \
      apt-get install -y --no-install-recommends -o Acquire::Retries=3 ffmpeg && \
      rm -rf /var/lib/apt/lists/* && \
      break; \
      if [ "$attempt" = "3" ]; then exit 1; fi; \
      rm -rf /var/lib/apt/lists/*; \
      sleep 5; \
    done

WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/transcriber/package.json services/transcriber/package.json
# Stub out the other workspace members so bun install doesn't error on missing dirs
RUN mkdir -p ui workers/api workers/processor && \
    echo '{"name":"ui","private":true}' > ui/package.json && \
    echo '{"name":"@podads/api","private":true}' > workers/api/package.json && \
    echo '{"name":"@podads/processor","private":true}' > workers/processor/package.json
RUN bun install --production

COPY packages/shared/ packages/shared/
COPY services/transcriber/tsconfig.json services/transcriber/tsconfig.json
COPY services/transcriber/src/ services/transcriber/src/

WORKDIR /app/services/transcriber

ENV PORT=8000
ENV SPEED_MULTIPLIER=2

EXPOSE 8000
CMD ["bun", "run", "src/index.ts"]
