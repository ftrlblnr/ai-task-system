# Собирается из корня монорепозитория: docker build -f apps/web/Dockerfile .
#
# NEXT_PUBLIC_* переменные запекаются в клиентский бандл на этапе сборки,
# а не читаются в рантайме — поэтому NEXT_PUBLIC_API_URL передаётся как
# build-arg (см. docker-compose.prod.yml), а не через .env контейнера.
#
# Копируем весь репозиторий целиком перед npm ci — см. комментарий в
# apps/api/Dockerfile про ненадёжность частичного копирования с npm workspaces.

FROM node:22-alpine AS build
WORKDIR /repo

COPY . .
RUN npm ci

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
# См. комментарий в apps/api/Dockerfile — V8 занижает лимит хипа на
# маломощных хостах, поднимаем явно для build-стадии.
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build --workspace=apps/web

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# output: 'standalone' (next.config.ts) сам трассирует минимально нужные
# node_modules — в отличие от apps/api, здесь копировать полное дерево не нужно.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
