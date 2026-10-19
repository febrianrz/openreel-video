FROM node:22-bookworm-slim AS builder

ENV COREPACK_HOME=/tmp/corepack
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/creation-schema/package.json packages/creation-schema/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY . .

ARG VITE_ALTER_BOT_API_URL=
ENV VITE_ALTER_BOT_API_URL=${VITE_ALTER_BOT_API_URL}

RUN pnpm build

FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
