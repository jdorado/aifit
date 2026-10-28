FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

WORKDIR /app
RUN mkdir /state && chown node:node /state
COPY --chown=node:node bin/aifit.mjs /app/bin/aifit.mjs
USER node
