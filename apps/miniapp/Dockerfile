# Собирается из корня монорепозитория: docker build -f apps/miniapp/Dockerfile .
#
# NEXT_PUBLIC_* переменные запекаются в клиентский бандл на этапе сборки —
# см. комментарий в apps/web/Dockerfile, здесь тот же паттерн.

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
RUN npm run build --workspace=apps/miniapp

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# output: 'standalone' (next.config.ts) сам трассирует минимально нужные
# node_modules.
COPY --from=build /repo/apps/miniapp/.next/standalone ./
COPY --from=build /repo/apps/miniapp/.next/static ./apps/miniapp/.next/static
COPY --from=build /repo/apps/miniapp/public ./apps/miniapp/public

EXPOSE 3000
CMD ["node", "apps/miniapp/server.js"]
