FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# npm can crash on network trouble and still exit 0; check the install so a broken image never gets built.
RUN npm ci --omit=dev && node -e "require('express')"
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 7000
CMD ["node", "server.js"]
