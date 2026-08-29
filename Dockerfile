FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 8787
CMD ["node", "server.js"]
