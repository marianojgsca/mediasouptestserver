# Use an official Node.js runtime as a parent image
FROM node:18

# Install dependencies needed for building mediasoup-worker
# build-essential provides make, g++, etc.
# python3-pip provides pip
# python3 is usually included, but explicit doesn't hurt
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
# Copying these first leverages Docker cache if only code changes later
COPY package*.json ./

# Install app dependencies including devDependencies if build scripts need them
# Mediasoup build might happen here during postinstall scripts
RUN npm install

# Bundle app source (including the 'public' directory)
COPY . .

# Generate certs if they don't exist (optional, better to mount them)
# RUN if [ ! -f "certs/cert.pem" ]; then npm run generate-certs; fi

# Your app binds to port 3000 (or whatever $PORT is)
EXPOSE ${PORT:-3000}

# Mediasoup RTC ports (UDP/TCP) - Mapped in docker-compose
# EXPOSE 10000-10999/udp
# EXPOSE 10000-10999/tcp

# Define the command to run your app
CMD [ "npm", "start" ]
