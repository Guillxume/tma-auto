#!/bin/sh
# À lancer DEPUIS TON MAC (il a accès en SSH aux recettes et à tma-server) :
#   sh scripts/recette-db-users.sh
# Pour chaque base de recette/targets.conf : crée l'utilisateur MySQL tma_ro (SELECT sur les tables
# de contenu uniquement), puis écrit DB_URL_* dans le .env de tma-server et dans ton .env local.
# Les mots de passe sont générés ici, passent par l'entrée standard et ne s'affichent jamais.
# Relançable : régénère les mots de passe.
set -eu
cd "$(dirname "$0")/.."
urls=$(mktemp)
trap 'rm -f "$urls"' EXIT

grep -vE '^[[:space:]]*(#|$)' recette/targets.conf | while read -r alias _ip port container repo; do
  var=DB_URL_$(printf '%s' "$repo" | tr '[:lower:]-' '[:upper:]_')
  pw=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
  # Base arrêtée : on l'allume le temps de créer le compte, puis on la rééteint.
  was=$(ssh -n -o BatchMode=yes "$alias" "docker inspect -f '{{.State.Running}}' $container" 2>/dev/null || echo absent)
  [ "$was" = absent ] && { echo "✗ $container ($alias) : conteneur introuvable"; continue; }
  if [ "$was" != true ]; then
    ssh -n -o BatchMode=yes "$alias" "docker start $container >/dev/null; for i in \$(seq 1 60); do s=\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' $container); [ \"\$s\" = healthy ] && break; sleep 2; done" 2>/dev/null
  fi
  res=$({ printf '%s\n' "$pw"; cat recette/db-user.inner.sh; } \
    | ssh -o BatchMode=yes "$alias" "docker exec -i $container sh -c 'read -r PW; export PW; sh -s'" 2>/dev/null) || res=""
  [ "$was" != true ] && ssh -n -o BatchMode=yes "$alias" "docker stop $container >/dev/null" 2>/dev/null
  [ -n "$res" ] || { echo "✗ $container ($alias) : création du compte en échec"; continue; }
  db=${res% *}; prefix=${res#* }
  printf '%s=mysql://tma_ro:%s@tma-tunnel:%s/%s\n' "$var" "$pw" "$port" "$db" >> "$urls"
  echo "✓ $container ($alias) : base $db, préfixe $prefix → $var$([ "$was" != true ] && echo ' (rééteinte)')"
done

[ -s "$urls" ] || { echo "Aucune base configurée."; exit 1; }
vars=$(cut -d= -f1 "$urls" | paste -sd'|' -)

# .env du serveur : on remplace les anciennes valeurs, puis on recharge tma-auto.
ssh -o BatchMode=yes tma-server "cd ~/projects/tma-auto && grep -vE '^($vars)=' .env > .env.new; cat >> .env.new; mv .env.new .env; chmod 600 .env; docker compose up -d >/dev/null 2>&1 && echo '✓ .env de tma-server mis à jour, tma-auto rechargé'" < "$urls"

# .env local, pour rester aligné.
grep -vE "^($vars)=" .env > .env.new || true
cat "$urls" >> .env.new && mv .env.new .env && chmod 600 .env
echo "✓ .env local mis à jour ($(wc -l < "$urls" | tr -d ' ') base(s))"
