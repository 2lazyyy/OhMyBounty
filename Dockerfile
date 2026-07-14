FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    curl wget git ca-certificates \
    python3 python3-pip \
    jq \
    chromium fonts-liberation libappindicator3-1 \
    libasound2t64 libatk-bridge2.0-0 libgtk-3-0 libnspr4 libnss3 \
    xdg-utils libxss1 \
    mysql-client \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install subfinder (pre-built binary)
RUN curl -sL https://github.com/projectdiscovery/subfinder/releases/download/v2.14.0/subfinder_2.14.0_linux_amd64.zip -o /tmp/subfinder.zip \
    && unzip /tmp/subfinder.zip -d /tmp \
    && mv /tmp/subfinder /usr/local/bin/ \
    && chmod +x /usr/local/bin/subfinder \
    && rm /tmp/subfinder.zip

# Install amass (pre-built binary)
RUN curl -sL https://github.com/owasp-amass/amass/releases/download/v5.1.1/amass_linux_amd64.tar.gz -o /tmp/amass.zip \
    && unzip /tmp/amass.zip -d /tmp \
    && mv /tmp/amass /usr/local/bin/ \
    && chmod +x /usr/local/bin/amass \
    && rm /tmp/amass.zip

RUN pip3 install sublist3r --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x tools/run-subdomain-tools.sh

CMD ["node", "subdomain-scanner.js"]
