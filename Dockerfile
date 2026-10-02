FROM golang:1.26-alpine AS recon-tools

RUN go install github.com/projectdiscovery/katana/cmd/katana@latest \
    && go install github.com/tomnomnom/assetfinder@latest

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
    tar \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install subfinder (pre-built binary)
RUN curl -fsSL https://github.com/projectdiscovery/subfinder/releases/download/v2.14.0/subfinder_2.14.0_linux_amd64.zip -o /tmp/subfinder.zip \
    && mkdir -p /tmp/subfinder \
    && unzip -q /tmp/subfinder.zip -d /tmp/subfinder \
    && SUBFINDER_BINARY="$(find /tmp/subfinder -type f -name subfinder -print -quit)" \
    && test -n "$SUBFINDER_BINARY" \
    && install -m 0755 "$SUBFINDER_BINARY" /usr/local/bin/subfinder \
    && rm -rf /tmp/subfinder /tmp/subfinder.zip

COPY --from=recon-tools /go/bin/katana /usr/local/bin/katana
COPY --from=recon-tools /go/bin/assetfinder /usr/local/bin/assetfinder

RUN curl -fsSL https://github.com/Findomain/Findomain/releases/download/10.0.1/findomain-linux.zip -o /tmp/findomain.zip \
    && mkdir -p /tmp/findomain \
    && unzip -q /tmp/findomain.zip -d /tmp/findomain \
    && FINDOMAIN_BINARY="$(find /tmp/findomain -type f -name findomain -print -quit)" \
    && test -n "$FINDOMAIN_BINARY" \
    && install -m 0755 "$FINDOMAIN_BINARY" /usr/local/bin/findomain \
    && rm -rf /tmp/findomain /tmp/findomain.zip

RUN pip3 install sublist3r --break-system-packages

RUN git clone --depth 1 https://github.com/m4ll0k/SecretFinder.git /opt/SecretFinder \
    && git clone --depth 1 https://github.com/GerbenJavado/LinkFinder.git /opt/LinkFinder \
    && pip3 install --break-system-packages \
        -r /opt/SecretFinder/requirements.txt \
        -r /opt/LinkFinder/requirements.txt

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x tools/run-subdomain-tools.sh

CMD ["node", "subdomain-scanner.js"]
