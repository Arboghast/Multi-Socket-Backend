FROM node:12

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 8000

CMD ["node","index.js"]