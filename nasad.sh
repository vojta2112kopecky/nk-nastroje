#!/bin/zsh
# Nasadí web na Netlify i s bránou a stavitelem. Token se bere z prostředí.
set -e
cd "$(dirname "$0")"
if [[ -z "$NETLIFY_AUTH_TOKEN" ]]; then
  echo "Chybí NETLIFY_AUTH_TOKEN."
  exit 1
fi
./pripravit_builder.sh
/tmp/nkcli/node_modules/.bin/netlify deploy --prod \
  --skip-functions-cache --site=f0101fee-cc79-4509-b898-db6bf29b87c6
