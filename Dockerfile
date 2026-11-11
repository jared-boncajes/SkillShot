# AIMSTRIKE - single image that runs the authoritative game server and serves the built web client.
# Build:  docker build -t aimstrike .
# Run:    docker run -p 2567:2567 aimstrike      -> open http://localhost:2567
#
# To host the frontend elsewhere (static host/CDN), build the client with
#   --build-arg VITE_SERVER_URL=https://your-game-server.example.com
# and deploy client/dist separately; this image still works as the backend.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=2567 \
    CLIENT_DIST=/app/client/dist
# The server bundle is self-contained (dependencies are bundled), so no node_modules are needed at runtime.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
EXPOSE 2567
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "server/dist/index.js"]
