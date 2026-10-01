FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl unzip chromium zip \
    && rm -rf /var/lib/apt/lists/*

# Use pip-installed yt-dlp so its current Python plugin system is available.
RUN python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp yt-dlp-getpot-wpc

# Deno is used by yt-dlp for YouTube JavaScript challenges.
RUN curl -L https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
      -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod a+rx /usr/local/bin/deno \
    && rm /tmp/deno.zip

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN useradd --create-home --shell /bin/bash appuser && chown -R appuser:appuser /app
USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV YTDLP_CHROME_PATH=/usr/bin/chromium
EXPOSE 3000

CMD ["npm", "start"]
