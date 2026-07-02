FROM node:20-alpine
WORKDIR /app
COPY apps/meeting-minutes/package.json ./
RUN npm install
COPY apps/meeting-minutes/tsconfig.json ./
COPY apps/meeting-minutes/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
