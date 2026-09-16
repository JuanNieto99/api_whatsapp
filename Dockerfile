# Imagen de nuestra capa Node (fachada + web UI). Ya NO instala Chromium:
# la conexión con WhatsApp la maneja el contenedor WAHA (engine NOWEB).
FROM node:18-bullseye-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --production || npm ci --production

COPY . .

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80
CMD ["node", "server.js"]
