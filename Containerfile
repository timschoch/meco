# gateway — the public service, and the only one with a rewrite.
#
# The name of this file carries no meaning and cannot be made to. Vercel
# validates the `entrypoint` basename against a fixed list before it builds
# anything, and buildah then takes the build context from this file's own
# directory. So: a root-level file, named from that list, and `vercel.json`
# says which service it is. See DEPLOY.md.
FROM node:22-alpine AS build
WORKDIR /app
# husky's install step needs a .git directory that is not in the build context.
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @meco/gateway build
# The bundle leaves `sharp` and `@takumi-rs/core` external — both load native
# binaries by their own paths and cannot be inlined — so the runtime stage
# carries a flat node_modules holding those two and their dependencies, the
# same recipe `Dockerfile.vercel` uses for `models` (DEPLOY.md, the fourth
# trap).
RUN pnpm --filter @meco/gateway --prod deploy --legacy /deploy
# `pnpm deploy` copies every workspace dependency whole, so `@meco/models`
# brings onnxruntime-node's 283 MB of binaries into an image that runs no
# Model. The gateway reaches models over the service binding and imports one
# file to do it, the thin client, which the bundle inlines — the rule
# `models-client-stays-thin` in `.dependency-cruiser.cjs` is what keeps that
# true. Nothing here resolves the runtime, and the check below proves what
# does resolve.
RUN rm -rf /deploy/node_modules/.pnpm/onnxruntime-node@*

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
# After node_modules: the bundle's own folder carries each Look's fonts and
# wordmark under the Brand's name, which is where compose reads them.
COPY --from=build --chown=node:node /app/packages/gateway/dist/bundle ./
# Both halves of the fourth trap, as a build failure rather than a boot crash
# (DEPLOY.md). The natives the bundle marks external must resolve from this
# directory, and each Look's wordmark must be where compose will look for it.
# Deployment meco-i0z94sd7l built clean and then died on the first request
# with `Cannot find package '@takumi-rs/core' imported from /app/server.js`.
RUN node --input-type=module -e "\
  await import('sharp'); \
  await import('@takumi-rs/core'); \
  const { readFileSync } = await import('node:fs'); \
  for (const brand of ['laica', 'hopefamily', 'swisshutless']) { \
    readFileSync(new URL('./' + brand + '/logo.png', 'file:///app/')); \
  }"
USER node
ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
