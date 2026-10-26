#!/bin/sh
# Conteneur tma-tunnel (tma-server) : un tunnel SSH par recette, sur le réseau privé.
# Chaque port 133xx de ce conteneur mène au relais 127.0.0.1:133xx de la recette.
set -eu
apk add --no-cache openssh-client >/dev/null
cp /tunnel/key /tmp/key && chmod 600 /tmp/key
pids=""
for host in $(grep -vE '^\s*(#|$)' /tunnel/targets.conf | awk '{print $2}' | sort -u); do
  forwards=$(grep -vE '^\s*(#|$)' /tunnel/targets.conf | awk -v h="$host" '$2==h {printf "-L 0.0.0.0:%s:127.0.0.1:%s ", $3, $3}')
  echo "tunnel vers $host : $forwards"
  # shellcheck disable=SC2086
  ssh -N -i /tmp/key -o UserKnownHostsFile=/tunnel/known_hosts -o StrictHostKeyChecking=yes \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    $forwards "${TUNNEL_USER:-deploy}@$host" &
  pids="$pids $!"
done
# Si un tunnel tombe, le conteneur s'arrête et Docker le relance (restart: unless-stopped).
wait -n 2>/dev/null || wait
exit 1
