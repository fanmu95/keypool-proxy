# Key-pool proxy — single-file Node.js gateway
# Runtime base follows the TARGET platform (buildx --platform selects it).
FROM node:20-alpine

WORKDIR /app

COPY retry-proxy.js .

# Placeholder config so the container can boot without a mounted keys.json.
# Real config (with provider keys) is mounted at runtime:
#   volumes: - ./keys.json:/app/keys.json
RUN printf '{"providers":{},"maxRetries":10,"retryDelay":0,"requestTimeout":30000,"overallTimeout":120000,"circuitBreaker":8,"mode":"normal","cooldown429":30,"raceRounds":3,"roundDelay":500,"port":9119,"managePort":9120}' > keys.json

EXPOSE 9119 9120

CMD ["node", "retry-proxy.js"]
