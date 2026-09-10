# Собирается из корня монорепозитория: docker build -f apps/api/Dockerfile .
# (не из apps/api — нужен доступ к корневому package-lock.json для npm workspaces).
#
# Копируем весь репозиторий целиком перед npm ci, а не только package.json
# отдельных workspace'ов — частичное копирование ради кэша слоёв ненадёжно
# с npm workspaces (npm ci валидирует package-lock.json против фактически
# присутствующих workspace-директорий и может неожиданно упасть).
# .dockerignore вырезает node_modules/dist/.next/.git — сборка всё равно
# инвалидируется только при реальном изменении исходников.

FROM node:22-alpine AS build
WORKDIR /repo

COPY . .
RUN npm ci
RUN npm run prisma:generate --workspace=apps/api
# На маломощных хостах (напр. ~2GB RAM) V8 сам занижает лимит хипа исходя
# из физической памяти (~1GB здесь) и tsc внутри `nest build` в это не
# помещается — падает "JavaScript heap out of memory" ещё до того, как
# доходит до подкачки (своп не помогает: это собственный лимит V8, а не
# нехватка памяти как таковая). Поднимаем лимит явно — на build-стадии он
# не идёт в рантайм-образ, поэтому не расходует память у самого приложения.
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build --workspace=apps/api

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Полное node_modules, а не обрезанное — nest build не трассирует рантайм-
# зависимости сам (в отличие от next standalone у apps/web), а для монорепо
# с npm workspaces ручной prune node_modules ненадёжен и не стоит экономии.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json

EXPOSE 3001
# prisma migrate deploy — безопасно применяет только неприменённые миграции,
# без интерактивных вопросов о потере данных (в отличие от `migrate dev`,
# см. README про quirk этой команды в деве). Вызывается через прямой путь к
# CLI-бандлу, а не .bin-симлинк — надёжнее внутри контейнера.
CMD ["sh", "-c", "node apps/api/node_modules/prisma/build/index.js migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/src/main.js"]
