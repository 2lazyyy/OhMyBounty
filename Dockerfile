FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    curl wget git ca-certificates \
    golang-go python3 python3-pip \
    jq \
    chromium fonts-liberation libappindicator3-1 \
    libasound2t64 libatk-bridge2.0-0 libgtk-3-0 libnspr4 libnss3 \
    xdg-utils libxss1 \
    mysql-client \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (replaces the old apt-get nodejs npm)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
    && cp ~/go/bin/subfinder /usr/local/bin/

RUN go install -v github.com/owasp-amass/amass/v4/...@master \
    && cp ~/go/bin/amass /usr/local/bin/

RUN pip3 install sublist3r --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x tools/run-subdomain-tools.sh

CMD ["node", "subdomain-scanner.js"]