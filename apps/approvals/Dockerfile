FROM node:20-alpine
WORKDIR /app
COPY apps/approvals/package.json ./
RUN npm install
COPY apps/approvals/tsconfig.json ./
COPY apps/approvals/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
