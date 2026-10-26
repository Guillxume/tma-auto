#!/bin/sh
# À lancer DEPUIS TON MAC (gh connecté avec ton compte admin de l'organisation GitHub) :
#   sh scripts/github-webhook.sh
# Crée (ou met à jour) le webhook d'organisation qui envoie les commentaires de relecture des PR
# à https://<TMA_HOST>/webhooks/github, avec un secret partagé généré ici et jamais affiché.
set -eu
cd "$(dirname "$0")/.."
ORG=${GITHUB_ORG:-acme}
HOST=$(grep -E '^TMA_HOST=' .env | cut -d= -f2-)
URL="https://$HOST/webhooks/github"

if ! gh auth status 2>&1 | grep -q 'admin:org_hook'; then
  echo "→ gh a besoin du droit admin:org_hook (une fenêtre de navigateur va s'ouvrir)"
  gh auth refresh -h github.com -s admin:org_hook
fi

secret=$(openssl rand -hex 32)

# Secret côté serveur d'abord (le webhook ne doit jamais envoyer à un serveur qui ne le connaît pas).
printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$secret" | ssh -o BatchMode=yes tma-server \
  "cd ~/projects/tma-auto && grep -v '^GITHUB_WEBHOOK_SECRET=' .env > .env.new; cat >> .env.new; mv .env.new .env; chmod 600 .env; docker compose up -d >/dev/null 2>&1 && echo '✓ secret enregistré sur tma-server, tma-auto rechargé'"
grep -v '^GITHUB_WEBHOOK_SECRET=' .env > .env.new || true
printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$secret" >> .env.new && mv .env.new .env && chmod 600 .env

id=$(gh api "orgs/$ORG/hooks" --jq ".[] | select(.config.url == \"$URL\") | .id" | head -1)
set -- -f name=web -F active=true -f "config[url]=$URL" -f "config[content_type]=json" -f "config[secret]=$secret" -f "config[insecure_ssl]=0" \
  -f "events[]=pull_request_review_comment" -f "events[]=issue_comment" -f "events[]=pull_request_review"
if [ -n "$id" ]; then
  gh api -X PATCH "orgs/$ORG/hooks/$id" "$@" --jq '"✓ webhook \(.id) mis à jour → \(.config.url)"'
else
  gh api -X POST "orgs/$ORG/hooks" "$@" --jq '"✓ webhook \(.id) créé → \(.config.url)"'
fi
