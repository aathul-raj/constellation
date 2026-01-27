FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY requirements.txt ./
RUN pip3 install -r requirements.txt --break-system-packages

COPY . .

# Set dummy env vars for build only
ENV NEXTAUTH_SECRET=build-time-dummy \
    GOOGLE_CLIENT_ID=build-time-dummy \
    GOOGLE_CLIENT_SECRET=build-time-dummy \
    FIREBASE_PROJECT_ID=build-time-dummy \
    FIREBASE_CLIENT_EMAIL=build-time-dummy \
    FIREBASE_PRIVATE_KEY=build-time-dummy

RUN npm run build

# Real env vars will be provided by Railway at runtime
ENV NEXTAUTH_SECRET= \
    GOOGLE_CLIENT_ID= \
    GOOGLE_CLIENT_SECRET= \
    FIREBASE_PROJECT_ID= \
    FIREBASE_CLIENT_EMAIL= \
    FIREBASE_PRIVATE_KEY=

EXPOSE 3000

CMD ["npm", "start"]