FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public/ ./public/
ENV HTTP_PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
