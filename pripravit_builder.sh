#!/bin/zsh
# Poskládá stavitele funnelů pro Netlify ze zdrojů v ~/nk_stack/nk_konverzky.
# Zdroj pravdy je pořád lokální projekt, tady se jen kopíruje a doplní prefix.
#
# Python jde do nkpy/ mimo publish adresář – zdrojáky ani databáze nemají
# být ke stažení. Do funkce se dostanou přes included_files.
set -e
cd "$(dirname "$0")"
Z=~/nk_stack/nk_konverzky

rm -rf nkpy web/builder
mkdir -p nkpy web/builder

for f in render.py komponenty_navic.py sanitizer.py ab.py admin_api.py web_api.py leady.py clenska.py migrace.py; do
  cp "$Z/$f" nkpy/
done
mkdir -p nkpy/sablony nkpy/sekce
cp "$Z"/sablony/*.json nkpy/sablony/ 2>/dev/null || true
cp "$Z"/sekce/*.json nkpy/sekce/ 2>/dev/null || true
cp "$Z/data/konverzky.db" nkpy/vychozi.db

cp -R "$Z/static/." web/builder/
# Admin na Netlify sedí pod /builder, ne v kořeni.
for f in web/builder/admin.html web/builder/editor.html; do
  /usr/bin/sed -i '' 's|{{Z}}|/builder|g' "$f"
done
# komponenty.css lokálně generuje Python, tady musí ležet jako soubor.
python3 - <<'PY'
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / "nk_stack" / "nk_konverzky"))
import render
pathlib.Path("web/builder/komponenty.css").write_text(render.KOMPONENTY_CSS, encoding="utf-8")
PY
# Vykreslené stránky odkazují na /brand.css a /formular.js od kořene – tak,
# jak by běžely na vlastní doméně. Musí tedy ležet i tam, ne jen pod /builder.
cp "$Z/static/brand.css" "$Z/static/formular.js" web/
cp web/builder/komponenty.css web/

echo "builder: web/$(du -sh web/builder | cut -f1)  python: $(du -sh nkpy | cut -f1)"
