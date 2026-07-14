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

# install pre-built subfinder binary
RUN curl -fsSL https://github.com/projectdiscovery/subfinder/releases/download/v2.14.0/subfinder_2.14.0_linux_amd64.zip -o /tmp/subfinder.zip \
    && unzip /tmp/subfinder.zip -d /tmp/subfinder-extract \
    && find /tmp/subfinder-extract -type f -name "subfinder" -exec mv {} /usr/local/bin/subfinder \; \
    && chmod +x /usr/local/bin/subfinder \
    && rm -rf /tmp/subfinder.zip /tmp/subfinder-extract

# install pre-built amass binary
RUN curl -fsSL https://github.com/owasp-amass/amass/releases/download/v5.1.1/amass_linux_amd64.tar.gz -o /tmp/amass.tar.gz \
    && mkdir -p /tmp/amass-extract \
    && tar -xzf /tmp/amass.tar.gz -C /tmp/amass-extract \
    && find /tmp/amass-extract -type f -name "amass" -exec mv {} /usr/local/bin/amass \; \
    && chmod +x /usr/local/bin/amass \
    && rm -rf /tmp/amass.tar.gz /tmp/amass-extract

RUN pip3 install sublist3r --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x tools/run-subdomain-tools.sh

CMD ["node", "subdomain-scanner.js"]
