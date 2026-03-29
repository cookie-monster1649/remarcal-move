FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client rsync

COPY package*.json ./
RUN npm ci --omit=dev
RUN npm install -g tsx

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Create data directory
RUN mkdir -p /data/docs /data/logs && chown -R node:node /data

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV SSH_KEYGEN_PATH=/usr/bin/ssh-keygen

EXPOSE 3000

CMD ["tsx", "server.ts"]
