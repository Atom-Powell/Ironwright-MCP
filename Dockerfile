# The deployable image: the compiled server and its production dependencies, nothing else.
# Built by `npm run build:prod`, which leaves out src/setup: the grant issuing command acts
# through an application holding Sites.FullControl.All and has no place in a running server.
# Profiles are deployment configuration and are mounted at run time, never baked in.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The node image's own unprivileged user. The server writes nothing to its filesystem.
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
