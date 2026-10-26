#!/bin/sh
# Test à blanc du serveur, sans Claude, git ni réseau : DRY_RUN, faux webhooks Linear signés,
# puis vérification de la signature et de l'aiguillage vers les dépôts de repos.json.
# Usage : sh scripts/smoke-test.sh   (Node 22+)
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
port=${SMOKE_PORT:-18787}
url="http://127.0.0.1:$port/webhooks/linear"
export DRY_RUN=1 HOST=127.0.0.1 PORT=$port REPOS_FILE="$PWD/repos.json" \
  LOGS_DIR="$tmp/logs" STATE_DIR="$tmp/state" WORKTREES_DIR="$tmp/worktrees" KNOWLEDGE_DIR= ATELIER_DIR= \
  LINEAR_WEBHOOK_SECRET=smoke-secret LINEAR_ASSIGNEE_ID=00000000-0000-0000-0000-000000000000 GITHUB_REVIEWER=reviewer

node server.mjs > "$tmp/server.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

fail=0
check() { # check <attendu> <description> <options de send-test-webhook…>
  want=$1; what=$2; shift 2
  got=$(node scripts/send-test-webhook.mjs "$url" "$@" | cut -d' ' -f1)
  if [ "$got" = "$want" ]; then echo "✓ $what ($got)"; else echo "✗ $what : $got au lieu de $want"; fail=1; fi
}
check 401 "signature invalide refusée" --bad-signature
check 200 "ticket avec label de site" --labels globex
check 200 "ticket avec lien GitHub" --github acme/acme-pim
sleep 1

for route in "→ acme/globex " "→ acme/acme-pim "; do
  if grep -q "$route" "$tmp/server.log"; then echo "✓ aiguillage $route"; else echo "✗ aiguillage $route absent"; fail=1; fi
done
[ $fail -eq 0 ] || { echo "--- journal du serveur"; cat "$tmp/server.log"; }
exit $fail
