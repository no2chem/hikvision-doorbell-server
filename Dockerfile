FROM node:lts-bullseye-slim

COPY . /app
WORKDIR /app
RUN npm install

ENTRYPOINT [ "/app/server.ts", "/config.toml" ]