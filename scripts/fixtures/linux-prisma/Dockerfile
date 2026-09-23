# Build for linux/amd64: this reproduces the x64 AppImage's Debian-build/Fedora-runtime boundary.
FROM node:22-bookworm-slim AS client
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package-lock.json package-lock.json
RUN node -e 'const { packages } = require("./package-lock.json"); require("node:fs").writeFileSync("package.json", JSON.stringify({ private: true, dependencies: Object.fromEntries(["prisma", "@prisma/client"].map(name => [name, packages["node_modules/" + name].version])) })); require("node:fs").unlinkSync("package-lock.json")' \
    && npm install --no-audit --no-fund
COPY prisma/schema.prisma prisma/schema.prisma
RUN npx prisma generate \
    && find node_modules/.prisma/client -name '*query_engine-*' ! -name '*.so.node' -delete
COPY scripts/fixtures/linux-prisma/probe.mjs probe.mjs
# The same generated client must first work on the Debian build host.
RUN node probe.mjs

FROM fedora:44
RUN dnf -y --setopt=install_weak_deps=False install nodejs22 && dnf clean all
WORKDIR /app
# Match electron-builder's extraResources: only the generated client and its runtime are shipped.
COPY --from=client /app/node_modules/.prisma node_modules/.prisma
COPY --from=client /app/node_modules/@prisma/client node_modules/@prisma/client
COPY --from=client /app/probe.mjs probe.mjs
CMD ["node", "probe.mjs"]
