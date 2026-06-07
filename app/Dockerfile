# =====================================================================
# Boss Engineers ERP — application image
# Multi-stage: build TypeScript -> dist in a full image, then ship a slim
# runtime image with production deps only, running as a non-root user.
# Build context is the app/ directory:  docker build -t be-erp-app app/
# =====================================================================

# ---- Stage 1: build ----
FROM node:20-alpine AS build
WORKDIR /app

# Install ALL deps (incl. dev: typescript) using the lockfile for reproducibility.
COPY package*.json ./
RUN npm ci

# Compile TypeScript to dist/ (src + scripts; migrations are SQL, copied as-is).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

# Strip dev dependencies so they are not copied into the runtime image.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:alpine ships a non-root "node" user (uid 1000); run as it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# migrate.js resolves its SQL via __dirname/../migrations -> dist/migrations.
COPY --from=build --chown=node:node /app/migrations ./dist/migrations
COPY --chown=node:node package.json ./

USER node
EXPOSE 3001

# Run pending migrations (idempotent) on boot, then start the API.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/server.js"]
