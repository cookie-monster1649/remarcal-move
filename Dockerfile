FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client rsync su-exec

COPY package*.json ./
RUN npm ci --omit=dev
RUN npm install -g tsx

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Create data directory (owned by root; entrypoint will chown at runtime)
RUN mkdir -p /data/docs /data/logs

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV SSH_KEYGEN_PATH=/usr/bin/ssh-keygen

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tsx", "server.ts"]
