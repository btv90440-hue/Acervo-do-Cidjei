FROM node:22-alpine

# O pacote ffmpeg do Alpine traz também o ffprobe.
RUN apk add --no-cache ffmpeg \
 && mkdir -p /data \
 && chown node:node /data

WORKDIR /app
COPY server.mjs ./

ENV PORT=8080 DATA_DIR=/data
USER node
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "server.mjs"]
