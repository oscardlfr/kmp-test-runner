# syntax=docker/dockerfile:1.7

ARG NODE24_VERSION=24.18.0
ARG NODE18_VERSION=18.20.8
ARG ACTIONLINT_VERSION=1.7.12

FROM node:${NODE24_VERSION}-bookworm AS node24
ARG ACTIONLINT_VERSION
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java17 \
    CI=true \
    NPM_CONFIG_CACHE=/cache/npm \
    GRADLE_USER_HOME=/cache/gradle

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git openjdk-17-jdk-headless shellcheck tar gzip zip unzip \
    && ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" "${JAVA_HOME}" \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global bats@1.13.0 \
    && case "${TARGETARCH}" in \
         amd64) actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;; \
         arm64) actionlint_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;; \
         *) echo "unsupported actionlint architecture: ${TARGETARCH}" >&2; exit 2 ;; \
       esac \
    && curl -fsSLo /tmp/actionlint.tar.gz \
       "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && echo "${actionlint_sha}  /tmp/actionlint.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint \
    && rm /tmp/actionlint.tar.gz

COPY tools/local-ci/container/prepare-source.sh /usr/local/lib/kmp-local-ci/prepare-source.sh
COPY tools/local-ci/container/linux-gate.sh /usr/local/bin/kmp-local-ci-linux
RUN chmod 0755 /usr/local/bin/kmp-local-ci-linux /usr/local/lib/kmp-local-ci/prepare-source.sh

ENTRYPOINT ["/usr/local/bin/kmp-local-ci-linux"]

FROM node:${NODE18_VERSION}-bookworm AS node18

ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java17 \
    CI=true \
    NPM_CONFIG_CACHE=/cache/npm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git openjdk-17-jdk-headless tar gzip \
    && ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" "${JAVA_HOME}" \
    && rm -rf /var/lib/apt/lists/*

COPY tools/local-ci/container/prepare-source.sh /usr/local/lib/kmp-local-ci/prepare-source.sh
COPY tools/local-ci/container/node18-gate.sh /usr/local/bin/kmp-local-ci-node18
RUN chmod 0755 /usr/local/bin/kmp-local-ci-node18 /usr/local/lib/kmp-local-ci/prepare-source.sh

ENTRYPOINT ["/usr/local/bin/kmp-local-ci-node18"]
