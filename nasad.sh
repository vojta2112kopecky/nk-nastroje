#!/bin/zsh
# Nasadí web na Netlify i s bránou. Token se bere z prostředí.
cd "$(dirname "$0")"
if [[ -z "$NETLIFY_AUTH_TOKEN" ]]; then
  echo "Chybí NETLIFY_AUTH_TOKEN. Token je v ~/nk_stack/nk_dashboard/PRISTUPY.md"
  exit 1
fi
/tmp/nkcli/node_modules/.bin/netlify deploy --prod --dir=. \
  --site=f0101fee-cc79-4509-b898-db6bf29b87c6
