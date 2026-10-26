#!/bin/sh
# Commande forcée de la clé tma_dbctl (tma-server) : démarre ou arrête une base de recette autorisée.
# Seules les commandes « start <base> » et « stop <base> » sont acceptées, pour les bases listées
# dans ~/.tma-db-allowlist. « stop » n'arrête qu'une base que « start » a lui-même allumée.
set -eu
set -- ${SSH_ORIGINAL_COMMAND:-}
action=${1:-}; db=${2:-}
grep -qx "$db" "$HOME/.tma-db-allowlist" 2>/dev/null || { echo "refusé : base non autorisée" >&2; exit 1; }
marks="$HOME/.tma-db-started"; mkdir -p "$marks"
case "$action" in
  start)
    if [ "$(docker inspect -f '{{.State.Running}}' "$db")" != true ]; then
      docker start "$db" >/dev/null && touch "$marks/$db"
    fi
    for _ in $(seq 1 60); do
      [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$db")" = healthy ] && { echo ok; exit 0; }
      sleep 2
    done
    echo "démarrée mais pas encore prête" >&2; exit 1 ;;
  stop)
    if [ -f "$marks/$db" ]; then docker stop "$db" >/dev/null && rm -f "$marks/$db"; echo arrêtée; else echo "rien à arrêter (pas allumée par tma)"; fi ;;
  *) echo "refusé : commande inconnue" >&2; exit 1 ;;
esac
