# One image for every role in the e2e test: control plane, nodes, tester.
FROM node:24-bookworm-slim
ARG XRAY_VERSION=26.3.27
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 curl unzip ca-certificates procps openssl >/dev/null \
 && curl -fsSL -o /tmp/x.zip https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip \
 && unzip -q /tmp/x.zip -d /usr/local/bin xray geoip.dat geosite.dat && rm /tmp/x.zip && rm -rf /var/lib/apt/lists/*
