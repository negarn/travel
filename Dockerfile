FROM node:24-trixie-slim AS os

RUN apt-get -o APT::Update::Error-Mode=any update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

FROM os AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

FROM os

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV TRAVEL_DATA_DIR=/data/travel

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

RUN install -d -o node -g node -m 0700 /data/travel

USER node

EXPOSE 4173

CMD ["node", "dist-server/productionServer.mjs"]
