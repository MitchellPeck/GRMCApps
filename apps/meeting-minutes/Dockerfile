# Debian (glibc), not Alpine: sherpa-onnx-node ships prebuilt glibc binaries
# only, and it is what matches speakers across the parts of a long recording.
FROM node:20-bookworm-slim
# ffmpeg splits long whole-meeting recordings into parts for whisper.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Speaker-embedding model (3D-Speaker ERes2Net, 16 kHz) for voice fingerprints.
ADD https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx /app/models/speaker-embedding.onnx
COPY apps/meeting-minutes/package.json ./
RUN npm install
COPY apps/meeting-minutes/tsconfig.json ./
COPY apps/meeting-minutes/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/grmc-nav.js ./src/public/assets/grmc-nav.js
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
