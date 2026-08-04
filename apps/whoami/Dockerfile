FROM node:20-alpine
WORKDIR /app
COPY apps/whoami/package.json ./
RUN npm install
COPY apps/whoami/tsconfig.json ./
COPY apps/whoami/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/grmc-nav.js ./src/public/assets/grmc-nav.js
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && cp -r src/public dist/public
EXPOSE 3000
CMD ["node", "dist/index.js"]
