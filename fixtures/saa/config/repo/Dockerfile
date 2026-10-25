FROM node:22-alpine AS build
ARG NPM_TOKEN
ENV NODE_ENV=production PORT=8080
RUN npm ci --omit=dev
EXPOSE 8080
CMD ["node", "src/server.js"]
