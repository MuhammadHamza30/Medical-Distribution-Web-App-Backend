FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY sql ./sql
USER node
EXPOSE 3000
CMD ["node", "src/entry.mjs"]
