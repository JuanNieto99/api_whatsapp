FROM node:18-bullseye

RUN apt-get update && \
    apt-get install -y chromium --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --production || npm ci --production

COPY . .

# Copiar entrypoint que limpia locks antes de arrancar
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80
ENTRYPOINT ["./docker-entrypoint.sh"]
