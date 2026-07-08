# cool-game — single authoritative Node server
FROM node:22-alpine

WORKDIR /app

# Install only production deps (ws) using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Fly's proxy defaults to internal port 8080 — listen there in the container.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
