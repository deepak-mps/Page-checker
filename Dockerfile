# Playwright's official image already has every OS-level shared library headless
# Chromium needs (libnss3, libatk-bridge2.0-0, libgbm1, fonts, etc.), pre-installed
# via apt as root at image-build time — this is what "playwright install --with-deps"
# would otherwise try to do, which Render's native (non-Docker) build sandbox blocks.
# Using this image sidesteps that restriction entirely instead of working around it.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Re-download the Chromium binary matching whatever playwright npm version actually
# resolved (package.json uses ^1.47.0, so this may not be exactly 1.47.2) — the base
# image's OS dependencies are still valid regardless of the exact browser build.
RUN npx playwright install chromium

# This container runs as root (the image's default) rather than switching to the
# built-in "pwuser" — Render's Docker runtime doesn't support passing a custom
# seccomp profile (docker run --security-opt), which the non-root sandboxed setup
# requires. Instead, Chromium's sandbox is explicitly disabled via launch args in
# src/scanner.ts (--no-sandbox). Standard tradeoff for containerized scraping tools
# that only ever navigate to a fixed set of URLs (bioRxiv), not arbitrary/untrusted
# user-supplied pages.

# SQLite DB + screenshots live here; mount a Render persistent disk at this path if
# you want scan history to survive redeploys.
RUN mkdir -p /app/data

EXPOSE 4000
ENV PORT=4000

CMD ["node", "dist/index.js"]
