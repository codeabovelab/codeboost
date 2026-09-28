FROM node:26.7.0-bookworm@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1

ARG CODEX_VERSION=0.153.4
ARG CLAUDE_VERSION=2.1.281

RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force \
    && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin codeboost \
    && install --directory --owner=10001 --group=10001 --mode=0700 /home/codeboost \
    && install --directory --owner=10001 --group=10001 --mode=0755 /work /work/.git

COPY --chmod=0555 container/probe.sh /usr/local/bin/codeboost-container-probe
COPY --chmod=0444 network/proxy.mjs /usr/local/lib/codeboost-egress-proxy.mjs

LABEL org.opencontainers.image.base.name="docker.io/library/node:26.7.0-bookworm@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1" \
      io.codeboost.codex.version="0.153.4" \
      io.codeboost.claude.version="2.1.281" \
      io.codeboost.profile.version="1"

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/codeboost-container-probe"]
