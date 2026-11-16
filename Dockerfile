# PayeeGuard web app as a static site (talks to Aevum testnet and QDay's bundler from the browser).
#   docker build -t payeeguard-web . && docker run --rm -p 8080:80 payeeguard-web   ->  http://localhost:8080
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY sdk/package.json sdk/pnpm-lock.yaml sdk/
COPY web/package.json web/pnpm-lock.yaml web/
RUN cd sdk && pnpm install --frozen-lockfile --ignore-workspace && cd ../web && pnpm install --frozen-lockfile --ignore-workspace
COPY sdk sdk
COPY web web
RUN cd web && pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
