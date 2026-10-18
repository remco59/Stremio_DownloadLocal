FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 7000
CMD ["node", "server.js"]
