FROM node:26.10.0-alpine3.24

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080
ENV SAVE_INTERVAL_IN_SECONDS=30

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "--experimental-sqlite", "server.js"]
