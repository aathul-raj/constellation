FROM node:20-slim

# Install Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci

# Copy Python requirements and install
COPY requirements.txt ./
RUN pip3 install -r requirements.txt --break-system-packages

# Copy the rest of the app
COPY . .

# Build Next.js
RUN npm run build

# Expose port (Railway will set PORT env variable)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]