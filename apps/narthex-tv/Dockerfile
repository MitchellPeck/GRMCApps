# Debian, not Alpine: this app shells out to LibreOffice (PowerPoint -> PDF),
# poppler (PDF -> per-slide images) and ffmpeg (video probe/transcode/poster).
# None of those are reliably available on musl.
FROM node:22-bookworm-slim

# libreoffice-impress, not `libreoffice`: it pulls in the Impress import
# filters + core, not the whole office suite. Naming it matters — with only
# libreoffice-core installed there are no document filters at all, and soffice
# then "converts" every deck into nothing while still exiting 0.
# fonts-liberation/dejavu matter too: a deck rendered with no fonts installed
# comes out with boxes where the text should be.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      ffmpeg \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/narthex-tv/package.json ./
RUN npm install
COPY apps/narthex-tv/tsconfig.json ./
COPY apps/narthex-tv/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/grmc-nav.js ./src/public/assets/grmc-nav.js
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
