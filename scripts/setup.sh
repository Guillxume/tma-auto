#!/bin/sh
# Configuration initiale du conteneur, relançable sans risque :
# identité git du bot, identifiants, serveurs MCP (Linear, GitHub), clone de tous les dépôts.
# Usage : docker compose run --rm tma-auto sh scripts/setup.sh
set -eu
: "${GITHUB_BOT_LOGIN:?GITHUB_BOT_LOGIN manquant dans .env}"
: "${GITHUB_BOT_TOKEN:?GITHUB_BOT_TOKEN manquant dans .env}"
: "${LINEAR_API_KEY:?LINEAR_API_KEY manquant dans .env}"
email="${GITHUB_BOT_EMAIL:-$GITHUB_BOT_LOGIN@users.noreply.github.com}"

echo "→ identité git : $GITHUB_BOT_LOGIN <$email>"
git config --global user.name "$GITHUB_BOT_LOGIN"
git config --global user.email "$email"
git config --global credential.helper store
(umask 077 && printf 'https://%s:%s@github.com\n' "$GITHUB_BOT_LOGIN" "$GITHUB_BOT_TOKEN" > "$HOME/.git-credentials")

echo "→ serveurs MCP"
claude mcp remove --scope user linear >/dev/null 2>&1 || true
claude mcp remove --scope user github >/dev/null 2>&1 || true
claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp -H "Authorization: Bearer $LINEAR_API_KEY" >/dev/null
claude mcp add --transport http --scope user github https://api.githubcopilot.com/mcp/ -H "Authorization: Bearer $GITHUB_BOT_TOKEN" >/dev/null
claude mcp list

echo "→ dépôts"
node scripts/clone-repos.mjs
