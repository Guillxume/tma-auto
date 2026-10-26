#!/bin/sh
# Crée l'utilisateur MySQL tma_ro (SELECT seul, tables de contenu seules) dans la base d'une
# boutique hébergée en conteneur sur ce serveur, et écrit son URL dans .env.
# Le mot de passe est généré ici et n'est jamais affiché. Relançable (régénère le mot de passe).
#
# Usage, depuis ~/projects/tma-auto :
#   sh scripts/create-db-readonly.sh <conteneur-db> <base> <préfixe> <VARIABLE>
#   sh scripts/create-db-readonly.sh globex-db globex ps_ DB_URL_GLOBEX
set -eu
[ $# -eq 4 ] || { sed -n '6,8p' "$0"; exit 1; }
container=$1 db=$2 prefix=$3 var=$4
cd "$(dirname "$0")/.."

pw=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
grants=""
for t in cms cms_lang cms_category cms_category_lang product_lang category_lang meta meta_lang lang shop; do
  grants="$grants GRANT SELECT ON \`$db\`.\`$prefix$t\` TO 'tma_ro'@'%';"
done

docker exec -i -e PW="$pw" "$container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' <<SQL
CREATE USER IF NOT EXISTS 'tma_ro'@'%' IDENTIFIED WITH mysql_native_password BY '$pw' WITH MAX_USER_CONNECTIONS 3;
ALTER USER 'tma_ro'@'%' IDENTIFIED WITH mysql_native_password BY '$pw';
$grants
FLUSH PRIVILEGES;
SQL

sed -i.bak "/^$var=/d" .env && rm -f .env.bak
printf '%s=mysql://tma_ro:%s@%s:3306/%s\n' "$var" "$pw" "$container" "$db" >> .env
chmod 600 .env
echo "✓ tma_ro créé dans $container ($db), URL écrite dans .env ($var). Droits :"
docker exec "$container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SHOW GRANTS FOR '"'"'tma_ro'"'"'@'"'"'%'"'"'"' 2>/dev/null | sed 's/ TO .*//; s/^/   /'
