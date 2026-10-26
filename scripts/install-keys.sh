#!/bin/sh
# À lancer sur tma-server, depuis ~/projects/tma-auto, après création des clés dans ~/.ssh :
#   tma_dbctl  : allumer / éteindre les bases de recette autorisées
#   tma_deploy : déployer une branche tma/* sur la recette d'un site autorisé
# Les copie dans le volume privé du conteneur (~/.tma), au propriétaire du conteneur (uid 1000) :
# l'hôte (uid 1001) les garde en 600. L'agent ne peut pas les lire (règle Read de ~/.tma/**).
set -eu
docker run --rm --user root \
  -v tma-auto_tma-home:/home/node \
  -v "$HOME/.ssh:/tmp/ssh:ro" \
  --entrypoint sh tma-auto-tma-auto -c '
    install -o node -g node -m 700 -d /home/node/.tma
    for k in dbctl deploy; do
      [ -f /tmp/ssh/tma_$k ] && install -o node -g node -m 600 /tmp/ssh/tma_$k /home/node/.tma/${k}_key && echo "✓ clé $k installée"
    done
    install -o node -g node -m 644 /tmp/ssh/tma_tunnel_known_hosts /home/node/.tma/known_hosts && echo "✓ empreintes des recettes installées"'
