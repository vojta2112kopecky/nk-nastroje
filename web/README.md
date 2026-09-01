# NK Nástroje – veřejný web

Statické nástroje Nejlepší Koučky na **https://nastroje.nejlepsikoucka.cz**.
Hostuje GitHub Pages, nasazuje se pushem do `main`.

| Cesta | Co tam je |
|---|---|
| `/` | rozcestník |
| `/igtext/` | generátor IG textů – fonty zapečené v souboru, funguje offline |
| `/ads/` | Ads Dashboard – bez backendu se sám přepne na ukázková data |

## DNS

`nastroje` CNAME → `vojta2112kopecky.github.io` (přidáno ve správě domény
v Konverzkách, zóna běží u Gransy). Kořen domény zůstal nedotčený – A záznam
míří na Konverzky, pošta na Seznam.

## Proč tu není stavitel funnelů

NK Konverzky (builder) nemá přihlašování. Na veřejném webu by mohl kdokoliv
editovat stránky, takže zůstává lokální, dokud login nedostane.
