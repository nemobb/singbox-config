FROM node:18-alpine
WORKDIR /app
COPY *.js *.json ./README.md ./
EXPOSE 5300
CMD ["npm", "start"]
