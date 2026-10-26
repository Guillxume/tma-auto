#!/bin/sh
# À lancer SUR une recette : un relais par base, qui n'écoute que sur 127.0.0.1:<port> (jamais
# exposé). Le tunnel SSH de tma-server vient s'y brancher. Fonctionne aussi pour une base arrêtée :
# le relais ne se connecte qu'à la demande. Supprime les relais qui ne sont plus listés. Relançable.
# Usage : sh gateways.sh <conteneur_db>:<port> [...]
set -eu
keep=""
for spec in "$@"; do
  db=${spec%%:*}; port=${spec##*:}; name="tma-gw-$port"; keep="$keep $name"
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$db" | cut -d' ' -f1)
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --network "$net" \
    -p "127.0.0.1:$port:3306" --memory 32m --read-only --cap-drop ALL \
    alpine/socat:1.8.0.3 TCP-LISTEN:3306,fork,reuseaddr "TCP:$db:3306" >/dev/null
  echo "✓ $name : 127.0.0.1:$port → $db:3306 (réseau $net)"
done
for old in $(docker ps -a --format '{{.Names}}' | grep '^tma-gw-'); do
  case " $keep " in *" $old "*) ;; *) docker rm -f "$old" >/dev/null && echo "✗ $old supprimé (plus listé)";; esac
done
