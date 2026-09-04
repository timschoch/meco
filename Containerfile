# syntax=docker/dockerfile:1
# Deploys meco-faces as a Vercel Functions container image.
# https://vercel.com/docs/functions/container-images
#
# The odd name is forced from two sides. Vercel checks the *basename* of a
# service `entrypoint` and rejects anything that is not a Dockerfile or a
# Containerfile, so `Dockerfile.faces` is out; and it builds with the
# entrypoint's own directory as the context, ignoring the service `root`, so the
# file cannot sit in `packages/faces/` either — the install needs the workspace
# lockfile at the repository root. `Dockerfile.vercel` is meco's. What is left
# is a root-level `Containerfile`.
#
# A second image rather than another route in meco's: ONNX Runtime and its
# models add roughly 100 MB and a session load to every boot, and meco boots far
# more often than anyone asks for a face. See
# docs/adr/0002-meco-faces-as-a-separate-service.md.

FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11

# onnxruntime-node's postinstall exists only to download the CUDA 12 execution
# provider, and only on linux/x64. There is no GPU here, the download is large
# and it reaches nuget.org from inside the build. The env var is checked ahead
# of the CLI flag, so this is the switch that actually works.
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Fresh install so sharp and onnxruntime-node resolve to their linux builds even
# though this image is usually built from a macOS arm64 host.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/faces/package.json ./packages/faces/
RUN pnpm install --frozen-lockfile --filter meco-faces

# Compile ahead of time, for the same reason meco does: a scale-to-zero
# container boots often, and transpiling on every boot is paid CPU.
COPY packages/faces/tsconfig.json packages/faces/tsconfig.build.json ./packages/faces/
COPY packages/faces/src ./packages/faces/src
RUN pnpm --filter meco-faces build

# `deploy` is the only thing that reliably separates one workspace package's
# dependencies from its siblings': a plain `--filter` install still leaves
# meco's own tree — takumi, react, pdf-lib — in the store, and an image that
# renders nothing has no use for any of it.
RUN pnpm --filter meco-faces --prod deploy --legacy /out

# onnxruntime-node ships prebuilt binaries for all five platforms it supports,
# roughly 280 MB of which only one directory can ever run here. TARGETARCH is
# BuildKit's, so a build for linux/amd64 keeps x64 and a build for linux/arm64
# keeps arm64 — the image is always pruned to exactly the one it runs on.
ARG TARGETARCH
RUN ARCH=$(case "$TARGETARCH" in amd64) echo x64;; *) echo "$TARGETARCH";; esac) \
    && find /out/node_modules/onnxruntime-node/bin/napi-v6 -mindepth 2 -maxdepth 2 \
      -not -path "*/linux/$ARCH" -exec rm -rf {} + \
    && du -sh /out/node_modules /out/node_modules/onnxruntime-node

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
# dist/ sits at the same depth as src/ did, which is what keeps `../models`
# resolving from detect.ts.
COPY --from=build /app/packages/faces/dist ./dist
# The models are copied in, never fetched at boot. A container that downloads a
# model on start is a container that fails when the download does, and pays for
# the download on every cold start besides.
COPY packages/faces/models ./models

# Vercel sets $PORT; default 80 per the container-images contract.
EXPOSE 80
CMD ["node", "dist/server.js"]
