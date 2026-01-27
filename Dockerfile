FROM node:20-slim

# Install Python and required system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 --version \
    && pip3 --version

WORKDIR /app

COPY package*.json ./

RUN rm -f package-lock.json && npm install --legacy-peer-deps

COPY requirements.txt ./
RUN pip3 install -r requirements.txt --break-system-packages \
    && python3 -c "import pandas; import numpy; import boto3; import pyarrow; print('Python packages verified')"

COPY . .

# Create temp directory for deployments
RUN mkdir -p .tmp/deployments && chmod 777 .tmp/deployments

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]