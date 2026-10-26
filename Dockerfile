FROM composer:2 AS composer

FROM node:22.19.0-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.300
ARG NODE24_VERSION=24.22.0
ARG NODE26_VERSION=26.12.0
ARG PHP_VERSIONS="7.4 8.1"

# git + PHP multi-versions (dépôt Sury) pour les boutiques PrestaShop 1.7 / 8 et les modules.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils unzip libatomic1 mariadb-client openssh-client chromium fonts-liberation \
 && curl -fsSLo /tmp/sury.deb https://packages.sury.org/debsuryorg-archive-keyring.deb \
 && dpkg -i /tmp/sury.deb && rm /tmp/sury.deb \
 && echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ bookworm main" > /etc/apt/sources.list.d/php.list \
 && apt-get update \
 && pkgs="" && for v in $PHP_VERSIONS; do pkgs="$pkgs php$v-cli php$v-mbstring php$v-xml php$v-curl php$v-zip php$v-intl php$v-gd"; done \
 && apt-get install -y --no-install-recommends $pkgs \
 && rm -rf /var/lib/apt/lists/*

# /opt/php-<v>/bin/php : le serveur place la version du dépôt en tête du PATH de l'agent.
RUN for v in $PHP_VERSIONS; do mkdir -p /opt/php-$v/bin && ln -s /usr/bin/php$v /opt/php-$v/bin/php; done \
 && update-alternatives --set php /usr/bin/php7.4
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

# Node 22 (image) + 24 et 26 pour les outils internes ; même principe : /opt/node-<major>/bin.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && for v in $NODE24_VERSION $NODE26_VERSION; do \
      m=${v%%.*}; mkdir -p /opt/node-$m; \
      curl -fsSL https://nodejs.org/dist/v$v/node-v$v-linux-$arch.tar.xz | tar -xJ -C /opt/node-$m --strip-components=1; \
    done \
 && mkdir -p /opt/node-22 && ln -s /usr/local/bin /opt/node-22/bin

# pnpm à la version du champ packageManager de chaque dépôt (9, 10, 12…), via corepack, sans question
# interactive. Le corepack livré avec Node 22.19 ne sait pas lancer pnpm 12 : on le met à jour.
ARG COREPACK_VERSION=0.36.0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@${COREPACK_VERSION} \
 && corepack enable pnpm \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

COPY scripts/tma-php-lint scripts/tma-sql scripts/tma-browse /usr/local/bin/

# Audit d'accessibilité (tma-a11y.mjs, et tma-browse pour la mission audit-rgaa) : axe-core dans le Chromium
# de Debian, sans téléchargement.
RUN mkdir -p /opt/tma-tools && cd /opt/tma-tools && npm init -y >/dev/null \
 && PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund --silent puppeteer-core@25.12.0 axe-core@4.13.0

ENV DISABLE_AUTOUPDATER=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    REPOS_FILE=/app/repos.json \
    WORKTREES_DIR=/data/worktrees \
    LOGS_DIR=/data/logs \
    STATE_DIR=/data/state \
    KNOWLEDGE_DIR=/data/tma-knowledge \
    ATELIER_DIR=/data/atelier-plaque

WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node missions ./missions
COPY --chown=node:node git-hooks ./git-hooks
RUN mkdir -p /data/repos /data/worktrees /data/logs /data/state && chown -R node:node /data

# Registre privé du design system : le jeton vient de NODE_AUTH_TOKEN, jamais écrit en clair.
RUN printf '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n' > /home/node/.npmrc \
 && chown node:node /home/node/.npmrc

# Utilisateur non root fourni par l'image node (uid 1000).
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
