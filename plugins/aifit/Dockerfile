FROM node:22-alpine AS runtime

WORKDIR /app
RUN mkdir /state && chown node:node /state
COPY --chown=node:node bin/aifit.mjs /app/bin/aifit.mjs
USER node
