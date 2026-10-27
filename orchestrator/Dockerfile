FROM node:22-slim
# git fetches the commit the code graph describes; CodeGraph itself comes with the npm dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER 1000
CMD ["node", "src/server.ts"]
