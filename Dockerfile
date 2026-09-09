# Key-pool proxy - single-file Node.js gateway
# Base follows the TARGET platform (buildx --platform selects it).
FROM node:20-alpine

# Bind all interfaces so docker -p port mappings can reach the service
ENV HOST=0.0.0.0
# Logs show Beijing time
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata

WORKDIR /app

COPY retry-proxy.js .
# Full config (providers/keys/overrides) baked into the image - no volume needed
COPY keys.json .

EXPOSE 9119 9120

CMD ["node", "retry-proxy.js"]
