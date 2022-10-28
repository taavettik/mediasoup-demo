FROM node:lts

RUN apt-get update && apt-get install build-essential python3-pip -y

WORKDIR /service

CMD npm install && npm run start:dev