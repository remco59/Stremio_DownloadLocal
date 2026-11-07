FROM node:20-alpine
# ffmpeg: the web player's audio track switching, subtitles and conversions for the browser.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
# npm can crash on network trouble and still exit 0; check the install so a broken image never gets built.
RUN npm ci --omit=dev && node -e "require('express')"
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 7000
# Healthy = the add-on answers and its torrent client is reachable (/healthz, see README).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
