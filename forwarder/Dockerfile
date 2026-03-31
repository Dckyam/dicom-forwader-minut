FROM node:18-bullseye

RUN apt-get update && \
    apt-get install -y --no-install-recommends dcmtk && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV CHOKIDAR_USEPOLLING=true
ENV CHOKIDAR_INTERVAL=2000

CMD ["node", "index.js"]