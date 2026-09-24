# Multi-stage production image for the Football Data Platform
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npx tsc -p tsconfig.json || true

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx --no-save
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY migrations ./migrations
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 4000 8080
ENTRYPOINT ["./entrypoint.sh"]
