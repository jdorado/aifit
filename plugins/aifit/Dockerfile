FROM node:22-alpine AS runtime

WORKDIR /app
COPY --chown=node:node bin/aifit.mjs /app/bin/aifit.mjs
USER node
