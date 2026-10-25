FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY shared ./shared
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=5555
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY cli.js ./
COPY --from=build /app/public ./public
RUN printf '#!/bin/sh\nexec node /app/cli.js "$@"\n' > /usr/local/bin/margin-user && chmod +x /usr/local/bin/margin-user
EXPOSE 5555
CMD ["node", "server/server.js"]
