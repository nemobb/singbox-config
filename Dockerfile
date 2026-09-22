FROM node:24-alpine

LABEL org.opencontainers.image.title="singbox-config" \
      org.opencontainers.image.description="sing-box config generate" \
      org.opencontainers.image.source="https://github.com/nemobb/singbox-config" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY index.js node.js package.json ./
COPY defaults/ ./defaults/
RUN mkdir -p profiles templates
USER node
EXPOSE 5300
CMD ["node", "index.js"]
