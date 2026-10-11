# syntax=docker/dockerfile:1
FROM node:25-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:25-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 gmemo
WORKDIR /app
ENV NODE_ENV=production \
    GMEMO_DATA_DIR=/data \
    GMEMO_WEB_DIR=/app/packages/web/dist \
    GMEMO_PORT=8787
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown gmemo:gmemo /data \
  && printf '#!/bin/sh\nexec node /app/packages/server/dist/cli.js "$@"\n' > /usr/local/bin/gmemo && chmod +x /usr/local/bin/gmemo
USER gmemo
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.GMEMO_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "gmemo"]
CMD ["serve"]
