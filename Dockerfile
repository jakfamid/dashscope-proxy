FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 8787
USER node
CMD ["node", "server.js"]
