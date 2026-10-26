# Exécuté DANS un conteneur MySQL de recette (via docker exec), mot de passe reçu en $PW.
# Crée tma_ro : SELECT sur les tables de contenu uniquement. Affiche « base préfixe ».
set -eu
db="$MYSQL_DATABASE"
q() { MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N "$@" 2>/dev/null; }
pre=$(q -e "SELECT REPLACE(table_name, 'cms_lang', '') FROM information_schema.tables WHERE table_schema = '$db' AND table_name LIKE '%cms\_lang' LIMIT 1")
[ -n "$pre" ] || { echo "ERREUR : aucune table *cms_lang dans $db" >&2; exit 1; }
{
  echo "CREATE USER IF NOT EXISTS 'tma_ro'@'%' IDENTIFIED WITH mysql_native_password BY '$PW' WITH MAX_USER_CONNECTIONS 3;"
  echo "ALTER USER 'tma_ro'@'%' IDENTIFIED WITH mysql_native_password BY '$PW';"
  for t in cms cms_lang cms_category cms_category_lang product_lang category_lang meta meta_lang lang shop; do
    echo "GRANT SELECT ON \`$db\`.\`$pre$t\` TO 'tma_ro'@'%';"
  done
  echo "FLUSH PRIVILEGES;"
} | q --force
echo "$db $pre"
