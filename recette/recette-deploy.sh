#!/bin/sh
# Commande forcée de la clé tma_deploy (tma-server) : déploie une branche TMA sur la recette d'un site.
#   deploy <site> <branche>   la branche doit être tma/linear-<id>
#   restore <site>            revient à la version d'avant le premier déploiement TMA
#   status <site>
# Les sites autorisés et leur installation sont décrits dans ~/.tma-recette.conf :
#   site  dossier_git  type(stack|classic)  conteneur_php  dossier_compose
# Refuse si la recette a des modifications locales non commitées (elle est partagée avec l'équipe).
set -eu
set -- ${SSH_ORIGINAL_COMMAND:-}
action=${1:-}; site=${2:-}; branch=${3:-}
conf=$(awk -v s="$site" '!/^#/ && $1==s' "$HOME/.tma-recette.conf" 2>/dev/null)
[ -n "$site" ] && [ -n "$conf" ] || { echo "refusé : site non autorisé" >&2; exit 1; }
set -- $conf
dir=$2; kind=$3; php=$4; compose=$5
state="$HOME/.tma-recette-state"; mkdir -p "$state"
cd "$dir"

ensure_up() {
  if [ "$(docker inspect -f '{{.State.Running}}' "$php" 2>/dev/null)" != true ]; then
    (cd "$compose" && docker compose up -d >/dev/null 2>&1)
    echo "pile démarrée"
  fi
}
apply() {
  [ "$kind" = stack ] && make sync >/dev/null
  ensure_up
  docker exec -u www-data "$php" sh -c 'rm -rf var/cache/prod var/cache/dev' 2>/dev/null || true
}

case "$action" in
  deploy)
    case "$branch" in tma/linear-*) ;; *) echo "refusé : seules les branches tma/linear-* se déploient" >&2; exit 1 ;; esac
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      echo "refusé : la recette a des modifications locales non commitées" >&2
      git status --porcelain --untracked-files=no | head -10 >&2
      exit 2
    fi
    # Version d'origine notée une seule fois : « restore » y revient même après plusieurs déploiements TMA.
    created=""
    [ -f "$state/$site" ] || { { git symbolic-ref -q --short HEAD || git rev-parse HEAD; } > "$state/$site"; created=1; }
    orig=$(cat "$state/$site")
    git fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$branch:refs/remotes/origin/$branch"
    before=$(git rev-parse --short HEAD)
    if git merge-base --is-ancestor "$orig" origin/main; then
      # Recette en retard sur main (même structure) : la branche TMA se déploie telle quelle.
      git checkout --quiet --detach "origin/$branch"
      how="checkout de la branche"
    else
      # Recette sur une branche à elle (migration de structure…) : on n'y applique que les commits de la PR.
      git checkout --quiet --detach "$orig"
      if ! git -c user.name=tma-auto -c user.email=tma-auto@localhost cherry-pick --allow-empty "origin/main..origin/$branch" >/dev/null 2>&1; then
        conflicts=$(git diff --name-only --diff-filter=U | head -5 | tr '\n' ' ')
        git cherry-pick --abort 2>/dev/null || true
        git checkout --quiet "$orig"
        [ -n "$created" ] && rm -f "$state/$site"
        echo "refusé : le correctif ne s'applique pas proprement sur la branche de la recette ($(basename "$orig")) ; conflits : ${conflicts:-?}" >&2
        exit 3
      fi
      how="commits de la PR appliqués sur $orig"
    fi
    apply
    echo "déployé : $branch ($how, $(git rev-parse --short HEAD)), remplace $before ; origine notée : $orig"
    ;;
  restore)
    [ -f "$state/$site" ] || { echo "rien à restaurer"; exit 0; }
    ref=$(cat "$state/$site")
    # Retour exact à l'état noté, sans rien tirer de nouveau.
    git checkout --quiet "$ref"
    apply
    rm -f "$state/$site"
    echo "restauré : $ref ($(git rev-parse --short HEAD))"
    ;;
  status)
    echo "$(git rev-parse --short HEAD) $(git describe --all --always 2>/dev/null) ; origine : $(cat "$state/$site" 2>/dev/null || echo aucune)"
    ;;
  *) echo "refusé : commande inconnue" >&2; exit 1 ;;
esac
