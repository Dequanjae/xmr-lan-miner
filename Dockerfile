FROM node:18-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public/ ./public/
ENV HTTP_PORT=8080
ENV HTTPS_PORT=8443
EXPOSE 8080 8443
CMD ["node", "server.js"]