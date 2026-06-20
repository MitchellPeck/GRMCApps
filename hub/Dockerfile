FROM node:20-alpine
WORKDIR /app
COPY hub/package.json ./
RUN npm install
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && cp -r src/views dist/views && cp -r src/public dist/public
EXPOSE 3000
CMD ["node", "dist/index.js"]
