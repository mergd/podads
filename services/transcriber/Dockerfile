FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv curl && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/whisper && \
    /opt/whisper/bin/pip install --no-cache-dir faster-whisper
ENV PATH="/opt/whisper/bin:$PATH"

RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm install tsx

COPY tsconfig.json ./
COPY src/ src/

ENV PORT=8000
ENV WHISPER_MODEL=small.en
ENV SPEED_MULTIPLIER=2

EXPOSE 8000
CMD ["npx", "tsx", "src/index.ts"]
