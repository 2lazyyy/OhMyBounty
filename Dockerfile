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
RUN curl -sL https://github.com/projectdiscovery/subfinder/releases/download/v2.14.0/subfinder_2.14.0_linux_amd64.zip -o /tmp/subfinder.zip \
    && unzip /tmp/subfinder.zip -d /tmp \
    && mv /tmp/subfinder /usr/local/bin/ \
    && chmod +x /usr/local/bin/subfinder \
    && rm /tmp/subfinder.zip

# Install amass (pre-built gzip tarball)
RUN curl -fsSL https://github.com/owasp-amass/amass/releases/download/v5.1.1/amass_linux_amd64.tar.gz -o /tmp/amass.tar.gz \
    && tar -xzf /tmp/amass.tar.gz -C /tmp \
    && AMASS_BINARY="$(find /tmp -type f -name amass -print -quit)" \
    && test -n "$AMASS_BINARY" \
    && install -m 0755 "$AMASS_BINARY" /usr/local/bin/amass \
    && rm -f /tmp/amass.tar.gz

COPY --from=recon-tools /go/bin/katana /usr/local/bin/katana
COPY --from=recon-tools /go/bin/assetfinder /usr/local/bin/assetfinder

RUN curl -fsSL https://github.com/findomain/findomain/releases/latest/download/findomain-linux -o /usr/local/bin/findomain \
    && chmod +x /usr/local/bin/findomain

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
