# cool-game — single authoritative Node server
FROM node:22-alpine

WORKDIR /app

# Install only production deps (ws) using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
