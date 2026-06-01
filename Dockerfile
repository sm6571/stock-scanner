FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data
ENV NODE_ENV=production
ENV DB_PATH=/app/data/stock_scanner.db
ENV PORT=3002
EXPOSE 3002
CMD ["node", "app.js"]
