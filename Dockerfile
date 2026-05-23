FROM node:20-bookworm-slim

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=4173
ENV TRAVEL_DATA_DIR=/data/travel

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV NODE_ENV=production

RUN mkdir -p /data/travel && chown -R node:node /data/travel

USER node

EXPOSE 4173

CMD ["npm", "run", "start"]
