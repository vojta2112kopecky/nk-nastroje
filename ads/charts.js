/* =============================================================================
 * NK Ads Dashboard — charts.js  (ROLE: Frontend GRAFY / ECharts)
 * -----------------------------------------------------------------------------
 * Konzumuje SDÍLENÝ kontrakt window.ADS (shell ho definuje). NEODCHYLUJE se od něj.
 *
 * OBSAHUJE TŘI GRAFY:
 *   1) „Vývoj v čase"      → #charts-root (prsteny) / #charts-earrings (náušnice)
 *   2) „Vývoj ROAS po týdnech" (FEEDBACK F4) → #weekly-root (mount přidává index.html)
 *   3) mini trend JEDNÉ kreativy (FEEDBACK M1) → window.ADS.miniTrend(el, {...})
 *
 * Data:
 *   ADS.api('timeseries', { from, to, tab, metric, split, funnel })
 *     → { dates:[...], series:[{ name, data:[...], estimating_from_index }] }
 *   ADS.api('weekly', { weeks:18, tab })            → viz normalizeWeekly() (tolerantní)
 *   ADS.api('creatives', { from, to, tab })         → per-kreativa agregát OKNA (miniTrend, H1)
 *
 * ⚠️ FEEDBACK-2 / D2 — TÝDENNÍ AGREGACE JE DEFAULT (Filipův nápad, a je správný):
 *    „neměli bychom je brát na denní bázi, ale na týdenní — pak tam nebudou takový ústřely".
 *    Týden se počítá POCTIVĚ: sečtou se SUROVÉ BUŇKY (spend, revenue, revenue_model, leads,
 *    bookings, bookings_eff) a TEPRVE PAK se z nich spočítá metrika.
 *    NIKDY se neprůměrují hotové ROAS/CPL/CPA přes dny — to dá nesmysl:
 *      po: spend 1000, tržba 0     → ROAS 0
 *      út: spend 10,   tržba 500   → ROAS 50
 *      průměr denních ROAS = 25 ×  ✗   |   správně = 500/1010 = 0,50 ×  ✓
 *    `?action=timeseries` umí vrátit jen JEDNU spočítanou metriku na den, takže si u poměrových
 *    metrik vytáhneme ČITATELE a JMENOVATELE zvlášť (viz AGG níž) a složíme je až po sečtení
 *    týdne. Dva chybějící jmenovatele server neposílá → rekonstruují se (viz DERIVE).
 *    ISO týdny, začátek pondělí — shodně s `?action=weekly` (api.php: iso_week_start()).
 *
 * ⚠️ WHITELIST METRIK NENÍ HARDCODED. api.php ho publikuje v `?action=config` jako
 *    `timeseries: { rings:{metrics,splits,default_split}, earrings:{...} }`. FE metrika
 *    má SEZNAM KANDIDÁTNÍCH klíčů a vybere první, kterému server rozumí:
 *       CPA        → 'cpa'          → fallback 'cps'   (SPEC §1: cps = Lookerova CPA)
 *       Rezervace  → 'reservations' → fallback 'bookings'
 *       Tržba z leadů (dopočtená) → 'revenue_model'    (bez fallbacku)
 *    Co server neumí, se v UI NEZOBRAZÍ (místo HTTP 400 / tiché lži). Když config
 *    whitelist nepošle (starší build, mock), jede statický fallback = první kandidát.
 *
 * Vlastnosti (SPEC + FEEDBACK-1 + FEEDBACK-2 + FEEDBACK-3):
 *   - D2: přepínač Den/Týden nad grafem, DEFAULT = Týden (viz blok výš).
 *   - E1/E2/E3 (FEEDBACK-3): dataZoom JE PRYČ — celý, X i Y, inside i slider.
 *         Filip: „scroll se chová divně", „to už je moc halušek", „musíš to zjednodušit".
 *         Místo něj přepínač VÝŠKY grafu (Nízký / Normální / Vysoký). Rozbor v sekci 0d.
 *   - D3: osa se ořízne na SKUTEČNÝ rozsah dat tabu (náušnice mají ~14 dní historie,
 *         při 60 dnech se jinak kreslí měsíc prázdna) + popisek „data od DD.MM.".
 *   - D1/D4: série se spendem < 1 % spendu okna se u poměrových metrik skrývají
 *         (ROAS 200 na 500 Kč spendu plácne graf na nulu) — VŽDY je to napsané pod
 *         grafem + přepínač „zobrazit i malé série". Když i tak osa ustřelí, ořízne se
 *         na p95 — taky VŽDY napsané + zrušitelné. Nikdy netiše: skrytá série je
 *         vyjmenovaná, ořez očíslovaný.
 *   - F2: legenda vpravo svisle (scroll) s ellipsis + tooltipem s plným názvem;
 *         na úzkém plátně dole (scroll) s REZERVOVANÝM místem v gridu → nikdy přes osu.
 *   - F3: metriky ROAS real / ROAS model / tržba z leadů / CPL / CPA / leady / rezervace.
 *   - Osa Y VŽDY START od 0 — kritické. Po odstranění dataZoomu to zase drží NATIVNĚ
 *     `min:0` na ose (dřív to musel suplovat `startValue:0` počátečního okna zoomu,
 *     protože pevné min/max osu se zoomem zamkne). Jednodušší i správnější.
 *   - A1/A4 (FEEDBACK-3) — ZRALOST = kolik % tržby je REÁLNÉ vs. dopočtené.
 *     NENÍ to stáří dat! Časová zralost (RIPE_WEEKS/MATURITY_CURVE) je ZAHOZENÁ. Viz 0c.
 *   - C3 (FEEDBACK-3) — referenční linka NENÍ 1,0, ale break-even PER FUNNEL
 *     (snubní 2,0 · zásnubní 1,5). Viz sekce 0e.
 *   - Resize: ResizeObserver + IntersectionObserver + window.resize + <details> toggle
 *     + transitionend(max-height|height) → sbalená sekce (C3) se po rozbalení přeměří.
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------- 0) registry metrik a splitů ---------------------------------- */

  /* D2 — AGREGAČNÍ PŘEDPIS pro týdenní režim.
   * `sum`   = aditivní metrika → týden = prostý součet dnů.
   * `ratio` = poměrová metrika → týden = Σčitatel / Σjmenovatel (NIKDY průměr denních poměrů).
   *
   * Komponenty se tahají ze `?action=timeseries` jako samostatné metriky. Dvě ale server
   * jako metriku vůbec neposílá, takže se REKONSTRUUJÍ z dvojice, co posílá (DERIVE):
   *   bookings_eff (prsteny, jmenovatel CPA) = spend_den / cpa_den   [cpa = spend/bookings_eff]
   *   created      (náušnice, čitatel ROAS celkem) = roas_created_den × spend_den
   * Zaokrouhlení serveru (cpa na celé Kč, roas na 2 des.) dělá relativní chybu řádu 0,0x %
   * — o dva řády míň než rozdíl, kvůli kterému se tohle celé dělá. Když je cpa_den = 0
   * (den se spendem a bez rezervace), bookings_eff_den = 0, ale spend zůstává v čitateli
   * → týdenní CPA správně naroste. To je ta pointa, ne edge case.
   */
  var SUM = function (comp) { return { type: 'sum', num: comp }; };
  var RATIO = function (num, den) { return { type: 'ratio', num: num, den: den }; };
  var K = function (/* …kandidátní klíče */) { return { keys: [].slice.call(arguments) }; };
  var DERIVE = function (op, a, b) { return { derive: op, a: a, b: b }; };

  // `keys` = kandidátní klíče pro api.php (první, který server zná, vyhraje).
  // `kind` řídí formát hodnot, referenční linky i ochranu osy.
  // `hint` = title tooltip na tlačítku (Filip chce u dopočtu vidět vzorec — FEEDBACK E1).
  // `agg`  = jak se metrika skládá do týdne (D2).
  var RINGS_METRICS = [
    { id: 'spend',         label: 'Spend',          kind: 'money', keys: ['spend'],
      agg: SUM(K('spend')),
      hint: 'Útrata z Meta API (CZK).' },
    { id: 'roas_real',     label: 'ROAS real',    kind: 'roas',  keys: ['roas_real'], revenueBased: true,
      agg: RATIO(K('revenue'), K('spend')),
      hint: 'Skutečné peníze: realizovaná tržba / spend.' },
    { id: 'roas_model',    label: 'ROAS model',     kind: 'roas',  keys: ['roas_model'], revenueBased: true,
      agg: RATIO(K('revenue_model'), K('spend')),
      hint: 'Lookerův ROAS = tržba celkem / spend. Prahy (winner/kill) jsou kotvené sem.' },
    { id: 'revenue_model', label: 'Tržba z leadů',  kind: 'money', keys: ['revenue_model'], revenueBased: true,
      agg: SUM(K('revenue_model')),
      hint: 'Dopočtená tržba = Lookerova „Tržba celkem" = tržba / % provolaných / % proběhlých schůzek. '
          + 'Počítá se na DENNÍM řádku a teprve pak se sčítá — není to fixní násobek.' },
    { id: 'cpl',           label: 'CPL',            kind: 'cost',  keys: ['cpl'],
      agg: RATIO(K('spend'), K('leads')),
      hint: 'Cena za lead = spend / počet leadů (Lookerův jmenovatel = počet řádků).' },
    { id: 'cpa',           label: 'CPA',            kind: 'cost',  keys: ['cpa', 'cps'],
      // jmenovatel bookings_eff server jako metriku neposílá → rekonstrukce spend/cpa (viz DERIVE)
      agg: RATIO(K('spend'), DERIVE('div', K('spend'), K('cpa', 'cps'))),
      hint: 'Cena za schůzku (Lookerova CPA) = spend / (rezervace × % provolaných).' },
    { id: 'leads',         label: 'Leady',          kind: 'count', keys: ['leads'],
      agg: SUM(K('leads')),
      hint: 'Počet leadů (řádků).' },
    { id: 'reservations',  label: 'Rezervace',      kind: 'count', keys: ['reservations', 'bookings'],
      agg: SUM(K('reservations', 'bookings')),
      hint: 'Vytvořené rezervace (schůzky).' }
  ];

  // Náušnice: bez funnelů/eventů (SPEC §0C). leads = poptávky, rezervace = jmenovatel CPA
  // (FEEDBACK K1: „CPL nezajímá → CPA = cena za rezervaci").
  var EARRINGS_METRICS = [
    { id: 'spend',        label: 'Spend',          kind: 'money', keys: ['spend'],
      agg: SUM(K('spend')),
      hint: 'Útrata z Meta API (CZK).' },
    { id: 'roas_real',    label: 'ROAS zaplaceno', kind: 'roas',  keys: ['roas_real'], revenueBased: true,
      agg: RATIO(K('revenue'), K('spend')),
      hint: 'Zaplacená tržba / spend.' },
    { id: 'roas_created', label: 'ROAS celkem',    kind: 'roas',  keys: ['roas_created'], revenueBased: true,
      // čitatel „created" server jako metriku neposílá → rekonstrukce roas_created × spend
      agg: RATIO(DERIVE('mul', K('roas_created'), K('spend')), K('spend')),
      hint: 'Tržba vytvořených objednávek (celkem) / spend.' },
    // Náušnice: ŽÁDNÝ modelový dopočet (Filip 18. 7.) — jen zaplaceno + celkem.
    { id: 'revenue',      label: 'Tržba zaplaceno', kind: 'money', keys: ['revenue'], revenueBased: true,
      agg: SUM(K('revenue')),
      hint: 'Zaplacená tržba (CZK).' },
    { id: 'revenue_created', label: 'Tržba celkem', kind: 'money', keys: ['roas_created'], revenueBased: true,
      // revenue_created server jako metriku neposílá → rekonstrukce roas_created × spend
      agg: SUM(DERIVE('mul', K('roas_created'), K('spend'))),
      hint: 'Tržba vytvořených objednávek (celkem, CZK).' },
    { id: 'cpa',          label: 'CPA',            kind: 'cost',  keys: ['cpa'],
      agg: RATIO(K('spend'), K('reservations', 'bookings')),
      hint: 'Cena za rezervaci = spend / rezervace (dle Lookeru — FEEDBACK K1).' },
    { id: 'leads',        label: 'Poptávky',       kind: 'count', keys: ['leads'],
      agg: SUM(K('leads')),
      hint: 'Počet poptávek.' },
    { id: 'reservations', label: 'Rezervace',      kind: 'count', keys: ['reservations', 'bookings'],
      agg: SUM(K('reservations', 'bookings')),
      hint: 'Počet rezervací (1 poptávka může být víc párů).' }
  ];

  var RINGS_SPLITS = [
    { key: 'funnel',       label: 'Funnel' },
    { key: 'event',        label: 'Event' },
    { key: 'optimization', label: 'Optimalizace' }
  ];
  /* F7-2/MM — REŽIM „VÍC METRIK NAJEDNOU" (Filip 23. 7.):
   * „vpravo bych si spíš zaškrtával ty metriky, jak je spend, ROAS, real ROAS, model,
   *  tržba z leadů, CPL, CPA a tak dále (…) abych viděl, jak běží všechny tyto metriky.
   *  A ty funnely bych nechtěl mít vpravo na té legendě, ale nahoře, na výběr."
   * Otočí to graf naruby: doteď byla JEDNA metrika × N funnelů (funnely v legendě),
   * teď je N METRIK × vybrané funnely (metriky v legendě, funnely chipy nahoře).
   * Není to další „split" na serveru — server o něm neví, skládá se to na klientovi
   * z týchž komponent, ze kterých se počítá týdenní/měsíční agregace. */
  var SPLIT_MULTI = { key: 'metrics', label: '⧉ Víc metrik' };
  var EARRINGS_SPLIT = 'creative'; // fixně; UI ukáže „Top kreativy"

  // D1/D4 — práh „mizivého spendu": série pod ním se u POMĚROVÝCH metrik (ROAS/CPL/CPA)
  // defaultně skrývají. Poměr s mrňavým jmenovatelem ustřeluje do stovek a plácne
  // zbytek grafu na nulu.
  //
  // ⚠️ FEEDBACK-2: práh je teď ČISTĚ 1 % spendu okna (Filip: „skryj série se spendem
  // < 1 % totálu okna"). Dřív tu byla i absolutní podlaha 5 000 Kč přes max() — a ta
  // byla na náušnicovém tabu ZLÁ: celý tab má za 30 dní ~42 500 Kč spendu, takže
  // 5 000 Kč = 11,8 % totálu → filtr by kosil i seriózní kreativy. Na prstenech
  // (30d ≈ 1,35 M) stejně vždycky vyhrálo těch 1 % (13 500) → podlaha nikdy nic
  // neřešila a jen tiše rozbíjela menší tab. Pryč s ní.
  var SMALL_SPEND_PCT = 0.01;   // 1 % spendu okna
  // F1 — ořez osy se spustí, jen když tím fakt něco získáme: maximum musí přebít
  // strop (p95) aspoň o tolik, aby se uvolnila znatelná část plátna. Není to
  // „bezpečnostní" násobitel nad p95 (ten dělal graf plochý — viz clipInfo), ale
  // podmínka „vyplatí se ořez vůbec kreslit". Ověřeno naostro 16.7.:
  //   ROAS model / split=funnel / 30d: p95 13,33 · max 31,62 → 2,34× stropu → OŘEŽ (uvolní 57 % osy)
  //   týdenní graf:                    p95 10,20 · max 10,71 → 1,02× stropu → NEOŘEZÁVAT
  //     (jinak by ořez usekl špičky dopočtené série 10,67/10,71 — a přesně ty jsou ten důkaz,
  //      že poslední týdny nejsou propad. Ořez signálu = stejná lež jako plochý graf.)
  var CLIP_GAIN_MIN   = 1.25;
  // F4 — kolik týdnů zpět kreslí týdenní graf.
  var WEEKLY_WEEKS    = 18;

  /* ---------- 0b) D2 — granularita ----------------------------------------- */
  // Filipův nápad, a je správný: denní řada je u ROAS/CPL šum (jeden den = pár leadů),
  // týden ty ústřely vyhladí, aniž by cokoli zamlčel. Proto DEFAULT = 'week'.
  var GRAN_DEFAULT = 'week';
  // G1 (Filip): „Den, týden, měsíc bych tam dal — ať tam je i měsícová varianta."
  // Server `granularity` umí day|week|month (api.php: trend_bucket_key()).
  var GRANS = [{ key: 'day', label: 'Den' }, { key: 'week', label: 'Týden' }, { key: 'month', label: 'Měsíc' }];

  /* ---------- 0c) A1/A4 — ZRALOST (FEEDBACK-3; PŘEPSANÝ KONCEPT) ------------
   * 🔴 DOSAVADNÍ ZRALOST BYLA KONCEPČNĚ ŠPATNĚ. Byla to ČASOVÁ veličina (stáří dat,
   *    MATURITY_CURVE, „posledních 14 dní"). Filip ji 16. 7. přebil a má pravdu:
   *
   *      ZRALOST = kolik % tržby je REÁLNÉ. Zbytek je dopočet.
   *      zralost = pct_call × pct_schuzek
   *
   *    Filipův příklad: 100 leadů → provoláno 50 % → z nich 10 schůzek → proběhne 50 %
   *    → tržba je na 25 % reálná; dopočet ji dělí 0,5 a pak 0,5.
   *    Je to PŘESNĚ PŘEVRÁCENÁ HODNOTA Lookerova dopočtu:
   *      revenue_model = revenue_real / pct_schuzek / pct_call
   *      → revenue_real / revenue_model = pct_call × pct_schuzek = ZRALOST
   *
   *    Filip: „Pak tu zralost nemusím brát pro výpočet, ale jenom informativně, abych
   *    věděl, na kolik procent je to dopočtené — je rozdíl, když je dopočteno z 25 %
   *    nebo z 90 %." → Dopočet zralost UŽ ŘEŠÍ ve výpočtu. Tohle je INDIKÁTOR DŮVĚRY.
   *
   * ⚠️⚠️ POČÍTÁME JI JAKO Σrevenue_real / Σrevenue_model, NE JAKO pct_call × pct_schuzek
   *    Z AGREGÁTU OKNA. Nejsou to totéž a ten druhý ZPŮSOB LŽE. Proč (ověřeno naostro
   *    16. 7. na `?action=creatives`):
   *      • Dopočet se aplikuje na DENNÍM ŘÁDKU grainu datum × kreativa × funnel × event
   *        (SPEC §1) — každý řádek má vlastní pct_call/pct_schuzek a vlastní revenue_model.
   *      • pct_call/pct_schuzek, co API vrací za OKNO, jsou agregáty (Σcalled/Σleads).
   *        Jejich součin NENÍ podíl reálné tržby, protože tržba je mezi řádky rozložená
   *        nerovnoměrně.
   *      • DŮKAZ (P-287-001, 30 d): pct_call 0,8733 × pct_schuzek 0,2917 = 25,5 % → ČERVENÁ.
   *        Jenže revenue_real 44 680 / revenue_model 89 360 = přesně 50,0 % → ŽLUTÁ.
   *        Model je 2× reálná tržba, takže polovina JE reálná. „25 %" by Filipovi tvrdilo,
   *        že jsou reálné jen čtvrtina peněz — faktická lež o čísle, na které kouká.
   *      • Naopak na homogenním vzorku (1 den, 1 řádek) oba způsoby sedí na 4 desetinná
   *        místa (P-873-001, P-287-001: 1,0000 vs 1,0000) → je to opravdu táž veličina,
   *        jen správně vážená.
   *    Σreal/Σmodel = tržbou vážený průměr denních (pct_call × pct_schuzek) = přesně
   *    „kolik % z TOHOHLE dopočteného čísla jsou reálné peníze". To je ta Filipova otázka.
   *
   * ⚠️ NÁUŠNICE: nemají schůzku → pct_schuzek je v API null a dopočet je jen /call_rate
   *    (revenue_model = revenue_created / call_rate). Σreal/Σmodel u nich vyjde
   *    (paid/created) × call_rate, tj. do zralosti se přimíchá i „kolik vytvořených
   *    objednávek je zaplacených". Necháváme to tak SCHVÁLNĚ: otázka zní „kolik % z toho
   *    ROAS modelu jsou peníze na účtě" a tohle je na ni pravdivá odpověď. Jen to není
   *    dekompozice na dvě míry jako u prstenů. → viz report notes_for_integrator.
   * ---------------------------------------------------------------------- */

  // A3 — barvy zralosti. Hranice dle Filipa: <25 č · 25–50 o · 50–75 ž · >75 z.
  // (75 % přesně padá do „50–75" = žlutá; „>75" je ostrá nerovnost.)
  var MAT_RED    = '#c0563e';
  var MAT_ORANGE = '#d9822b';
  var MAT_YELLOW = '#c9a227';
  var MAT_GREEN  = '#3f9d6b';

  /** Zralost z tržeb. null = NEVÍME (chybí data / není tržba → otázka nemá smysl).
   *
   * ⚠️ CHYBĚJÍCÍ tržba (null) a NULOVÁ tržba (0) NEJSOU totéž a nesmí splynout:
   *    • real = null (díra v řadě)  → null → tooltip „—", šedý kroužek. Nevíme.
   *    • real = 0, model > 0        → 0 % → ČERVENÁ. To je pravda: z dopočteného
   *      čísla nejsou reálné žádné peníze. (U náušnic reálný stav: vytvořené
   *      objednávky jsou, zaplacené nula.)
   *    `Number(null)` je 0, takže bez téhle stráže by díra tiše vypadala jako
   *    „0 % reálné, červená" = vymyšlený poplach. Chyceno unit testem. */
  function maturityOf(real, model) {
    if (real == null || real === '' || model == null || model === '') return null;
    var r = Number(real), m = Number(model);
    if (!isFinite(r) || !isFinite(m) || !(m > 0)) return null;
    var v = r / m;
    if (!isFinite(v) || v < 0) return null;
    return v > 1 ? 1 : v;         // model < real umí nastat zaokrouhlením → cap na 100 %
  }
  function matColor(m) {
    if (m == null) return MUTED;
    if (m > 0.75) return MAT_GREEN;
    if (m >= 0.50) return MAT_YELLOW;
    if (m >= 0.25) return MAT_ORANGE;
    return MAT_RED;
  }
  function matPct(m) { return m == null ? '—' : (Math.round(m * 100) + ' %'); }
  // Kroužek v barvě zralosti do tooltipu (A3 „barevný kroužek / progress").
  function matDot(m) {
    return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
           'border:2px solid ' + matColor(m) + ';background:' +
           (m == null ? 'transparent' : hexA(matColor(m), 0.35)) + ';vertical-align:-1px"></span>';
  }
  // Pod touhle zralostí je dopočet tak divoký, že jednou objednávkou zamává
  // → tooltip u něj řekne „ber jako indicii, ne jako číslo". Sedí na hranici A3 (červená).
  var MAT_TOO_FRESH = 0.25;
  // Šrafování/zvýraznění bodu: pod 50 % je víc než půlka čísla dopočet (červená+oranžová).
  var MAT_HATCH_BELOW = 0.50;

  // Je metrika odvozená od TRŽBY? Jen u těch má zralost smysl — spend a leady žádný dopočet
  // nemají, jsou naměřené.
  // ⚠️ Příznak se dřív jmenoval `ripens` („dozrává v čase"). PŘEJMENOVÁNO SCHVÁLNĚ na
  //    `revenueBased`: časové dozrávání je zahozený koncept (0c) a starý název by sváděl
  //    příštího čtenáře k tomu ho oživit. Metriky jsou tytéž, význam příznaku je jiný.
  function metricRevenueBased(md) { return !!(md && md.revenueBased); }

  /* ---------- 0d) E1/E2/E3 — VÝŠKA GRAFU MÍSTO dataZOOMU -------------------
   * Filip (FEEDBACK-3): „tady s tím grafem se fakt pracuje špatně, musíš to zjednodušit",
   * „scroll se chová divně", „vertikální zoom — to už je moc halušek",
   * „horizontálně nechci scroll, ale tlačítko, který graf smrskne na výšku".
   *
   * ROZHODNUTÍ: dataZoom je PRYČ CELÝ — osa Y i osa X, `inside` i `slider`. Ne jen Y.
   * Zdůvodnění (proč i X, když zadání říkalo „X zvaž"):
   *   1) „Scroll se chová divně" JE ten X `inside` zoom: měl `zoomOnMouseWheel:true`,
   *      takže kolečko nad grafem NEskrolovalo stránku, ale zoomovalo graf. Uživatel
   *      chce projet stránku, místo toho mu ujede osa. Přesně ta stížnost. Y `inside`
   *      měl kolečko vypnuté, takže vinu nesl X.
   *   2) X zoom je REDUNDANTNÍ — rozsah X už řídí picker období (7/14/30/60/90/120/180
   *      + vlastní od–do) a D3 ořez na reálný rozsah dat. Dvoje ovládání téhož = zmatek.
   *   3) Ubyly tím 4 dataZoom komponenty + 2 slidery přes plátno + tlačítko „Reset zoom"
   *      = 7 prvků pryč, přibyl 1 (výška). „Méně prvků, ne víc" splněno.
   *   4) BONUS: osa Y může zpátky na nativní `min:0`. S dataZoomem to nešlo (pevné min
   *      přebije zoom → osa by šla zamknutá), takže nulu suplovalo počáteční okno
   *      `startValue:0`. Míň kódu, míň chyb, SPEC §5 „osa Y vždy od 0" drží nativně.
   *
   * Default = 'mid' (dosavadní výška). Volba se pamatuje v localStorage — je to čistě
   * kosmetika jednoho uživatele na jednom stroji, nemá cenu na to pálit serverové prefs.
   */
  var HEIGHTS = [
    { key: 'low',  label: 'Nízký',    hint: 'Smrskne graf na výšku — ať se vejde víc na obrazovku.' },
    { key: 'mid',  label: 'Normální', hint: 'Výchozí výška grafu.' },
    { key: 'high', label: 'Vysoký',   hint: 'Roztáhne graf — na detailní čtení blízkých hodnot.' }
  ];
  var HEIGHT_DEFAULT = 'mid';
  var HEIGHT_LS_KEY  = 'ads.charts.height';

  function loadHeight() {
    try {
      var v = window.localStorage.getItem(HEIGHT_LS_KEY);
      for (var i = 0; i < HEIGHTS.length; i++) if (HEIGHTS[i].key === v) return v;
    } catch (e) { /* private mode → default */ }
    return HEIGHT_DEFAULT;
  }
  function saveHeight(v) {
    try { window.localStorage.setItem(HEIGHT_LS_KEY, v); } catch (e) { /* noop */ }
  }

  /* ---------- 0e) C3 — BREAK-EVEN: PLOŠNĚ 2,0 (JEDNA LINKA) ----------------
   * ⚠️ PŘEPSÁNO 16. 7. (iterace 4/5). Filip: „Break-even bych dal plošně pro všechno,
   *    protože jinak u zásnubních/snubních mít dvě linie je blbý. Nechme dva pro všechno."
   *    → JEDNA linka 2,0 ve VŠECH grafech, pro VŠECHNY funnely i pro NÁUŠNICE.
   *    (Dřív tu bylo per-funnel snubní 2,0 / zásnubní 1,5 → dvě linky v jednom grafu.)
   *
   * Zdroj pravdy = `?action=config` → `breakeven`. Ověřeno naostro 16. 7.:
   *   { default: 2, flat: true, funnels: { „Snubní 30K":2, …, „Náušnice":2 }, note:"…" }
   * `flat: true` je EXPLICITNÍ pokyn serveru „nevětvit linku podle funnelu".
   *
   * ⚠️ POZOR NA PAST, KTERÁ TU BYLA: fallback se „zploštil" na PRÁZDNOU mapu `{}`.
   *    Jenže prázdná mapa neznamená „2,0 plošně", znamená „o žádném funnelu nic nevím"
   *    → breakevenFor() vracelo null → NEKRESLILA SE ŽÁDNÁ LINKA a patička psala
   *    „break-even linka není". Když tedy config nedorazí (nebo se čte dřív, než
   *    doběhne), Filip nevidí linku vůbec. Fallback proto MUSÍ nést default 2,0.
   *
   * `flat` bereme i implicitně: když mají všechny známé funnely stejnou hodnotu,
   * je to plochý break-even, ať už si server příznak pošle nebo ne.
   */
  var BREAKEVEN_DEFAULT_FALLBACK = 2.0;  /* Filip 16.7.: plošně 2,0 pro VŠECHNO (i náušnice) */
  var BREAKEVEN_FALLBACK = { }           /* per-funnel výjimky: ŽÁDNÉ (mechanika žije, mapa je prázdná) */;
  var _beMap = null;
  var _beFlat = null;   // {flat:bool, value:číslo} — cache verdiktu „jedna plošná linka"

  function beVal(x) {
    if (x == null) return null;
    if (typeof x === 'object') {
      var cand = [x.value, x.breakeven, x.roas, x.safe, x.roas_model];
      for (var i = 0; i < cand.length; i++) {
        var n0 = Number(cand[i]);
        if (cand[i] != null && isFinite(n0) && n0 > 0) return n0;
      }
      return null;
    }
    var n = Number(x);
    return (isFinite(n) && n > 0) ? n : null;
  }
  /* Zdroj configu: `_cfgRaw` plní ensureAllowed() ze SVÉHO `?action=config` fetche
   * (charts.js si config tahá sám kvůli whitelistu metrik — `breakeven` sebereme při tom).
   * app.js `breakeven` do window.ADS nepropisuje a app.js NENÍ můj soubor → nespoléhám
   * na to, že to někdo doplní. ADS.BREAKEVEN se čte jen jako bonus, kdyby ho app.js
   * časem začal vystavovat. */
  function breakevenMap() {
    if (_beMap) return _beMap;
    var A = window.ADS || {};
    var raw = (_cfgRaw && _cfgRaw.breakeven != null) ? _cfgRaw.breakeven
            : (A.BREAKEVEN != null ? A.BREAKEVEN : (A.CONFIG && A.CONFIG.breakeven));
    var out = {};
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var f = raw[i] && (raw[i].funnel || raw[i].name);
        var v = beVal(raw[i]);
        if (f && v) out[String(f)] = v;
      }
    } else if (raw && typeof raw === 'object') {
      var src = (raw.funnels && typeof raw.funnels === 'object') ? raw.funnels : raw;
      Object.keys(src).forEach(function (k) {
        var v = beVal(src[k]);
        if (v) out[k] = v;
      });
    }
    if (!Object.keys(out).length) {
      out = Object.assign({}, BREAKEVEN_FALLBACK);
      console.info('[charts] config.breakeven ze serveru nedorazil → break-even jede na ' +
                   'plošném defaultu ' + BREAKEVEN_DEFAULT_FALLBACK + '. Až api.php `breakeven` ' +
                   'vystaví, přebije tenhle default automaticky.');
      // NECACHOVAT: config ještě nemusel dorazit. Jakmile dorazí, chceme jeho hodnoty,
      // ne zabetonovaný fallback z prvního (předčasného) volání.
      if (!_cfgRaw) return out;
    }
    _beMap = out;
    return _beMap;
  }
  /** C3 — plošná hodnota break-evenu (default ze serveru, jinak 2,0). */
  function breakevenDefault() {
    var raw = _cfgRaw && _cfgRaw.breakeven;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      var v = beVal(raw.default != null ? raw.default : raw._default);
      if (v) return v;
    }
    return BREAKEVEN_DEFAULT_FALLBACK;
  }
  /** C3 — „kreslí se JEDNA plošná linka?" → {flat, value}.
   *  flat = server řekl `flat:true` NEBO všechny známé funnely mají stejnou hodnotu
   *         NEBo o žádném funnelu nevíme nic (prázdná mapa → jede se na defaultu).
   *  Filip: „dvě linie v jednom grafu je blbý." → dokud jsou všechny hodnoty stejné,
   *  nemá cenu linku větvit ani ji vázat na kontext funnelu (a tím ji občas ztratit). */
  function breakevenFlat() {
    // Necachuj, dokud nedorazil config — jinak by se zabetonoval předčasný verdikt.
    if (_beFlat && _cfgRaw) return _beFlat;
    var raw = _cfgRaw && _cfgRaw.breakeven;
    var def = breakevenDefault();
    var map = breakevenMap();
    var vals = Object.keys(map).map(function (k) { return map[k]; }).filter(function (v) { return v > 0; });

    var flat, value;
    if (raw && typeof raw === 'object' && raw.flat === true) {
      flat = true;  value = def;
    } else if (!vals.length) {
      flat = true;  value = def;                       // nic nevíme → plošný default
    } else {
      var uniq = vals.filter(function (v, i) { return vals.indexOf(v) === i; });
      flat = (uniq.length === 1);
      value = flat ? uniq[0] : null;
    }
    var out = { flat: flat, value: value };
    if (_cfgRaw) _beFlat = out;
    return out;
  }
  /** Break-even pro název funnelu. Tolerantní na diakritiku/velikost/podnázvy funnelu
   *  („Zásnubní: 7 horor chyb ebook" je pořád zásnubní funnel — ověřeno v config.sample.php
   *  u PREFIX_FUNNEL_MAP, kde je to explicitně zdokumentované jako zásnubní). */
  function breakevenFor(funnel) {
    // C3 (16. 7.): plošný break-even → hodnota NEZÁVISÍ na funnelu. Vracíme ji i pro
    // neznámý/prázdný funnel — jinak by kreativa bez funnelu (`---`) nebo náušnice
    // o linku přišly, přestože pro ně 2,0 platí taky (config: „Náušnice" => 2).
    var fl = breakevenFlat();
    if (fl.flat && fl.value) return fl.value;
    if (!funnel) return null;
    var map = breakevenMap();
    if (map[funnel] != null) return map[funnel];
    var n = String(funnel).toLowerCase();
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (n === keys[i].toLowerCase()) return map[keys[i]];
    }
    // fuzzy: „zásnub…" / „snubní…" — POŘADÍ ZÁLEŽÍ, „zásnubní" obsahuje „snubní"!
    if (n.indexOf('zásnub') > -1 || n.indexOf('zasnub') > -1) {
      for (var z = 0; z < keys.length; z++) if (/z[áa]snub/i.test(keys[z])) return map[keys[z]];
    } else if (n.indexOf('snubní') > -1 || n.indexOf('snubni') > -1) {
      for (var s = 0; s < keys.length; s++) if (/^snubn/i.test(keys[s])) return map[keys[s]];
    }
    return null;
  }
  /** Popisek linky. V plošném režimu BEZ jména funnelu — „break-even 2×" a hotovo.
   *  (Dřív „break-even snubní 2×" — jenže když platí pro všechno, je jméno funnelu
   *  v popisku matoucí: čte se to, jako by pro ostatní funnely platilo něco jiného.) */
  function beLabel(funnel, v) {
    var fl = breakevenFlat();
    if (fl.flat) return 'break-even ' + axisLabel(v, 'roas');
    var short = String(funnel || '').replace(/\s*\d+K.*$/, '').trim() || funnel;
    return 'break-even ' + short.toLowerCase() + ' ' + axisLabel(v, 'roas');
  }

  /* ---------- 1) paleta / barvy -------------------------------------------- */

  /* T12 (FEEDBACK-6) — TEXT V GRAFECH ZTMAVEN o ~20 %. Filip: „názvy kreativ v tom grafu,
   * to záhlaví v tom grafu… bych to trošku stmavil to písmo, ať se to dobře čte."
   * Ztmavené jsou JEN barvy TEXTU (INK = nadpisy/tooltip, MUTED = osy, legenda, patička).
   * GRID/AXIS (linky) zůstávají světlé schválně — kdyby ztmavly, mřížka začne přebíjet data.
   * Sémantické barvy (MAT_*, REF_*) se nesahají: nesou význam, ne čitelnost.
   *   INK    #3a352e → #2e2a25   (kanály × 0,8)
   *   MUTED  #8c857a → #706a61   (kanály × 0,8) — kontrast na krému #fffdf9 stoupl 4,4:1 → 6,3:1 */
  var INK   = '#2e2a25';
  var MUTED = '#706a61';
  var GRID  = '#eceae4';
  var AXIS  = '#ddd7cd';
  var CARD_BG = '#fffdf9';

  var REF_BREAKEVEN = '#c0563e'; // 1,0 (warm red)
  var REF_WINNER    = '#3f9d6b'; // WINNER_ROAS (green)
  var EST_LINE      = '#b3a78f'; // hranice estimating (warm gray)
  var EST_BAND      = 'rgba(179, 167, 143, 0.10)';
  // Pás pod BĚŽÍCÍM (nedojetým) týdnem. ⚠️ Dřív se jmenoval RIPE_BAND — přejmenováno
  // schválně: „ripeness"/časová zralost je ZRUŠENÝ koncept (A2) a starý název sváděl
  // příštího čtenáře k tomu ho oživit. S dozráváním tržby tenhle pás nemá nic společného.
  var INCOMPLETE_BAND = 'rgba(179, 167, 143, 0.14)';

  /* G5 — Filip: „ty barvičky, který tam používáš, jsou málo odlišitelný… možná to je tím,
   * jak je tam hodně variant." Přesně tak: stará paleta měla TŘI podobné modré
   * (#3b6fb0 · #4b9cc9 · #5c8fa8) a dvě podobné růžové (#c96b8e · #b0587f) — na 9–11 sériích
   * se to slilo. Tahle je kvalitativní: sousední položky se liší ODSTÍNEM i SVĚTLOSTÍ,
   * takže je rozezná i ten, kdo je barvoslepý na červeno-zelenou. Řazeno tak, aby první
   * použité byly co nejdál od sebe. */
  var PALETTE = [
    '#2f6fb5', '#e07b39', '#3f9e6b', '#c2426b', '#7d5ba6',
    '#8a6a3d', '#d9a521', '#4bb3c4', '#a03535', '#5b7030',
    '#b268a8', '#37806e'
  ];
  /* T13 — barvy funnelů dle Filipa (17. 7.). MUSÍ sedět s pilulkami v tabulce:
   *   snubní 30K = modrá · 100K = ČERNÁ · Maledivy = žlutá · zásnubní 49K = hnědá
   *   šaty = červenorůžová · 100K „funýlky" (fotosoutěž, dotazník…) = FIALOVÁ
   * Filip doslova: „ne, hovno — ty 100k jakoby fanýlky, to znamená ne přímo 100k, ale je to
   * fotosoutěž, dotazník atd., tak ty budou fialový, ať se to líp rozeznává."
   * ⚠️ POŘADÍ TESTŮ: „100K Fotosoutěž" obsahuje i „100k" → funýlky se MUSÍ testovat DŘÍV
   *    než holé 100K, jinak by zčernaly taky. */
  // T13 — barvy čar dle rodiny funnelu. KLASIFIKACE je sdílená s tabulkou (ADS.funnelKind),
  // jinak se pilulka v tabulce a čára v grafu můžou u 100K funýlků rozejít. Tady je jen
  // mapa kind → sytá barva čáry (pilulky v tabulce mají světlejší varianty téže rodiny).
  var FUNNEL_LINE_COLOR = {
    snubni:  '#2f6fb5',   // modrá
    zasnubni:'#8a5a3c',   // hnědá
    maledivy:'#d9a521',   // žlutá
    saty:    '#c2426b',   // červenorůžová
    f100:    '#2b2b2b',   // 100K napřímo — černá
    f100soft:'#7d5ba6'    // 100K funýlky (fotosoutěž/dotazník) — fialová
  };
  function brandColor(name) {
    // Vždy přes sdílený klasifikátor (tables.js). Kdyby náhodou nebyl (jiné pořadí načtení),
    // radši spadneme na paletu než na rozcházející se lokální pravidlo.
    if (window.ADS && typeof window.ADS.funnelKind === 'function') {
      return FUNNEL_LINE_COLOR[window.ADS.funnelKind(name)] || null;
    }
    return null;
  }
  /** Posun odstínu o `amt` (−1…+1: záporné tmavší, kladné světlejší). Drží se v rodině
   *  barvy — jen ji rozsvítí/ztlumí, takže „100K" a „100K Fotosoutěž" zůstanou příbuzné,
   *  ale rozeznatelné. */
  function shade(hex, amt) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = parseInt(h.substr(i * 2, 2), 16);
      v = amt >= 0 ? Math.round(v + (255 - v) * amt) : Math.round(v * (1 + amt));
      v = Math.max(0, Math.min(255, v));
      out += ('0' + v.toString(16)).slice(-2);
    }
    return out;
  }

  var _colorMap = Object.create(null);
  var _usedColors = Object.create(null);   // barva → jméno, které si ji vzalo první
  var _paletteCursor = 0;

  /* ⚠️ KOLIZE BAREV — CHYCENO PROKLIKÁNÍM 16. 7. (iterace 5), byla to „rozbitá legenda":
   *    brandColor() matchuje PODŘETĚZCEM, takže na ostrých datech (split=funnel, 30 d)
   *    dostaly TŘI série identickou barvu #6b7a8f a DVĚ identickou #a9714b:
   *      „100K" · „100K Fotosoutěž" · „100K Dotazník - pomozte chlapům"   → všechny stejné
   *      „Zásnubní 49K" · „Zásnubní: Zjistit velikost dotazník"           → obě stejné
   *    5 ze 7 sérií se slilo do 2 barev → v grafu ani v legendě je NELZE rozeznat.
   *    Přesně to, co Filip zakázal („nechci rozbitý legendy").
   *
   * ŘEŠENÍ: barva rodiny zůstává (barvu rodiny nastavit podle NK funnelů), ale KAŽDÁ další
   * série téže rodiny dostane jiný ODSTÍN. Rodina je pořád čitelná na první pohled,
   * jednotlivé funnely jsou rozlišitelné. Nasazovat úplně jinou barvu z palety by
   * konvenci rozbilo („100K Fotosoutěž" zeleně by vypadala jako cizí funnel).
   *
   * Kroky ±: 1. kolize → světlejší o 22 %, 2. → tmavší o 22 %, 3. → světlejší o 42 %…
   * Po vyčerpání (5 variant) se spadne do palety — to už je 6 funnelů jedné rodiny
   * a to se v datech nestává (nejvíc jsou 3× „100K"). */
  var SHADE_STEPS = [0.22, -0.22, 0.42, -0.40, 0.60];

  function colorFor(name) {
    if (_colorMap[name]) return _colorMap[name];
    var b = brandColor(name);
    if (b) {
      var c0 = b;
      // volná? ber. Obsazená jiným jménem → hledej volný odstín téže rodiny.
      for (var s = 0; s <= SHADE_STEPS.length; s++) {
        if (!_usedColors[c0] || _usedColors[c0] === name) {
          _usedColors[c0] = name; _colorMap[name] = c0; return c0;
        }
        if (s === SHADE_STEPS.length) break;
        c0 = shade(b, SHADE_STEPS[s]);
      }
      // 6+ funnelů jedné rodiny → padáme do palety (radši cizí barva než neviditelná série)
      console.info('[charts] barevná rodina „' + b + '" je vyčerpaná pro „' + name + '" → paleta');
    }
    var c = PALETTE[_paletteCursor % PALETTE.length];
    // i paleta se může trefit do obsazené → posuň kurzor, dokud nenajdeš volnou
    for (var g = 0; g < PALETTE.length && _usedColors[c] && _usedColors[c] !== name; g++) {
      _paletteCursor++;
      c = PALETTE[_paletteCursor % PALETTE.length];
    }
    _paletteCursor++;
    _usedColors[c] = name;
    _colorMap[name] = c;
    return c;
  }

  /* ---------- 2) formát (přes ADS.fmt s fallbacky) ------------------------- */

  function FMT() { return (window.ADS && window.ADS.fmt) || {}; }
  // Prahy chodí z api.php (action=config → `thresholds`) VELKÝMI klíči: ROAS_GREEN,
  // WINNER_ROAS, HEALTH_YELLOW… → čteme VELKÁ (malá jen jako defenzivní fallback).
  function TH(keys, fb) {
    var T = (window.ADS && window.ADS.TH) || {};
    for (var i = 0; i < keys.length; i++) { if (T[keys[i]] != null) return T[keys[i]]; }
    return fb;
  }
  // ESTIMATING_DAYS NENÍ v `thresholds` — v api.php sedí na TOP LEVELU configu
  // (`estimating_days`). app.js ho propisuje do ADS.TH.ESTIMATING_DAYS i ADS.ESTIMATING_DAYS.
  function estimatingDays() {
    var A = window.ADS || {};
    var v = TH(['ESTIMATING_DAYS', 'estimating_days'], null);
    if (v == null) v = (A.ESTIMATING_DAYS != null) ? A.ESTIMATING_DAYS : null;
    var n = Number(v);
    return (v != null && isFinite(n) && n >= 0) ? n : 3;
  }
  function winnerRoas() {
    var w = Number(TH(['WINNER_ROAS', 'winner_roas'], 5));
    return isFinite(w) && w > 0 ? w : 5;
  }
  function num(x) { return (x == null || x === '') ? null : Number(x); }

  /* ---------- 2b) ČASOVÁ ZRALOST — ZRUŠENO (A2, FEEDBACK-3) ----------------
   * Tady dřív bydlela časová zralost (MATURITY_CURVE / „tržba dozrává 3 týdny") a
   * poznámka, proč se ZÁMĚRNĚ neptáme serveru na `config.maturity_curve`.
   * Filip ji 16. 7. celou zahodil a nahradil zralostí = podílem reálné tržby (sekce 0c).
   *
   * ⚠️ `ADS.ripeness`, `config.maturity_curve`, `maturity_curves` i `maturity_full_days`
   *    v api.php/app.js POŘÁD EXISTUJÍ (ověřeno na ostrém `?action=config` 16. 7.) —
   *    charts.js je ale NEČTE a číst nesmí: je to jiná veličina než ta, kterou Filip chce,
   *    a smíchat je znamená ukázat dvě různá čísla pod jedním jménem „zralost".
   *    Kill vrstva 4 v api.php na časové zralosti pořád může viset (FEEDBACK-3 A2 to má
   *    jako otevřené rozhodnutí) — to je věc api.php, ne grafů. → notes_for_integrator.
   * ---------------------------------------------------------------------- */
  function asDateStr(v) {
    var s = String(v == null ? '' : v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  }

  function fmtValue(v, kind) {
    if (v == null || isNaN(v)) return '—';
    var f = FMT();
    if (kind === 'roas')  return f.roas  ? f.roas(v)  : (Math.round(v * 100) / 100).toString().replace('.', ',') + '×';
    if (kind === 'count') return f.int   ? f.int(v)   : String(Math.round(v));
    return f.money ? f.money(v) : (Math.round(v) + ' Kč');   // money & cost
  }
  function fmtDate(s) { var f = FMT(); return f.date ? f.date(s) : s; }
  function fmtMoney(v) { var f = FMT(); return f.money ? f.money(v) : (Math.round(Number(v) || 0) + ' Kč'); }

  function axisLabel(v, kind) {
    if (kind === 'roas') return (Math.round(v * 10) / 10).toString().replace('.', ',') + '×';
    if (kind === 'count') return String(Math.round(v));
    var a = Math.abs(v); // money & cost
    if (a >= 1e6) return (Math.round(v / 1e5) / 10).toString().replace('.', ',') + ' M';
    if (a >= 1e3) return Math.round(v / 1e3) + ' k';
    return String(Math.round(v));
  }
  function yAxisName(kind) {
    if (kind === 'roas') return 'ROAS';
    if (kind === 'count') return 'počet';
    return 'CZK';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  // česká shoda: 1 série · 2–4 série · 5+ sérií
  function plSkryto(n) {
    if (n === 1) return 'Skryta 1 série';
    if (n >= 2 && n <= 4) return 'Skryty ' + n + ' série';
    return 'Skryto ' + n + ' sérií';
  }
  function plSerie(n) {
    if (n === 1) return '1 série je';
    if (n >= 2 && n <= 4) return n + ' série jsou';
    return n + ' sérií je';
  }

  /* ---------- 3) whitelist metrik/splitů ZE SERVERU ------------------------ */

  var _allowed = null;         // {rings:{metrics,splits,default_split}, earrings:{...}}
  var _allowedPromise = null;
  var _cfgRaw = null;          // celý `?action=config` — kvůli C3 `breakeven` (viz 0e)

  function ensureAllowed() {
    if (_allowedPromise) return _allowedPromise;
    _allowedPromise = Promise.resolve()
      .then(function () { return window.ADS.api('config'); })
      .then(function (cfg) {
        _cfgRaw = (cfg && cfg.data && typeof cfg.data === 'object' && cfg.data.timeseries) ? cfg.data : cfg;
        var ts = cfg && (cfg.timeseries || (cfg.data && cfg.data.timeseries));
        if (ts && (ts.rings || ts.earrings)) _allowed = ts;
        else console.info('[charts] config.timeseries chybí → whitelist metrik jede na statickém fallbacku');
        return _allowed;
      })
      .catch(function (err) {
        console.warn('[charts] config se nenačetl → statický whitelist metrik', err && err.message);
        return null;
      });
    return _allowedPromise;
  }
  function allowedFor(tab) {
    var a = _allowed && _allowed[tab];
    return (a && Array.isArray(a.metrics)) ? a : null;
  }
  // FE metrika → klíč, kterému server rozumí. null = server ji neumí → tlačítko pryč.
  function apiKeyFor(tab, def) {
    var a = allowedFor(tab);
    if (!a) return def.keys[0];                     // bez whitelistu: statický default
    for (var i = 0; i < def.keys.length; i++) {
      if (a.metrics.indexOf(def.keys[i]) > -1) return def.keys[i];
    }
    return null;
  }
  // ⚠️ Vrácený objekt MUSÍ nést i `agg` a `ripens`. Dřív se tu skládal nový objekt
  // ručně z id/label/kind/hint/key — a `agg` (týdenní agregace, D2) i `ripens`
  // (šrafování, A1/A2) tiše propadly. Následek: `md.agg` undefined → fetchComponent
  // dostal prázdnou komponentu → GRAF BYL VŽDY PRÁZDNÝ („Pro zvolené období nejsou
  // data") a nic se nešrafovalo. Chyceno až v prohlížeči na ostrých datech.
  // Proto se kopíruje CELÁ definice a přepíše se jen `key`.
  function metricsFor(tab) {
    var list = (tab === 'earrings') ? EARRINGS_METRICS : RINGS_METRICS;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var k = apiKeyFor(tab, list[i]);
      if (!k) continue;
      var def = Object.assign({}, list[i]);
      def.key = k;
      out.push(def);
    }
    return out;
  }
  function splitsFor(tab) {
    // Náušnice mají split fixní ('creative') a přepínač splitů se jim vůbec nekreslí →
    // režim „Víc metrik" by tu byl nedosažitelný. Radši nic než mrtvá větev.
    if (tab === 'earrings') return [];
    var a = allowedFor(tab);
    var base = (!a || !Array.isArray(a.splits))
      ? RINGS_SPLITS
      : RINGS_SPLITS.filter(function (s) { return a.splits.indexOf(s.key) > -1; });
    // `metrics` se NEFILTRUJE serverovým whitelistem — je to čistě klientský režim.
    return base.concat([SPLIT_MULTI]);
  }
  function isMultiMode(tab) {
    return sel.split === 'metrics';
  }

  /* ---------- 4) CSS (injektované jednou) ---------------------------------- */

  function injectCss() {
    if (document.getElementById('ads-charts-css')) return;
    var s = document.createElement('style');
    s.id = 'ads-charts-css';
    s.textContent = [
      '#charts-root,#charts-earrings,#weekly-root{margin:0;}',
      '.acx-card{background:' + CARD_BG + ';border:1px solid #efe8db;border-radius:16px;',
      '  box-shadow:0 1px 2px rgba(60,50,35,.04),0 8px 24px -14px rgba(60,50,35,.14);',
      '  padding:16px 18px 14px;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:' + INK + ';}',
      '.acx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px;}',
      '.acx-title{font-size:15px;font-weight:650;letter-spacing:.2px;color:' + INK + ';display:flex;align-items:center;gap:8px;}',
      '.acx-title .dot{width:8px;height:8px;border-radius:50%;background:#3b6fb0;box-shadow:0 0 0 3px rgba(59,111,176,.15);}',
      '.acx-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;}',
      '.acx-seg{display:inline-flex;background:#f4f1ea;border:1px solid #e9e2d5;border-radius:10px;padding:2px;gap:2px;flex-wrap:wrap;}',
      '.acx-seg button{appearance:none;border:0;background:transparent;color:' + MUTED + ';font:inherit;font-size:12.5px;',
      '  font-weight:550;padding:5px 11px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s;white-space:nowrap;}',
      '.acx-seg button:hover{color:' + INK + ';}',
      '.acx-seg button.is-active{background:#fff;color:' + INK + ';box-shadow:0 1px 2px rgba(60,50,35,.12);}',
      '.acx-sel{appearance:none;border:1px solid #e9e2d5;background:#fff url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'><path d=\'M1 1l4 4 4-4\' stroke=\'%238c857a\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\'/></svg>") no-repeat right 10px center;',
      '  color:' + INK + ';font:inherit;font-size:12.5px;font-weight:550;padding:6px 26px 6px 11px;border-radius:9px;cursor:pointer;}',
      '.acx-sel:focus{outline:2px solid rgba(59,111,176,.35);outline-offset:1px;}',
      // D5 — „Reset zoom"
      '.acx-btn{appearance:none;border:1px solid #e9e2d5;background:#fff;color:' + MUTED + ';font:inherit;',
      '  font-size:12.5px;font-weight:550;padding:5px 11px;border-radius:9px;cursor:pointer;white-space:nowrap;',
      '  transition:color .15s,border-color .15s,background .15s;}',
      '.acx-btn:hover{color:' + INK + ';border-color:#d6cdbd;background:#faf8f3;}',
      '.acx-btn[hidden]{display:none;}',
      // přepínač „zobrazit i malé série" (F1)
      '.acx-toggle{display:inline-flex;align-items:center;gap:7px;border:1px solid #e9e2d5;background:#fff;color:' + MUTED + ';',
      '  font:inherit;font-size:12.5px;font-weight:550;padding:5px 11px;border-radius:9px;cursor:pointer;white-space:nowrap;}',
      '.acx-toggle:hover{color:' + INK + ';}',
      '.acx-toggle .box{width:13px;height:13px;border-radius:4px;border:1.5px solid #d6cdbd;background:#fff;position:relative;flex:none;}',
      '.acx-toggle.is-on{color:' + INK + ';border-color:#c9d8ea;background:#f5f9fd;}',
      '.acx-toggle.is-on .box{background:#3b6fb0;border-color:#3b6fb0;}',
      '.acx-toggle.is-on .box:after{content:"";position:absolute;left:3.5px;top:.5px;width:3px;height:7px;border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(43deg);}',
      // F4 — vysvětlivka NAD grafem (dozrávání tržby). Musí být vidět dřív, než se
      // Filip stihne leknout klesající pravé strany grafu.
      '.acx-note{margin:0 0 12px;padding:9px 12px;border-radius:10px;background:#fbf6ec;',
      '  border:1px solid #f0e4cd;color:#8a6d3b;font-size:12.5px;line-height:1.55;}',
      '.acx-note b{color:#6f572c;}',
      '.acx-body{position:relative;}',
      // E3 — VÝŠKA GRAFU (přepínač Nízký/Normální/Vysoký místo dataZoomu; viz sekce 0d).
      // Bez dataZoom sliderů už plátno nemusí platit ~34 px „daň" na posuvníky.
      '.acx-canvas{width:100%;height:clamp(360px,48vh,540px);}',
      '.acx-canvas.h-low{height:250px;}',
      '.acx-canvas.h-mid{height:clamp(360px,48vh,540px);}',
      '.acx-canvas.h-high{height:clamp(520px,72vh,780px);}',
      // Týdenní graf výšku NEPŘEPÍNÁ: nemá ovládání (jedna metrika, 18 sloupců) a Filipova
      // stížnost E1–E3 mířila na „Vývoj v čase", kde ten dataZoom byl. Drží si svou výšku.
      '.acx-canvas.is-weekly{height:clamp(300px,34vh,380px);}',
      /* G3 — tažení = měřítko osy Y. Kurzor to musí prozradit, jinak je to skrytá funkce.
       * ECharts nastavuje inline cursor:pointer na VNITŘNÍ <canvas> (vyhrává nad kontejnerem)
       * → přebíjíme ho !important přímo na canvasu, ať Filip vidí šipku nahoru/dolů, ne ruku. */
      /* ⚠️ F7-2/C (Filip 23. 7.): „ten kurzor té šipky nahoru dolů, ten chce jenom, když
       * najedu na ten graf, a ne na té legendě. Tam už chce normální kurzor nebo pointer."
       * Legendu kreslí ECharts DOVNITŘ stejného canvasu, takže CSS samo plochu od legendy
       * nerozezná — proto třídu `is-ydrag` nasazuje JS podle chart.containPixel('grid').
       * Bez třídy zůstává default (nad legendou si ECharts nastaví pointer sám). */
      '.acx-canvas.is-ydrag canvas{cursor:ns-resize !important;}',
      '.acx-canvas.is-yscaling,.acx-canvas.is-yscaling canvas{cursor:ns-resize !important;user-select:none;}',
      '.acx-mini-canvas.is-ydrag canvas{cursor:ns-resize !important;}',
      '.acx-mini-canvas.is-yscaling canvas{cursor:ns-resize !important;user-select:none;}',
      /* F7-2/MM — zaškrtávátka metrik. Dědí .fchip/.fchip-multi z tables.js (stejný jazyk
         jako funnel chipy), tady se řeší jen zalomení řady a odsazení. */
      '.acx-mchips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
      '.acx-hint{color:var(--muted,#8b8577);font-size:11px;white-space:nowrap;align-self:center;' +
        'padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.03);cursor:help;}',
      '.acx-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;',
      '  color:' + MUTED + ';font-size:13px;text-align:center;background:linear-gradient(180deg,rgba(255,253,249,.72),rgba(255,253,249,.92));border-radius:12px;padding:12px;}',
      '.acx-overlay.show{display:flex;}',
      '.acx-spin{width:22px;height:22px;border-radius:50%;border:2.5px solid #e7e0d3;border-top-color:#3b6fb0;animation:acxspin .7s linear infinite;}',
      '@keyframes acxspin{to{transform:rotate(360deg)}}',
      '.acx-foot{margin-top:10px;display:flex;align-items:center;gap:8px;color:' + MUTED + ';font-size:11.5px;flex-wrap:wrap;line-height:1.5;}',
      // M3 — jeden bit legendy = jedna flex položka (viz footHTML). `min-width:0` ať se
      // dlouhý bit umí zmenšit a zalomit UVNITŘ sebe místo přetečení z patičky ven.
      '.acx-foot .acx-bit{min-width:0;}',
      '.acx-foot .acx-sep{opacity:.5;}',
      '.acx-foot .hatch{display:inline-block;width:26px;height:10px;border-radius:3px;vertical-align:-1px;',
      '  background:repeating-linear-gradient(135deg,rgba(179,167,143,.55) 0 3px,transparent 3px 6px);border:1px solid #e6dfd2;}',
      '.acx-foot .warn{color:#a2622c;}',
      '.acx-link{color:#3b6fb0;text-decoration:underline;cursor:pointer;background:none;border:0;font:inherit;padding:0;}',
      '.acx-link:hover{color:#2c5a94;}',
      // mini trend (M1)
      '.acx-mini{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:' + INK + ';position:relative;}',
      '.acx-mini-canvas{width:100%;height:216px;}',
      '.acx-mini-foot{margin-top:6px;color:' + MUTED + ';font-size:11px;line-height:1.5;}',
      '.acx-mini-msg{display:flex;align-items:center;justify-content:center;gap:9px;height:150px;color:' + MUTED + ';',
      '  font-size:12.5px;text-align:center;background:#faf8f3;border:1px dashed #e6dfd2;border-radius:12px;padding:12px;}',
      '@media (max-width:640px){.acx-controls{justify-content:flex-start;}.acx-canvas{height:340px;}}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- 5) resize orchestrace ---------------------------------------- */

  // Jeden registr pro VŠECHNY instance (hlavní graf per tab, weekly, mini v modalu).
  // Sbalená sekce (FEEDBACK C3) má plátno 0×0 → po rozbalení se MUSÍ přeměřit, jinak
  // zůstane graf neviditelný. Chytáme to čtyřmi cestami, ať to nezávisí na tom, jak
  // je collapse implementovaný (hidden / display / max-height / <details>).
  var registry = [];
  var _globalWired = false;

  /* ★ G3 — RUČNÍ MĚŘÍTKO OSY Y TAŽENÍM (Kitco style). Filip, potřetí a jasně:
   *   „chtěl bych, abych si mohl najet na ten graf a posunem tahem myši nahoru dolů si ho
   *    zploštit nebo roztáhnout… ty věci, který přestřelujou to šest a půl ROAS, takže by se
   *    najednou snížily a celej by se jako zploštil. Něco jako je to na Kitco.com."
   *   „Dal nízký, vysoký, normální. Chápu, ale já bych to chtěl dělat ručně."
   *
   * CO SE MĚNÍ: `yAxis.max` (měřítko), NE výška kontejneru. Tažením NAHORU se max zvětšuje
   * → křivky se zploští; DOLŮ → max se zmenší → roztáhnou se. Přesně to Filip popsal.
   *
   * PROČ ne dataZoom: odmítl ho („moc halušek") — zabírá místo a je to další ovládací prvek.
   * Tohle je neviditelné, dokud to nepoužiješ.
   *
   * Osa Y VŽDY od 0 (tvrdý požadavek z první zprávy) → tažení mění jen strop, nikdy dno.
   * Dvojklik = zpět na automatické měřítko. Stav se nepamatuje mezi reloady schválně:
   * je to ad-hoc nástroj na „koukni se zblízka", ne nastavení.
   */
  function wireYDrag(chart, canvas) {
    var st = null;          // {y0, max0}
    var manual = null;      // ruční strop, null = automatika

    function autoMax() {
      var o = chart.getOption();
      var ax = o && o.yAxis && o.yAxis[0];
      // Když osa strop nemá (automatika), vezmi ho z toho, co ECharts fakt vykreslil.
      if (ax && ax.max != null && isFinite(ax.max)) return Number(ax.max);
      var m = chart.getModel && chart.getModel().getComponent('yAxis');
      var ex = m && m.axis && m.axis.scale && m.axis.scale.getExtent && m.axis.scale.getExtent();
      return (ex && isFinite(ex[1])) ? ex[1] : null;
    }

    /* kitco-listener-leak: window listenery se věší JEN po dobu tažení a na mouseup se
     * zase odvěsí. Dřív byly navěšené natrvalo z každého wireYDrag() → při opakovaném
     * otevírání detailu (nová instance grafu) se hromadily a dispose() je neuklidil. */
    function onMove(e) {
      if (!st) return;
      // Tažení nahoru (záporné dy) = VĚTŠÍ max = zploštit. 320 px ≈ ×e (plynulé, ne skokové).
      var dy = st.y0 - e.clientY;
      var next = st.max0 * Math.exp(dy / 320);
      /* ⚠️ Mantinely se počítají z auto0 ZAMRZLÉ PŘI MOUSEDOWN, NE z živého autoMax().
       * Dřív se autoMax() přepočítával každý pohyb — jenže drag zrovna MĚNÍ osu, takže
       * autoMax() vracel právě nastavenou hodnotu → mantinely ujížděly s ním → osa
       * „vystřelila do nesmyslu" a nešlo se vrátit (Filip). Fixní reference to stabilizuje. */
      manual = Math.max(st.auto0 / 6, Math.min(st.auto0 * 10, next));
      chart.setOption({ yAxis: { max: Number(manual.toFixed(4)) } }, { lazyUpdate: false });
    }
    function onUp() {
      if (!st) return;
      st = null;
      canvas.classList.remove('is-yscaling');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    /* F7-2/C — jsme nad PLOCHOU grafu (ne nad legendou / osami / prázdnem)?
     * `containPixel('grid')` se ptá přímo ECharts, kde mřížka reálně je — přežije to
     * i změnu layoutu (legenda se podle šířky překlápí zprava dolů). */
    function inGrid(e) {
      try {
        var r = canvas.getBoundingClientRect();
        return !!chart.containPixel({ gridIndex: 0 }, [e.clientX - r.left, e.clientY - r.top]);
      } catch (_) { return false; }
    }
    canvas.addEventListener('mousemove', function (e) {
      if (st) return;                       // během tažení drží kurzor třída is-yscaling
      canvas.classList.toggle('is-ydrag', inGrid(e));
    });
    canvas.addEventListener('mouseleave', function () {
      canvas.classList.remove('is-ydrag');
    });

    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      // Tažením nad legendou se měřítko měnit nesmí — klik tam patří přepínání sérií.
      if (!inGrid(e)) return;
      var auto0 = autoMax();
      var m0 = manual != null ? manual : auto0;
      if (m0 == null || !(m0 > 0)) return;
      // auto0 = pevná reference pro mantinely (nikdy se během tažení nemění).
      st = { y0: e.clientY, max0: m0, auto0: (auto0 && auto0 > 0) ? auto0 : m0 };
      canvas.classList.add('is-yscaling');
      e.preventDefault();                      // ať drag nezačne označovat text
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Dvojklik = reset na automatiku. `max: null` vrátí ECharts do auto režimu.
    canvas.addEventListener('dblclick', function () {
      manual = null;
      chart.setOption({ yAxis: { max: null } }, { lazyUpdate: false });
      if (ADS.toast) ADS.toast('Měřítko zpět na automatické', 'info');
    });
  }

  /* Vrací záznam z registru, aby si volající mohl přivěsit VLASTNÍ observer (ro2
   * v mountFor) do `entry.obs` — pak ho untrackChart() odpojí spolu s ostatními. */
  function trackChart(chart, canvas) {
    var entry = { chart: chart, canvas: canvas, obs: [] };
    registry.push(entry);
    wireYDrag(chart, canvas);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { safeResize(chart, canvas); });
      ro.observe(canvas);
      entry.obs.push(ro);
    }
    if (window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) safeResize(chart, canvas);
      });
      io.observe(canvas);
      entry.obs.push(io);
    }
    wireGlobal();
    return entry;
  }

  /* observer-leak (26. 7. 2026): ResizeObserver i IntersectionObserver z trackChart()
   * se dřív nikam neukládaly, takže je nešlo odpojit. `dispose()` grafu observer NERUŠÍ
   * — ten drží silnou referenci na plátno, takže odpojený uzel i s interními daty ECharts
   * zůstal v paměti do konce session a při každém remountu (přepnutí tabu, znovuotevření
   * detailu) přibyla další dvojice. Proto: observery patří k záznamu a tyhle dvě funkce
   * jsou JEDINÁ cesta, jak graf zahodit. */
  function releaseEntry(r) {
    var obs = (r && r.obs) || [];
    for (var i = 0; i < obs.length; i++) { try { obs[i].disconnect(); } catch (e) { /* noop */ } }
    if (r) r.obs = [];
  }
  /** Odpojí observery dané instance a vyhodí ji z registru. Volat PŘED chart.dispose(). */
  function untrackChart(chart) {
    if (!chart) return;
    for (var i = registry.length - 1; i >= 0; i--) {
      if (registry[i].chart !== chart) continue;
      releaseEntry(registry[i]);
      registry.splice(i, 1);
    }
  }
  function safeResize(chart, canvas) {
    if (!chart || !canvas || !canvas.isConnected) return;
    if (!canvas.clientWidth || !canvas.clientHeight) return;   // skryté → ECharts by warnoval
    try { chart.resize(); } catch (e) { /* noop */ }
  }
  function resizeAll() {
    for (var i = registry.length - 1; i >= 0; i--) {
      var r = registry[i];
      if (!r.canvas || !r.canvas.isConnected) {                 // modal zavřený → ukliď instanci
        releaseEntry(r);                                        // ...i observery, jinak drží mrtvé plátno
        try { r.chart.dispose(); } catch (e) { /* noop */ }
        registry.splice(i, 1);
        continue;
      }
      safeResize(r.chart, r.canvas);
    }
  }
  function wireGlobal() {
    if (_globalWired) return;
    _globalWired = true;
    var t = null;
    var kick = function () { if (t) clearTimeout(t); t = setTimeout(resizeAll, 60); };

    window.addEventListener('resize', kick);
    // <details>/<summary> collapse: 'toggle' nebublá → capture na dokumentu.
    document.addEventListener('toggle', kick, true);
    // accordion přes max-height/height transition
    document.addEventListener('transitionend', function (e) {
      if (e && (e.propertyName === 'max-height' || e.propertyName === 'height')) kick();
    }, true);
    // sbalení řešené JS-em v jiném modulu → poslouchej i sběrnici (neznámé názvy neškodí)
    var bus = window.ADS && window.ADS.bus;
    if (bus && bus.addEventListener) {
      ['sectiontoggle', 'sectionopen', 'expand', 'collapse', 'refreshed', 'tabchange'].forEach(function (ev) {
        bus.addEventListener(ev, kick);
      });
    }
  }

  /* ---------- 6) sdílené stavební bloky grafu ------------------------------ */

  // F2 — LEGENDA. Široké plátno → svisle vpravo (scroll): každá série na vlastním
  // řádku, ellipsis + tooltip s plným názvem → čitelné i při 15 sériích.
  // Úzké plátno → dole (scroll) a grid má REZERVOVANÉ místo (dřív legenda ležela
  // přes popisky osy X = „texty přes sebe").
  function legendLayout(canvasW) {
    if (canvasW >= 860) return { side: true,  w: 200 };
    return { side: false, w: 0 };
  }
  function legendOpt(names, selected, lay) {
    var base = {
      type: 'scroll',
      data: names,
      selected: selected,
      icon: 'roundRect', itemWidth: 12, itemHeight: 4,
      inactiveColor: '#cfc8ba',
      pageIconColor: MUTED, pageIconInactiveColor: '#dcd5c8', pageIconSize: 10,
      pageTextStyle: { color: MUTED, fontSize: 11 },
      tooltip: { show: true }                       // plný název i po zkrácení (ECharts 5)
    };
    if (lay.side) {
      base.orient = 'vertical';
      base.right = 4; base.top = 6; base.bottom = 6;
      base.width = lay.w;
      base.itemGap = 11;
      base.textStyle = { color: MUTED, fontSize: 12, width: lay.w - 24, overflow: 'truncate' };
    } else {
      base.orient = 'horizontal';
      base.bottom = 0; base.left = 'center'; base.right = 10;
      base.itemGap = 16;
      base.textStyle = { color: MUTED, fontSize: 11.5, width: 130, overflow: 'truncate' };
    }
    return base;
  }
  /* H5 — MÍSTO NAD GRIDEM NA POPISEK OSY. Nesahat bez změření.
   *
   * ECharts kreslí název osy Y („ROAS", „CZK") MIMO grid a `containLabel:true` s ním
   * NEPOČÍTÁ — rezervuje místo jen na popisky HODNOT, ne na název osy (ECharts 5.6).
   * Text má spodní hranu na `grid.top − nameGap` a roste odtud NAHORU o svou výšku.
   * Při top:18 / nameGap:12 / font 11 px tak vycházelo:
   *      bottom = 18 − 12 = 6 px  →  y = 6 − 11,2 = −5,2 px  = 5,2 px NAD plátnem
   * → „ROAS" i „CZK" byly svisle uříznuté v půlce písmen (změřeno 16. 7. přes
   *   zrender displayList, ne od oka: rect.y = −5,2 na obou grafech).
   *
   * Musí platit:  grid.top ≥ nameGap + výška textu + rezerva
   *               30      ≥ 12      + 11,2        + 6,8
   * Výsledek: text sedí v [6,8 ; 18] px → celá písmena i s diakritikou. */
  var AXIS_NAME_GAP = 12;   // vzdálenost názvu osy od gridu (nameGap u yValueAxis)
  var GRID_TOP      = 30;   // ⚠️ = AXIS_NAME_GAP + výška fontu 11px + rezerva

  // E2/E3 — dataZoom je pryč (viz 0d), takže grid už NEMUSÍ rezervovat místo na dva
  // posuvníky (dřív ~26 px vpravo + ~52 px dole). Uvolněné plátno = graf je vyšší
  // a širší při stejné výšce karty. Zbývá jen místo na legendu.
  function chartLayout(canvasW) {
    var lay = legendLayout(canvasW);
    lay.top        = GRID_TOP;                      // H5 — viz komentář výš
    lay.gridRight  = lay.side ? (lay.w + 14) : 10;
    lay.gridBottom = lay.side ? 6 : 30;             // úzké plátno → legenda leží dole
    return lay;
  }
  function gridOpt(lay) {
    return { left: 8, right: lay.gridRight, top: lay.top, bottom: lay.gridBottom, containLabel: true };
  }

  // Poměrové metriky = spend ve jmenovateli (ROAS) nebo v čitateli přes mrňavý
  // jmenovatel (CPL/CPA). U obou platí: mizivý spend → ustřelená hodnota → plochý graf.
  // (Dřív se filtr malých sérií pouštěl jen na ROAS a CPL/CPA graf zůstával rozbitý:
  //  funnel „Zásnubní: 7 horor chyb ebook" — spend 1 880 Kč — držel osu CPL na 834 Kč,
  //  přestože reálné CPL ostatních funnelů je 200–430 Kč. Ověřeno naostro 16.7.)
  function isRatioKind(kind) { return kind === 'roas' || kind === 'cost'; }

  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    var i = (sortedAsc.length - 1) * p;
    var lo = Math.floor(i), hi = Math.ceil(i);
    if (lo === hi) return sortedAsc[lo];
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
  }
  function niceUp(v, kind) {
    if (!(v > 0)) return v;
    if (kind === 'roas') return Math.ceil(v * 2) / 2;                     // po 0,5
    var mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.ceil(v / mag) * mag;
  }
  /**
   * F1 — ochrana osy (winsorizace na p95). Vrací {max, p95, names:[…]} když outlier
   * plácne graf na nulu, jinak null. Ořez se VŽDY vypisuje pod grafem (renderFoot)
   * a jde zrušit — nikdy tiše. ROAS má garantovaný strop ≥ WINNER_ROAS×1,1, ať
   * referenční linka nezmizí.
   *
   * ⚠️ NALEZY #17 — dřív tu byly DVA násobitele navíc: gate `max > p95 × 2,5` a
   * strop `p95 × 1,15`. Na ostrých datech (30d · ROAS model · split=funnel · 16.7.)
   * se ořez NIKDY nespustil: p95 = 13,33 · max = 31,62 → poměr 2,37 < 2,5 → osa
   * jela až na 31,62, zatímco všechno rozhodovací (winner 5,0) se mačkalo dole.
   * Přesně to Filip hlásil ve F1: „graf je plochý". Teď: strop = p95 BEZ násobitele,
   * spustí se vždycky, když max přeleze p95. Ověřeno naostro → osa 13,5 místo 31,62.
   */
  function clipInfo(vis, kind) {
    if (kind !== 'roas' && kind !== 'cost') return null;
    var all = [];
    for (var i = 0; i < vis.length; i++) {
      var d = vis[i].data;
      for (var k = 0; k < d.length; k++) if (d[k] != null && isFinite(d[k])) all.push(Number(d[k]));
    }
    if (all.length < 8) return null;
    all.sort(function (a, b) { return a - b; });
    var p95 = percentile(all, 0.95);
    var max = all[all.length - 1];
    if (!(p95 > 0) || max <= p95) return null;

    var top = p95;                                   // winsorizace na p95 (BEZ násobitele)
    if (kind === 'roas') top = Math.max(top, winnerRoas() * 1.1);
    top = niceUp(top, kind);
    if (max <= top * CLIP_GAIN_MIN) return null;     // ořez by nic neuvolnil → radši data nesekat

    var names = [];
    for (var s = 0; s < vis.length; s++) {
      var dd = vis[s].data, over = false;
      for (var j = 0; j < dd.length; j++) if (dd[j] != null && Number(dd[j]) > top) { over = true; break; }
      if (over) names.push(vis[s].name);
    }
    if (!names.length) return null;
    return { max: top, p95: p95, names: names };
  }

  /* M3 — PATIČKA GRAFU: 1 „bit" = 1 flex item. Nesahat bez změření.
   *
   * `.acx-foot` je `display:flex; flex-wrap:wrap`. Bity se ale skládaly z VÍC <span>ů
   * naráz — '<span>┅ break-even 2×</span><span> = plošně pro…</span>' — takže se do
   * flexu dostal KAŽDÝ span jako samostatná položka a wrap uměl frázi roztrhnout.
   * Na 1512 px (default MacBook Pro 14" = Filipův stroj) to reálně nastalo:
   *     „┅ break-even 2×"            zůstalo na konci řádku (x=1013)
   *     „= plošně pro všechny…"      začínalo na dalším řádku od kraje (x=267)
   * → Filip čte řádek začínající „= plošně pro…" bez kontextu = rozbitá legenda.
   * (Změřeno 16. 7.: BE_PHRASE_SPLIT=true. Pozn.: NIC nepřetékalo — `scrollWidth ==
   *  clientWidth`; ono se to netrhalo šířkou, ale wrapem mezi flex položkami.)
   *
   * Obalením je 1 bit = 1 flex item: uvnitř běží normální inline tok (dlouhý text se
   * pořád láme), ale barevný swatch se od svého vysvětlení už neodtrhne. */
  function footHTML(bits) {
    return bits.map(function (b) { return '<span class="acx-bit">' + b + '</span>'; })
               .join('<span class="acx-sep" aria-hidden="true">·</span>');
  }

  function refLine(y, text, color, pos) {
    return {
      yAxis: y,
      label: { formatter: text, color: color, fontSize: 10, position: pos || 'insideStartTop' },
      lineStyle: { color: color, type: 'dashed', width: 1.2, opacity: 0.9 }
    };
  }

  /* C3 — referenční linky pro ROAS graf.
   * `funnels` = názvy funnelů, které jsou v grafu VIDĚT (u split=funnel jsou to jména sérií;
   * u split=event/optimization je to jednoprvkové pole podle filtru funnelu, nebo [] = míchá se).
   * Vrací { lines:[markLine…], drawn:[{funnel,value}], mixed:bool, flat:bool }.
   *
   * ⚠️ PLOŠNÝ REŽIM (dnešní stav — Filip 16. 7. „nechme dva pro všechno"):
   *    JEDNA linka na 2,0, VŽDY, bez ohledu na kontext funnelu. Kontext se neřeší,
   *    protože není co větvit — a hlavně: dřív se při split=event/optimalizace BEZ
   *    filtru funnelu (`funnels` = []) NEKRESLILA linka VŮBEC a patička hlásila
   *    „v grafu se míchá víc funnelů a každý má jiný". To dnes neplatí: každý má
   *    STEJNÝ. Míchání funnelů tedy není důvod linku schovat.
   *
   * Per-funnel větev (níž) zůstává živá pro případ, že by se někdy jeden funnel odlišil.
   * Nikdy nekreslíme 1,0 „aspoň něco" — přesně tohle Filip reklamoval. */
  function roasRefLines(funnels) {
    var out = { lines: [], drawn: [], mixed: false, flat: false };

    var fl = breakevenFlat();
    if (fl.flat && fl.value) {
      out.flat = true;
      out.lines.push(refLine(fl.value, beLabel(null, fl.value), REF_BREAKEVEN, 'insideStartTop'));
      out.drawn.push({ funnel: null, value: fl.value, names: [], color: REF_BREAKEVEN });
      return out;
    }

    var byVal = {};
    for (var i = 0; i < funnels.length; i++) {
      var v = breakevenFor(funnels[i]);
      if (v == null) continue;
      var k = String(v);
      if (!byVal[k]) byVal[k] = { value: v, names: [] };
      byVal[k].names.push(funnels[i]);
    }
    var keys = Object.keys(byVal).sort(function (a, b) { return Number(a) - Number(b); });
    for (var j = 0; j < keys.length; j++) {
      var g = byVal[keys[j]];
      // barva linky = barva funnelu, když je jeden; u víc funnelů se stejnou hodnotou neutrál
      var col = (g.names.length === 1 && brandColor(g.names[0])) ? brandColor(g.names[0]) : REF_BREAKEVEN;
      out.lines.push(refLine(g.value, beLabel(g.names[0], g.value), col,
                             j % 2 ? 'insideEndTop' : 'insideStartTop'));
      out.drawn.push({ funnel: g.names[0], value: g.value, names: g.names, color: col });
    }
    out.mixed = (funnels.length === 0);
    return out;
  }
  function tooltipBase() {
    return {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(255,253,249,.98)',
      borderColor: '#efe8db', borderWidth: 1,
      extraCssText: 'box-shadow:0 8px 26px -10px rgba(60,50,35,.28);border-radius:10px;padding:9px 11px;',
      textStyle: { color: INK, fontSize: 12.5 },
      axisPointer: { type: 'line', lineStyle: { color: '#d8d0c2', width: 1 } }
    };
  }
  function yValueAxis(kind, max) {
    return {
      type: 'value',
      min: 0,                                  // ⬅ osa Y VŽDY od 0 (kritické)
      max: (max != null ? max : undefined),
      /* H5: nameGap drží konstanta — grid.top se od ní odvozuje (viz GRID_TOP).
         Když se tohle číslo zvedne bez zvednutí GRID_TOP, popisek se zas uřízne. */
      name: yAxisName(kind), nameGap: AXIS_NAME_GAP,
      nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: GRID } },
      axisLabel: { color: MUTED, fontSize: 11, formatter: function (v) { return axisLabel(v, kind); } }
    };
  }
  // tolerantní rozbalení odpovědi (přímo, nebo v .data/.result)
  function unwrap(res) {
    if (!res) return null;
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
      if (res.data.series || res.data.dates || res.data.weeks) return res.data;
    }
    if (res.result && typeof res.result === 'object') {
      if (res.result.series || res.result.dates || res.result.weeks) return res.result;
    }
    return res;
  }

  /* =========================================================================
   * 6a) HLAVNÍ GRAF — „Vývoj v čase"
   * ====================================================================== */

  // Každý tab má VLASTNÍ mount i vlastní ECharts instanci:
  //   prsteny → #charts-root (uvnitř #rings-view) · náušnice → #charts-earrings
  // Jeden sdílený mount nejde: app.js přepíná [hidden] na celém view a
  // `[hidden]{display:none!important}` → graf uvnitř skrytého view se nezobrazí.
  var MOUNT_ID = { rings: 'charts-root', earrings: 'charts-earrings' };
  var views = {};            // tab -> { root, chart, els, last }
  var chart = null;          // echarts instance AKTIVNÍHO tabu
  var els = {};              // cache DOM   AKTIVNÍHO tabu
  // P1-A: funnel je POLE (multi-select). Prázdné = VŠE. Do fetche se serializuje čárkou
  // (server umí čárkou oddělený seznam přes funnel_filter_list()).
  var sel = { metricId: 'spend', split: 'funnel', funnel: [],
              // F7-2/MM — zaškrtnuté metriky pro režim „Víc metrik" (default: peníze + výkon)
              metricIds: ['spend', 'roas_model'],
              gran: GRAN_DEFAULT,          // D2 — default = týden
              height: loadHeight(),        // E3 — Nízký/Normální/Vysoký (localStorage)
              rangeDays: null,             // Filip: horizont grafu; null = dle období nahoře, jinak 30/90/180
              showSmall: false, noClip: false };
  function funnelCsv() { return Array.isArray(sel.funnel) ? sel.funnel.join(',') : (sel.funnel || ''); }

  /* F7-2 — počáteční stav grafu se dá předvolit z URL:
   *   ?chart_split=metrics&chart_metrics=spend,roas_model,cpl&chart_gran=month
   * K čemu to je: (1) poslat kolegovi odkaz rovnou na ten pohled, o kterém je řeč,
   * (2) dá se tím otestovat konkrétní kombinace bez proklikávání.
   * Neznámé hodnoty se ignorují — URL nesmí shodit graf. */
  (function applyUrlPrefs() {
    try {
      var q = new URLSearchParams(location.search);
      var sp = q.get('chart_split');
      if (sp && /^(funnel|event|optimization|metrics)$/.test(sp)) sel.split = sp;
      var gr = q.get('chart_gran');
      if (gr && /^(day|week|month)$/.test(gr)) sel.gran = gr;
      var ms = q.get('chart_metrics');
      if (ms) {
        var ids = ms.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        if (ids.length) sel.metricIds = ids;
      }
    } catch (_) { /* starý prohlížeč / divná URL → default */ }
  })();
  var RANGE_DAY_OPTS = [30, 90, 180];
  function shiftDaysISO(iso, delta) {
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Efektivní rozsah grafu: override (rangeDays) nebo globální období nahoře.
  function chartRange(st) {
    if (sel.rangeDays && st && st.to) {
      return { from: shiftDaysISO(st.to, -(sel.rangeDays - 1)), to: st.to };
    }
    return { from: st.from, to: st.to };
  }
  /* Pořadí funnelů pro chipy v grafu — sdílené s tabulkou přes ADS.funnelOrderHint
   * (řazení dle počtu reklam, „---" nakonec). Počty v grafu nemáme, tak jen pořadí. */
  function chartFunnelList() {
    var all = (window.ADS && Array.isArray(window.ADS.FUNNELS)) ? window.ADS.FUNNELS.slice() : [];
    var hint = (window.ADS && Array.isArray(window.ADS.funnelOrderHint)) ? window.ADS.funnelOrderHint : null;
    if (!hint) return all;
    var pos = {}; hint.forEach(function (f, i) { pos[f] = i; });
    return all.sort(function (a, b) {
      var pa = pos[a] == null ? 1e9 : pos[a], pb = pos[b] == null ? 1e9 : pos[b];
      return pa - pb || String(a).localeCompare(String(b), 'cs');
    });
  }
  var reqSeq = 0;
  var loadTimer = null;

  function state() { return (window.ADS && window.ADS.state) || {}; }
  function currentTab() { return state().tab === 'earrings' ? 'earrings' : 'rings'; }
  function metricDef(tab) {
    var list = metricsFor(tab);
    for (var i = 0; i < list.length; i++) if (list[i].id === sel.metricId) return list[i];
    return list[0] || null;
  }
  function syncSelToTab(tab) {
    var list = metricsFor(tab);
    var ok = false;
    for (var i = 0; i < list.length; i++) if (list[i].id === sel.metricId) ok = true;
    if (!ok && list.length) sel.metricId = list[0].id;

    if (tab === 'earrings') { sel.split = EARRINGS_SPLIT; sel.funnel = []; return; }
    var sp = splitsFor(tab), found = false;
    for (var j = 0; j < sp.length; j++) if (sp[j].key === sel.split) found = true;
    if (!found) sel.split = (sp[0] && sp[0].key) || 'funnel';
  }

  function mountFor(tab) {
    var v = views[tab];
    // Cache jen dokud plátno visí v dokumentu — jiný modul (sbalování sekcí, C3)
    // může mountu přepsat innerHTML → instance by kreslila do odpojeného uzlu.
    if (v && v.els.canvas && v.els.canvas.isConnected) { chart = v.chart; els = v.els; return !!v.chart; }
    if (v) { untrackChart(v.chart); try { if (v.chart) v.chart.dispose(); } catch (e) { /* noop */ } delete views[tab]; }

    var id = MOUNT_ID[tab] || MOUNT_ID.rings;
    var root = (window.ADS && window.ADS.el) ? window.ADS.el('#' + id) : document.getElementById(id);
    if (!root) { console.warn('[charts] mount #' + id + ' neexistuje — graf pro tab „' + tab + '" se nevykreslí.'); return false; }
    injectCss();

    root.innerHTML =
      '<section class="acx-card">' +
        '<div class="acx-head">' +
          '<div class="acx-title"><span class="dot"></span>Vývoj v čase</div>' +
          '<div class="acx-controls" data-acx="controls"></div>' +
        '</div>' +
        '<div class="acx-note" data-acx="note" hidden></div>' +
        '<div class="acx-body">' +
          // E3 — třída výšky rovnou do markupu, ať se graf nepřekresluje po mountu
          '<div class="acx-canvas h-' + esc(sel.height) + '" data-acx="canvas"></div>' +
          '<div class="acx-overlay" data-acx="overlay"></div>' +
        '</div>' +
        '<div class="acx-foot" data-acx="foot"></div>' +
      '</section>';

    v = { root: root, chart: null, els: {}, last: null };
    v.els.root     = root;
    v.els.controls = root.querySelector('[data-acx="controls"]');
    v.els.note     = root.querySelector('[data-acx="note"]');
    v.els.canvas   = root.querySelector('[data-acx="canvas"]');
    v.els.overlay  = root.querySelector('[data-acx="overlay"]');
    v.els.foot     = root.querySelector('[data-acx="foot"]');
    views[tab] = v;
    els = v.els;

    if (!window.echarts) { showOverlay('Knihovna grafů se nenačetla.', false); return false; }
    v.chart = window.echarts.init(v.els.canvas, null, { renderer: 'canvas' });
    chart = v.chart;
    var entry = trackChart(v.chart, v.els.canvas);

    // Změna šířky může překlopit legendu vpravo ↔ dole → překresli z cache (bez fetche).
    if (window.ResizeObserver) {
      var lastSide = null;
      var ro2 = new ResizeObserver(function () {
        if (!v.els.canvas.clientWidth) return;
        var side = legendLayout(v.els.canvas.clientWidth).side;
        if (lastSide === null) { lastSide = side; return; }
        if (side !== lastSide) { lastSide = side; if (v.last) rerender(tab); }
      });
      ro2.observe(v.els.canvas);
      entry.obs.push(ro2);          // ať ho untrackChart() odpojí spolu se zbytkem
    }
    return true;
  }

  /* ---- ovládací prvky ---- */

  function buildControls(tab) {
    if (!els.controls) return;
    var html = '';
    var md = metricDef(tab);

    // D2 — Den / Týden (default týden). První v řadě: mění smysl všeho napravo.
    html += '<div class="acx-seg" data-acx="gran" title="Týdenní agregace vyhladí denní ústřely. ' +
            'Týden se počítá poctivě: sečtou se surové buňky (spend, tržba, leady, rezervace) ' +
            'a teprve z nich se spočítá metrika — neprůměrují se hotové denní ROAS/CPL.">';
    for (var g = 0; g < GRANS.length; g++) {
      html += '<button type="button" data-k="' + GRANS[g].key + '"' +
              (GRANS[g].key === sel.gran ? ' class="is-active"' : '') + '>' + esc(GRANS[g].label) + '</button>';
    }
    html += '</div>';

    // Horizont grafu (Filip: „u hlavního grafu chci přepínat dny — 30/90/180"). „Období" =
    // dle data pickeru nahoře (default); ostatní přebijí rozsah jen pro tenhle graf.
    html += '<div class="acx-seg" data-acx="range" title="Kolik dnů zpět kreslit graf. „Období" = podle data nahoře.">' +
            '<button type="button" data-r=""' + (sel.rangeDays == null ? ' class="is-active"' : '') + '>Období</button>' +
            RANGE_DAY_OPTS.map(function (d) {
              return '<button type="button" data-r="' + d + '"' + (sel.rangeDays === d ? ' class="is-active"' : '') + '>' + d + ' dní</button>';
            }).join('') +
            '</div>';

    if (tab === 'rings') {
      var splits = splitsFor(tab);
      if (splits.length > 1) {
        html += '<div class="acx-seg" data-acx="split">';
        for (var i = 0; i < splits.length; i++) {
          html += '<button type="button" data-k="' + splits[i].key + '"' +
                  (splits[i].key === sel.split ? ' class="is-active"' : '') + '>' + esc(splits[i].label) + '</button>';
        }
        html += '</div>';
      }
      {
        /* P1-A — funnel filtr = chipy (multi-select), stejný jazyk jako v tabulce
         * (.fchip/.fchip-multi, CSS injektuje tables.js globálně). Prázdný výběr = VŠE.
         * ⚠️ F7-2 (Filip 23. 7.): „ty funnely bych nechtěl mít vpravo na té legendě, ale
         * NAHOŘE, na výběr." Dřív se chipy schovávaly, když byl split=funnel (funnely byly
         * série v legendě) → funnel se dal vybrat jen klikáním do legendy. Teď jsou chipy
         * VŽDY: u split=funnel určují, které funnely se kreslí, jinde na co se filtruje. */
        var funnels = chartFunnelList();
        var selF = Array.isArray(sel.funnel) ? sel.funnel : [];
        var allOn = selF.length === 0;
        html += '<div class="acx-fchips" data-acx="funnel">';
        html += '<button type="button" class="fchip' + (allOn ? ' is-on' : '') + '" data-f="" ' +
                'title="Zrušit výběr — všechny funnely">Vše</button>';
        for (var j = 0; j < funnels.length; j++) {
          var on = selF.indexOf(funnels[j]) > -1;
          html += '<button type="button" class="fchip fchip-multi' + (on ? ' is-on' : '') + '" data-f="' + esc(funnels[j]) + '" ' +
                  'title="' + esc(funnels[j]) + (on ? ' — klikni pro odebrání' : ' — klikni pro přidání') + '">' +
                  '<span class="fchk" aria-hidden="true"></span>' + esc(funnels[j]) + '</button>';
        }
        html += '</div>';
      }
    } else {
      html += '<span class="acx-sel" style="cursor:default;background-image:none;padding-right:11px">Top kreativy</span>';
    }

    /* F1/G6 — přepínač „zobrazit i malé série".
     * ⚠️ Podmínka `isRatioKind` je PRYČ: filtr malých teď běží u VŠECH metrik (G6 — graf měl
     * 11 překrytých funnelů a default metrika Spend filtr nikdy nespustila). Kdyby tlačítko
     * zůstalo jen u poměrových, u Spendu by se série tiše schovaly a NEBYLO by jak je vrátit —
     * a tiché skrývání dat je přesně to, co se nesmí. */
    html += '<button type="button" class="acx-toggle' + (sel.showSmall ? ' is-on' : '') + '" data-acx="small"' +
            ' title="Série se spendem pod 1 % okna se skrývají — jsou to drobky, které jen zamotávají ' +
            'graf (a u ROAS/CPL navíc lítají: ROAS 200× z 500 Kč). Tímhle je zobrazíš.">' +
            '<span class="box"></span>zobrazit i malé série</button>';

    var metrics = metricsFor(tab);
    if (isMultiMode(tab)) {
      // F7-2/MM — zaškrtávátka místo přepínače: metrik může běžet víc naráz.
      html += '<div class="acx-mchips" data-acx="metricmulti" title="Zaškrtni metriky, které chceš ' +
              'vidět naráz. Každá má vlastní měřítko (jinak by ROAS 4 zmizel vedle spendu 100 000), ' +
              'proto se kreslí jako % svého maxima — skutečné hodnoty jsou v tooltipu.">';
      for (var m = 0; m < metrics.length; m++) {
        var mt = metrics[m];
        var onM = sel.metricIds.indexOf(mt.id) > -1;
        html += '<button type="button" class="fchip fchip-multi' + (onM ? ' is-on' : '') + '" ' +
                'data-k="' + esc(mt.id) + '" title="' + esc(mt.hint || mt.label) + '">' +
                '<span class="fchk" aria-hidden="true"></span>' + esc(mt.label) + '</button>';
      }
      html += '</div>';
    } else {
      html += '<div class="acx-seg" data-acx="metric">';
      for (var m2 = 0; m2 < metrics.length; m2++) {
        var mt2 = metrics[m2];
        html += '<button type="button" data-k="' + esc(mt2.id) + '"' + (mt2.id === sel.metricId ? ' class="is-active"' : '') +
                (mt2.hint ? ' title="' + esc(mt2.hint) + '"' : '') + '>' + esc(mt2.label) + '</button>';
      }
      html += '</div>';
    }

    /* ❌ G3 — PŘEPÍNAČ VÝŠKY (Nízký/Normální/Vysoký) JE PRYČ. Filip ho ODMÍTL, DVAKRÁT:
     *    „Dal nízký, vysoký, normální. Chápu, ale já bych to chtěl dělat ručně."
     *    „chtěl bych, abych si mohl najet na ten graf a posunem tahem myši nahoru dolů
     *     si ho zploštit nebo roztáhnout… něco jako je to na Kitco.com."
     *    Před tím odmítl i vertikální dataZoom slider („moc halušek").
     *    → Nahrazeno TAŽENÍM MYŠI nad plochou grafu, které mění MĚŘÍTKO osy Y (wireYDrag).
     *    Nevracet to sem. Kdyby někdo chtěl presety zpátky, ať se nejdřív zeptá Filipa. */

    // G3: nenápadný hint, ať se o tažení vůbec dozví (jinak je to skrytá funkce)
    html += '<span class="acx-hint" title="Táhni myší svisle nad grafem = zploštíš nebo roztáhneš ' +
            'křivky (mění se měřítko osy). Dvojklik vrátí automatické měřítko.">↕ táhni = měřítko</span>';

    els.controls.innerHTML = html;

    var rangeSeg = els.controls.querySelector('[data-acx="range"]');
    if (rangeSeg) rangeSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var rd = b.dataset.r === '' ? null : parseInt(b.dataset.r, 10);
      if (rd === sel.rangeDays) return;
      sel.rangeDays = rd;
      sel.noClip = false;
      buildControls(currentTab());
      scheduleLoad();
    });

    var granSeg = els.controls.querySelector('[data-acx="gran"]');
    if (granSeg) granSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (sel.gran === b.dataset.k) return;
      sel.gran = b.dataset.k;
      sel.noClip = false;                  // ořez je per pohled
      buildControls(currentTab());
      scheduleLoad();
    });

    var splitSeg = els.controls.querySelector('[data-acx="split"]');
    if (splitSeg) splitSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (sel.split === b.dataset.k) return;
      sel.split = b.dataset.k; sel.funnel = [];
      buildControls(currentTab());
      scheduleLoad();
    });

    var funnelChips = els.controls.querySelector('[data-acx="funnel"]');
    if (funnelChips) funnelChips.addEventListener('click', function (e) {
      var b = e.target.closest('.fchip'); if (!b) return;
      var f = b.getAttribute('data-f') || '';
      if (!Array.isArray(sel.funnel)) sel.funnel = [];
      if (f === '') {
        sel.funnel = [];                                   // „Vše" = zrušit výběr
      } else if (e.metaKey || e.ctrlKey) {
        sel.funnel = [f];                                  // ⌘/Ctrl+klik = jen tenhle
      } else {
        var i = sel.funnel.indexOf(f);
        if (i > -1) sel.funnel.splice(i, 1); else sel.funnel.push(f);
      }
      buildControls(currentTab());                         // překresli stavy chipů
      scheduleLoad();
    });

    var smallBtn = els.controls.querySelector('[data-acx="small"]');
    if (smallBtn) smallBtn.addEventListener('click', function () {
      sel.showSmall = !sel.showSmall;
      smallBtn.classList.toggle('is-on', sel.showSmall);
      rerender(currentTab());              // data máme → jen překresli
    });

    var metricSeg = els.controls.querySelector('[data-acx="metric"]');
    if (metricSeg) metricSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (sel.metricId === b.dataset.k) return;
      sel.metricId = b.dataset.k;
      sel.noClip = false;                  // ořez je per metrika
      buildControls(currentTab());         // kind metriky ovlivňuje viditelnost přepínače
      scheduleLoad();
    });

    // F7-2/MM — zaškrtávátka metrik (režim „Víc metrik")
    var metricMulti = els.controls.querySelector('[data-acx="metricmulti"]');
    if (metricMulti) metricMulti.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var id = b.dataset.k;
      var i = sel.metricIds.indexOf(id);
      if (i > -1) {
        // Poslední zaškrtnutou nepouštíme dolů — prázdný graf vypadá jako rozbitý.
        if (sel.metricIds.length === 1) return;
        sel.metricIds.splice(i, 1);
      } else {
        sel.metricIds.push(id);
      }
      sel.noClip = false;
      buildControls(currentTab());
      scheduleLoad();
    });
  }

  /* ---- overlay ---- */

  function showOverlay(msg, spinner) {
    if (!els.overlay) return;
    els.overlay.innerHTML = (spinner ? '<div class="acx-spin"></div>' : '') + '<div>' + esc(msg) + '</div>';
    els.overlay.classList.add('show');
  }
  function hideOverlay() { if (els.overlay) els.overlay.classList.remove('show'); }

  /* =========================================================================
   * 6b) DATOVÁ VRSTVA — jedno místo, kde se tahá a agreguje (D2)
   * ====================================================================== */

  // Jeden fetch = jedna metrika × split × funnel × období. Cachujeme: týdenní ROAS
  // potřebuje `revenue` i `spend`, filtr malých sérií zase `spend` — bez cache by
  // se stejná řada tahala třikrát.
  var seriesCache = Object.create(null);

  // FE kandidáti → klíč, kterému server rozumí (whitelist z ?action=config).
  function resolveKey(tab, keys) {
    var a = allowedFor(tab);
    if (!a) return keys[0];
    for (var i = 0; i < keys.length; i++) if (a.metrics.indexOf(keys[i]) > -1) return keys[i];
    return null;
  }

  // → { dates:[…], byName:{ name:[denní hodnoty] }, order:[…], estIdx:{ name:idx } }
  /* F7-3: `gran` (day|week|month) jde na SERVER — ten body řady rovnou agreguje do košů
   * a dopočet udělá JEDNOU nad součtem koše. Klient si týdny/měsíce už NESKLÁDÁ sám
   * (sčítal hotové denní dopočty, což u revenue_model/roas_model lhalo — viz build_timeseries). */
  function fetchSeries(tab, key, split, funnel, from, to, gran) {
    if (!key) return Promise.resolve(null);
    gran = gran || 'day';
    var ck = [tab, key, split, funnel, from, to, gran].join('|');
    if (seriesCache[ck]) return seriesCache[ck];

    var params = { from: from, to: to, tab: tab, metric: key, split: split, granularity: gran };
    if (tab === 'rings' && funnel) params.funnel = funnel;

    seriesCache[ck] = Promise.resolve(window.ADS.api('timeseries', params))
      .then(function (res) {
        var p = unwrap(res) || {};
        var out = { dates: p.dates || [], byName: {}, order: [], estIdx: {} };
        var ss = p.series || [];
        for (var s = 0; s < ss.length; s++) {
          var nm = (ss[s].name != null && ss[s].name !== '') ? String(ss[s].name) : '(bez názvu)';
          out.byName[nm] = (ss[s].data || []).map(num);
          out.order.push(nm);
          if (ss[s].estimating_from_index != null) out.estIdx[nm] = Number(ss[s].estimating_from_index);
        }
        return out;
      })
      .catch(function (err) {
        seriesCache[ck] = null;             // ať to příště zkusí znovu
        throw err;
      });
    return seriesCache[ck];
  }

  // Komponenta = přímá metrika K(...) nebo rekonstrukce DERIVE(op, a, b).
  function fetchComponent(tab, comp, split, funnel, from, to, gran) {
    if (!comp) return Promise.resolve(null);
    if (comp.keys) return fetchSeries(tab, resolveKey(tab, comp.keys), split, funnel, from, to, gran);
    return Promise.all([
      fetchComponent(tab, comp.a, split, funnel, from, to, gran),
      fetchComponent(tab, comp.b, split, funnel, from, to, gran)
    ]).then(function (r) {
      var A = r[0], B = r[1];
      if (!A || !B) return null;
      var out = { dates: A.dates, byName: {}, order: A.order.slice(), estIdx: A.estIdx };
      for (var i = 0; i < A.order.length; i++) {
        var nm = A.order[i];
        out.byName[nm] = deriveVals(comp.derive, A.byName[nm] || [], B.byName[nm] || []);
      }
      return out;
    });
  }

  // Rekonstrukce chybějících surových buněk (viz komentář u DERIVE nahoře).
  function deriveVals(op, a, b) {
    var n = Math.max(a.length, b.length), out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = a[i], y = b[i];
      if ((x == null || !isFinite(x)) && (y == null || !isFinite(y))) { out[i] = null; continue; }
      x = (x == null || !isFinite(x)) ? 0 : Number(x);
      y = (y == null || !isFinite(y)) ? 0 : Number(y);
      // 'div' se jmenovatelem 0 = den se spendem a bez rezervace → 0 do jmenovatele týdne,
      // ale spend zůstává v čitateli → týdenní CPA správně naroste. Není to edge case, je to pointa.
      out[i] = (op === 'mul') ? (x * y) : (y > 0 ? x / y : 0);
    }
    return out;
  }

  /* ---- ISO týdny (pondělí) — shodně s api.php iso_week_start() ---- */
  // UTC schválně: lokální čas by na přechodu letního času posunul půlnoc a týden by
  // se rozjel o den.
  function isoWeekStart(dateStr) {
    var m = String(dateStr == null ? '' : dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var dow = d.getUTCDay() || 7;                       // 1 = Po … 7 = Ne
    if (dow > 1) d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d.toISOString().slice(0, 10);
  }
  /* ⚠️ F7-3 — KLIENTSKÉ BUCKETOVÁNÍ JE PRYČ (a nevracet ho).
   * Dřív tu byly `monthStart()`, `periodBuckets()`, `weekBuckets()` a `bucketSum()`:
   * klient si z denní řady skládal týdny/měsíce sám. U aditivních metrik to bylo správně,
   * ale u `revenue_model`/`roas_model` sčítal HOTOVÉ DENNÍ DOPOČTY — a dopočet nad součtem
   * období je něco jiného než součet denních dopočtů (100K, týden 13.–19. 7.:
   * graf ROAS 1,58 vs. tabulka 4,69, vždycky směrem dolů).
   *
   * Koše teď dělá SERVER (`?action=timeseries&granularity=day|week|month`) a dopočet běží
   * JEDNOU nad součtem koše přes segment_derive() — stejně jako v tabulkách.
   * Filip 23. 7.: „vždycky to bude počítat za to období, které si zobrazuji."
   *
   * Kdyby se sem někdy vracela agregace, rozejde se graf s tabulkou znovu. Nedělej to. */

  /**
   * Načte data pro metriku v požadované granularitě.
   * → { dates:[…], series:[{name,data,estIdx}], spend:{byName,total}, gran }
   *
   * Den   = server už metriku spočítal na denním řádku → bereme rovnou.
   * Týden = D2: stáhneme SUROVÉ komponenty, sečteme je po ISO týdnech a teprve pak
   *         spočítáme metriku. Aditivní metriky mají čitatele == sebe → prostý součet.
   */
  /* A0/A4 — ZRALOST per série × koš, ZE SERVERU.
   *
   * ⚠️ PŘEPSÁNO 16. 7. (iterace 5). Dřív se tu počítalo Σrevenue_real / Σrevenue_model
   *    z `?action=timeseries`. Bylo to JINÉ ČÍSLO než to, které pod jménem „zralost"
   *    ukazuje zbytek dashboardu (tabulky, dlaždice, wizard — všechny čtou serverové
   *    `zralost` = %call × %schůzek). Ostrá data 16. 7., „Snubní 30K", týden 29. 6.:
   *        server zralost = 0,5672   ·   Σreal/Σmodel = 0,7648
   *    → hover grafu 76 %, tabulka o kus níž 57 %. Filip by se právem ptal, které platí.
   *    A0 je jednoznačné: zralost = %call × %schůzek. Nic jiného.
   *
   * PROČ NE Z `timeseries`: ten neumí vrátit `called`/`called_base`/`passed` (whitelist
   * ověřen naostro: spend, revenue, revenue_model, roas_*, cpl, cpa, cps, leads,
   * bookings, reservations) → %call × %schůzek se z něj SPOČÍTAT NEDÁ. Proto se ptáme
   * `?action=funnel_trend` / `?action=event_trend`, které zralost vracejí HOTOVOU
   * u každého koše (ověřeno naostro: points[].zralost + shodné `buckets`).
   *
   * KDE TO NEJDE: split=optimization (endpoint pro něj není) a náušnice (jedou split
   * podle KREATIVY, kdežto trend zná jen skupinu „Náušnice"). Tam radši zralost
   * NEUKAZUJEME, než abychom pod stejným jménem ukázali jinou veličinu — patička to
   * napíše. Zralost per kreativa je v tabulce a v rozkliku (mini trend).
   *
   * Vrací { byName: {série → [zralost per koš]}, ok: bool } nebo null.
   */
  var trendCache = Object.create(null);

  /** Umí server pro tenhle tab+split vrátit zralost per série? */
  function maturityDim(tab, split) {
    if (tab !== 'rings') return null;                 // náušnice: split=creative → trend to neumí
    if (split === 'funnel') return 'funnel';
    if (split === 'event')  return 'event';
    // „Optimalizace" je serverově TÁŽ dimenze jako event (api.php: „optimization == event,
    // BQ lead_event — jiný zdroj v v1 není") → zralost bereme z event_trend. Dřív tu byl
    // null a Filipův hover na splitu Optimalizace zralost NEukazoval (14. 8.), přestože
    // series jsou 1:1 tytéž jako u Event.
    if (split === 'optimization') return 'event';
    return null;
  }

  function fetchTrend(tab, dim, funnel, from, to, gran) {
    var ck = [tab, dim, funnel, from, to, gran].join('|');
    if (trendCache[ck]) return trendCache[ck];
    var params = { tab: tab, from: from, to: to, granularity: gran };
    if (funnel) params.funnel = funnel;
    trendCache[ck] = Promise.resolve(window.ADS.api(dim === 'event' ? 'event_trend' : 'funnel_trend', params))
      .then(function (res) {
        var r = unwrap(res) || {};
        var groups = r.events || r.funnels || [];
        var out = Object.create(null);
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i] || {};
          var nm = g.event || g.funnel || g.name;
          if (nm == null || nm === '') nm = '(bez názvu)';
          var byBucket = Object.create(null);
          var pts = g.points || [];
          for (var p = 0; p < pts.length; p++) {
            var z = num(pts[p].zralost);
            byBucket[String(pts[p].bucket)] = (z != null && z >= 0) ? Math.min(z, 1) : null;
          }
          out[String(nm)] = byBucket;
        }
        return out;
      })
      .catch(function (err) { trendCache[ck] = null; throw err; });
    return trendCache[ck];
  }

  /** `keys` = klíče košů (datum u dne, pondělí u týdne) — mapujeme PODLE KLÍČE, ne indexu:
   *  trend snapuje týdenní `from` na pondělí, takže indexy se posunout MOHOU, klíče ne. */
  function loadMaturity(tab, split, funnel, from, to, gran, keys) {
    var dim = maturityDim(tab, split);
    if (!dim) return Promise.resolve(null);
    return fetchTrend(tab, dim, (dim === 'event' ? funnel : ''), from, to, gran)
      .then(function (byGroup) {
        if (!byGroup) return null;
        var out = Object.create(null);
        Object.keys(byGroup).forEach(function (nm) {
          var bb = byGroup[nm];
          out[nm] = keys.map(function (k) { return (bb[String(k)] != null) ? bb[String(k)] : null; });
        });
        return out;
      })
      .catch(function (err) {
        console.warn('[charts] zralost z ' + dim + '_trend se nenačetla → hover ji neukáže',
                     err && err.message);
        return null;
      });
  }

  /* ⚠️ F7-3 — KLIENT UŽ TÝDNY/MĚSÍCE NESKLÁDÁ. Dřív tu byly dvě větve:
   * „den" (bral hotovou denní řadu) a „týden" (stáhl SUROVÉ komponenty a sečetl je po ISO
   * týdnech). Ta druhá byla správně u aditivních metrik, ale u `revenue_model`/`roas_model`
   * sčítala HOTOVÉ DENNÍ DOPOČTY — a dopočet nad součtem týdne je něco jiného než součet
   * denních dopočtů (100K, týden 13.–19. 7.: graf ROAS 1,58 vs. tabulka 4,69).
   *
   * Filip 23. 7.: „vždycky to bude ukazovat zralost a počítat to za to období, které si
   * zobrazuji — když po týdnech, tak po týdnech, když po dnech, tak po dnech."
   * → Koše dělá SERVER (build_timeseries + granularity) a dopočet běží JEDNOU nad součtem
   *   koše přes segment_derive(), stejně jako v tabulkách. Tady se už jen vykresluje.
   *
   * NEVRACEJ SEM KLIENTSKOU AGREGACI. Byla by to druhá cesta k témuž číslu a rozejde se. */
  function loadAgg(tab, md, split, funnel, from, to, gran) {
    // Spend tahá KAŽDÁ metrika, ne jen poměrová:
    //   1) filtr malých sérií (D1/D4) ho potřebuje u ROAS/CPL/CPA,
    //   2) ořez osy (D3) ho potřebuje VŽDY — koš se spendem a nulou konverzí je reálný koš
    //      (a zrovna ten je kill signál), nesmí se uříznout jako „prázdno".
    var spendKey = resolveKey(tab, ['spend']);
    var spendP   = fetchSeries(tab, spendKey, split, funnel, from, to, gran).catch(function () { return null; });
    var wantMat  = metricRevenueBased(md);      // A4 — zralost jen u tržbových metrik

    return Promise.all([fetchSeries(tab, md.key, split, funnel, from, to, gran), spendP]).then(function (r) {
      var P = r[0] || { dates: [], byName: {}, order: [], estIdx: {} };
      // A0 — zralost per série × koš ze serveru; klíč koše je shodný (trend_bucket_key)
      var matP = wantMat
        ? loadMaturity(tab, split, funnel, from, to, gran, P.dates).catch(function () { return null; })
        : Promise.resolve(null);
      return Promise.resolve(matP).then(function (mat) {
        return {
          gran: gran, dates: P.dates,
          series: P.order.map(function (nm) {
            return { name: nm, data: P.byName[nm], estIdx: P.estIdx[nm], mat: mat && mat[nm] };
          }),
          spend: spendTotals(r[1]),
          // spendByIdx: řada je už v koších → žádné další bucketování
          spendByIdx: spendPerIndex(r[1])
        };
      });
    });
  }

  /* =========================================================================
   * F7-2/MM — REŽIM „VÍC METRIK NAJEDNOU"
   * -------------------------------------------------------------------------
   * Série = METRIKY (ne funnely). Funnely se vybírají chipy nahoře a všechny vybrané
   * se sečtou do JEDNÉ řady per metrika — jinak by 3 funnely × 5 metrik dalo 15 čar.
   *
   * ⚠️ POMĚROVÉ METRIKY SE NESČÍTAJÍ. ROAS ani CPL nejde sečíst přes funnely — musí se
   * sečíst KOMPONENTY (tržba, spend, leady) a teprve z jejich součtu spočítat poměr.
   * Přes ČAS se tu nesčítá nic: koše (den/týden/měsíc) dělá server a dopočet je hotový
   * už v nich (F7-3).
   * ======================================================================== */

  /** Sečti všechny série jednoho fetche do JEDNÉ řady. null = žádná data v tom koši. */
  function collapseSeries(P) {
    if (!P || !P.dates) return null;
    var n = P.dates.length, out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = null;
    for (var k = 0; k < P.order.length; k++) {
      var d = P.byName[P.order[k]] || [];
      for (var j = 0; j < n; j++) {
        var v = Number(d[j]);
        if (d[j] == null || !isFinite(v)) continue;
        out[j] = (out[j] == null ? 0 : out[j]) + v;
      }
    }
    return { dates: P.dates, vals: out };
  }

  function loadMulti(tab, mds, split, funnel, from, to, gran) {
    var jobs = mds.map(function (md) {
      var agg = md.agg || SUM({ keys: md.keys });
      return Promise.all([
        fetchComponent(tab, agg.num, split, funnel, from, to, gran),
        agg.type === 'ratio' ? fetchComponent(tab, agg.den, split, funnel, from, to, gran) : Promise.resolve(null)
      ]).then(function (r) {
        return { md: md, agg: agg, NUM: collapseSeries(r[0]), DEN: collapseSeries(r[1]),
                 dates: (r[0] || {}).dates || [] };
      }).catch(function () { return null; });
    });

    return Promise.all(jobs).then(function (parts) {
      parts = parts.filter(function (x) { return x && x.NUM; });
      if (!parts.length) return { multi: true, gran: gran, dates: [], series: [] };

      var outDates = parts[0].dates;          // koše už ze serveru
      var nB = outDates.length;

      var series = parts.map(function (pt) {
        var numArr = pt.NUM.vals, denArr = pt.DEN ? pt.DEN.vals : null;
        var raw = new Array(nB);
        for (var b = 0; b < nB; b++) {
          if (pt.agg.type === 'ratio') {
            // jmenovatel 0 → poměr NEEXISTUJE → díra. Nula by se četla jako „nejlepší koš".
            raw[b] = (denArr && denArr[b] != null && denArr[b] > 0 && numArr[b] != null)
              ? (numArr[b] / denArr[b]) : null;
          } else {
            raw[b] = numArr[b];
          }
        }
        return { id: pt.md.id, name: pt.md.label, kind: pt.md.kind, raw: raw };
      });

      return { multi: true, gran: gran, dates: outDates, series: series };
    });
  }

  // Σ spendu VŠECH sérií na každém indexu (den, nebo týdenní koš) → podklad pro ořez osy (D3).
  /* Σ spendu všech sérií na každém indexu řady. Řada je už v koších ze serveru (F7-3),
   * takže se tu nic dalšího neagreguje — jen se sečtou série. */
  function spendPerIndex(P) {
    if (!P) return null;
    var out = new Array(P.dates.length);
    for (var i = 0; i < out.length; i++) out[i] = 0;
    for (var k = 0; k < P.order.length; k++) {
      var d = P.byName[P.order[k]] || [];
      for (var j = 0; j < d.length && j < out.length; j++) {
        var v = Number(d[j]); if (isFinite(v)) out[j] += v;
      }
    }
    return out;
  }

  // Σ spendu za období per série (D1/D4 filtr malých sérií).
  function spendTotals(P) {
    if (!P) return null;
    var byName = {}, total = 0;
    for (var i = 0; i < P.order.length; i++) {
      var nm = P.order[i], d = P.byName[nm] || [], s = 0;
      for (var k = 0; k < d.length; k++) { var n = Number(d[k]); if (isFinite(n)) s += n; }
      byName[nm] = s; total += s;
    }
    return { byName: byName, total: total };
  }

  /* ---- načtení dat + render ---- */

  function scheduleLoad() {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(load, 60);      // debounce (periodchange+tabchange rychle po sobě)
  }

  function load() {
    if (!chart) return;
    var tab = currentTab();
    var st = state();
    var md = metricDef(tab);
    if (!md) { showOverlay('Server nehlásí žádnou metriku pro tenhle tab.', false); return; }
    var my = ++reqSeq;

    showOverlay('Načítám graf…', true);

    var split = (tab === 'earrings') ? EARRINGS_SPLIT : sel.split;
    var rng = chartRange(st);

    /* F7-2/MM — režim „Víc metrik" má vlastní loader i renderer.
     * Server o něm neví: pro dotazy se použije normální split (funnel / kreativy),
     * data se pak na klientovi sečtou přes série do jedné řady per metrika. */
    if (isMultiMode(tab)) {
      var all = metricsFor(tab);
      var picked = all.filter(function (m) { return sel.metricIds.indexOf(m.id) > -1; });
      if (!picked.length) picked = all.slice(0, 1);
      var qSplit = (tab === 'earrings') ? EARRINGS_SPLIT : 'funnel';
      loadMulti(tab, picked, qSplit, funnelCsv(), rng.from, rng.to, sel.gran)
        .then(function (payload) {
          if (my !== reqSeq) return;
          var vM = views[tab];
          if (vM) vM.last = { payload: payload, md: md };
          renderMultiChart(payload, tab);
        })
        .catch(function (err) {
          if (my !== reqSeq) return;
          showApiError(err, md, tab);
        });
      return;
    }

    loadAgg(tab, md, split, funnelCsv(), rng.from, rng.to, sel.gran)
      .then(function (payload) {
        if (my !== reqSeq) return;                 // zastaralá odpověď → ignoruj
        if (!Array.isArray(payload.series)) payload.series = [];
        if (!Array.isArray(payload.dates))  payload.dates  = [];
        var v = views[tab];
        if (v) v.last = { payload: payload, md: md };
        renderChart(payload, md, tab);
      })
      .catch(function (err) {
        if (my !== reqSeq) return;
        showApiError(err, md, tab);
      });
  }

  function rerender(tab) {
    var v = views[tab];
    if (!v || !v.last) { scheduleLoad(); return; }
    chart = v.chart; els = v.els;
    // F7-2/MM: multi payload umí vykreslit jen jeho vlastní renderer
    if (v.last.payload && v.last.payload.multi) renderMultiChart(v.last.payload, tab);
    else renderChart(v.last.payload, v.last.md, tab);
  }

  /* ---- E3: výška grafu (nahradila dataZoom — viz sekce 0d) ---------------- */
  function applyHeight(tab) {
    var v = views[tab];
    if (!v || !v.els.canvas) return;
    var c = v.els.canvas;
    for (var i = 0; i < HEIGHTS.length; i++) c.classList.remove('h-' + HEIGHTS[i].key);
    c.classList.add('h-' + sel.height);
    // CSS změní výšku okamžitě, ale ECharts drží plátno na staré velikosti → přeměř.
    // ResizeObserver by to chytil taky, jenže až v dalším rámci a s bliknutím.
    safeResize(v.chart, c);
  }

  // Chybu z api.php ukaž jako HLÁŠKU, ne jako prázdný graf (tichá lež).
  function showApiError(err, md, tab) {
    var status = err && err.status;
    var srv = (err && err.body && (err.body.error || err.body.message)) || '';
    var msg;
    if (status === 400) {
      msg = 'Server tuhle metriku pro tab „' + 'Reklamy' + '" nezná: ' +
            (md && md.label ? md.label : sel.metricId) + ' (' + (md && md.key) + ' / split ' +
            (tab === 'earrings' ? EARRINGS_SPLIT : sel.split) + ')' + (srv ? ' — ' + srv : '');
    } else if (status === 401) {
      msg = 'Přihlášení vypršelo — obnov stránku.';
    } else {
      msg = 'Graf se nepodařilo načíst' + (status ? ' (HTTP ' + status + ')' : '') + (srv ? ': ' + srv : '.');
    }
    if (chart) chart.clear();
    showOverlay(msg, false);
    renderFoot(md, -1, 0, null);
    if (els.note) els.note.hidden = true;
    if (window.ADS && ADS.toast) ADS.toast(msg, 'error');
    console.error('[charts] timeseries selhalo', { status: status, metric: md && md.key, split: sel.split, tab: tab, body: err && err.body });
  }

  /* D3 — OŘEŽ NA SKUTEČNÝ ROZSAH DAT.
   * Filip: „Náušnice mají 14 dní historie, ale při volbě 60 dní se kreslí měsíce prázdna."
   * Prázdno není informace, jen zmatek → najdi první a poslední index, kde je aspoň jedna
   * série s daty NEBO nenulový spend, a osu ořízni na něj. Vrací null = nic k ořezu.
   * (Spend bereme taky: kreativa se spendem a nulou konverzí je pořád „den, kdy se dělo".) */
  function realRange(dates, series, spendByIdx) {
    var lo = -1, hi = -1;
    for (var i = 0; i < dates.length; i++) {
      var any = false;
      if (spendByIdx && spendByIdx[i] > 0) any = true;
      for (var s = 0; !any && s < series.length; s++) {
        var v = series[s].data && series[s].data[i];
        if (v != null && isFinite(v) && v !== 0) any = true;
      }
      if (any) { if (lo < 0) lo = i; hi = i; }
    }
    if (lo < 0) return null;
    if (lo === 0 && hi === dates.length - 1) return null;   // není co ořezávat
    return { lo: lo, hi: hi };
  }

  /* A2 — ŠRAFOVANÝ PÁS: co teď znamená.
   *
   * ❌ DŘÍV: „posledních 14 dní / 3 týdny tržba dozrává" (časová zralost). ZAHOZENO —
   *    Filip tu veličinu nahradil (viz 0c) a nechat ji vedle nové zralosti by MÁTLO:
   *    dvě různá čísla, obě zvaná „zralost", každé o něčem jiném.
   *
   * ✅ TEĎ: pás značí JEN „poslední období ještě NENÍ KOMPLETNÍ" = data do něj pořád
   *    tečou (Meta spend má sklz ESTIMATING_DAYS; běžící týden není dojetý). To je fakt
   *    o ÚPLNOSTI OKNA, ne o dopočtu — a platí pro KAŽDOU metriku včetně spendu, protože
   *    i spend za dnešek se ještě dosype.
   *    Zralost (kolik z čísla je dopočet) se ukazuje JINDE a JINAK: v hoveru, číselně,
   *    s barvou dle A3. Jedna věc = jeden vizuál, žádné dvojí čtení téhož šrafování.
   *
   * Proč jsem šrafování nezrušil úplně: běžící týden má reálně naběhnutou jen část spendu
   * i tržby, takže jeho sloupec/bod JE nesrovnatelný se zavřenými týdny — a to na zralosti
   * vidět NENÍ (týden 13. 7. má zralost 50 %, což je úplně normální hodnota; nekompletní
   * je kvůli tomu, že běží, ne kvůli dopočtu). Bez pásu by Filip četl poslední bod jako
   * propad. Ověřeno na ostrých datech 16. 7.
   *
   * Vrací -1, když není co šrafovat. */
  function incompleteBandStart(weekly, L) {
    var back = weekly ? 1 : estimatingDays();      // týden: jen ten běžící · den: sklz Mety
    var start = L - back;
    if (start <= 0) return (L > 0 && back > 0) ? 0 : -1;
    return start;
  }

  /* F7-2/MM — vykreslení režimu „Víc metrik".
   * VLASTNÍ cesta, ne větev v renderChart(): ta má za sebou desítky doladěných detailů
   * (ořez osy, filtr malých sérií, šrafování, zralost v tooltipu) navázaných na JEDNU
   * metriku. Vetknout do ní druhý režim = riziko, že se rozbije to, co roky funguje.
   *
   * ⚠️ MĚŘÍTKO: metriky mají neporovnatelné řády (spend ~100 000, ROAS ~4, CPL ~150).
   * Na společné ose by ROAS i CPL splynuly s nulou. Proto se každá kreslí jako
   * % SVÉHO maxima v okně — čte se z toho TVAR (co roste, co padá, kde se to láme),
   * což je přesně, co Filip chtěl („abych viděl, jak běží všechny tyto metriky").
   * SKUTEČNÉ hodnoty jsou v tooltipu a patička to říká nahlas, ať to nikdo neplete. */
  function renderMultiChart(payload, tab) {
    var dates  = payload.dates || [];
    var series = payload.series || [];
    if (!dates.length || !series.length) {
      chart.clear();
      showOverlay('Pro zvolené období nejsou data.', false);
      if (els.foot) els.foot.innerHTML = '';
      if (els.note) els.note.hidden = true;
      return;
    }
    hideOverlay();

    var granKey = payload.gran || 'day';
    var aggregated = (granKey === 'week' || granKey === 'month');
    var L = dates.length;
    var bandStart = incompleteBandStart(aggregated, L);

    // normalizace: každá metrika na % svého maxima (kladné hodnoty; záporné se nečekají)
    var norm = series.map(function (s2) {
      var mx = 0;
      for (var i = 0; i < s2.raw.length; i++) {
        var v = Number(s2.raw[i]);
        if (s2.raw[i] != null && isFinite(v) && v > mx) mx = v;
      }
      var data = s2.raw.map(function (v) {
        if (v == null || !isFinite(Number(v))) return null;
        return mx > 0 ? Math.round(Number(v) / mx * 1000) / 10 : 0;
      });
      return { name: s2.name, kind: s2.kind, raw: s2.raw, max: mx, data: data };
    });

    var lay = legendLayout(els.canvas.clientWidth || 900);
    var ecSeries = norm.map(function (s2) {
      return {
        name: s2.name, type: 'line', smooth: true, showSymbol: false,
        connectNulls: false, lineStyle: { width: 2 },
        emphasis: { focus: 'series' },
        itemStyle: { color: colorFor(s2.name) },
        data: s2.data
      };
    });

    // šrafovaný pás přes poslední (nekompletní) koš — stejná konvence jako hlavní graf
    if (bandStart >= 0 && bandStart < L) {
      ecSeries.push({
        name: '__guide__', type: 'line', data: [], silent: true, showSymbol: false,
        markArea: {
          silent: true, itemStyle: { color: 'rgba(140,130,110,.07)' },
          data: [[{ xAxis: dates[bandStart] }, { xAxis: dates[L - 1] }]]
        }
      });
    }

    var names = norm.map(function (s2) { return s2.name; });
    chart.setOption({
      color: PALETTE,
      grid: { left: 8, right: lay.side ? lay.w + 18 : 12, top: GRID_TOP, bottom: lay.side ? 28 : 54, containLabel: true },
      legend: legendOpt(names, null, lay),
      tooltip: Object.assign(tooltipBase(), {
        formatter: function (params) {
          if (!params || !params.length) return '';
          var idx = params[0].dataIndex;
          var head = '<div style="font-weight:600;margin-bottom:6px;color:' + INK + '">' +
            (granKey === 'month' ? esc(monthLabelLong(params[0].axisValue))
             : granKey === 'week' ? esc(weekLabelRange(params[0].axisValue, { from: state().from, to: state().to }))
             : esc(fmtDate(params[0].axisValue))) +
            (bandStart >= 0 && idx >= bandStart
              ? '<span style="font-weight:400;color:' + MUTED + '"> · ' +
                (aggregated ? 'běží' : 'data dotékají') + '</span>' : '') + '</div>';
          var body = '';
          for (var i = 0; i < norm.length; i++) {
            var raw = norm[i].raw[idx];
            if (raw == null) continue;
            body += '<div style="display:flex;align-items:center;gap:7px;margin:2px 0;">' +
              '<span style="width:8px;height:8px;border-radius:2px;background:' + colorFor(norm[i].name) + '"></span>' +
              '<span style="flex:1;color:' + MUTED + '">' + esc(norm[i].name) + '</span>' +
              '<b style="color:' + INK + '">' + esc(fmtValue(raw, norm[i].kind)) + '</b></div>';
          }
          return body ? head + body : '';
        }
      }),
      xAxis: {
        type: 'category', boundaryGap: false, data: dates,
        axisLine: { lineStyle: { color: GRID } }, axisTick: { show: false },
        axisLabel: {
          color: MUTED, fontSize: 11, hideOverlap: true,
          formatter: function (val) {
            return granKey === 'month' ? monthLabel(val)
                 : granKey === 'week'  ? weekLabel(val)
                 : fmtDate(val);
          }
        }
      },
      yAxis: {
        type: 'value', min: 0, max: 105,
        name: '% maxima', nameGap: AXIS_NAME_GAP,
        nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: GRID } },
        axisLabel: { color: MUTED, fontSize: 11, formatter: function (v) { return Math.round(v) + ' %'; } }
      },
      series: ecSeries
    }, { notMerge: true });

    // patička: skutečná maxima, ať je jasné, co je „100 %"
    if (els.foot) {
      // `.acx-bit` je existující třída patičky — nezavádíme novou jen kvůli tomuhle.
      els.foot.innerHTML = '<span class="acx-bit">100 % =</span>' + norm.map(function (s2) {
        return '<span class="acx-bit"><span style="width:8px;height:8px;border-radius:2px;display:inline-block;' +
          'background:' + colorFor(s2.name) + ';margin-right:5px"></span>' + esc(s2.name) +
          ' <b>' + esc(fmtValue(s2.max, s2.kind)) + '</b></span>';
      }).join('<span class="acx-sep">·</span>');
    }
    if (els.note) {
      els.note.hidden = false;
      els.note.innerHTML = 'Každá metrika je vykreslená jako <b>% svého vlastního maxima</b> ' +
        've zvoleném okně — jinak by ROAS (~4) zmizel vedle spendu (~100 000). ' +
        'Porovnávej <b>tvar</b> křivek (co roste, co padá, kde se to láme); ' +
        '<b>skutečné hodnoty</b> jsou v tooltipu a maxima v legendě pod grafem.';
    }
  }

  function renderChart(payload, md, tab) {
    var dates  = payload.dates || [];
    var series = payload.series || [];
    var spendInfo = payload.spend || null;
    /* F7-2/M: `weekly` teď znamená „agregováno" (týden NEBO měsíc) — obojí se chová
     * stejně (koš, ne den; šrafuje se poslední běžící koš). Popisky se liší → `granKey`. */
    var granKey = payload.gran || 'day';
    var weekly = (granKey === 'week' || granKey === 'month');

    if (!dates.length || !series.length) {
      chart.clear();
      showOverlay('Pro zvolené období nejsou data.', false);
      renderFoot(md, -1, 0, null);
      if (els.note) els.note.hidden = true;
      return;
    }
    hideOverlay();

    var isRoas  = md.kind === 'roas';
    var ratio   = isRatioKind(md.kind);
    var useArea = (md.kind === 'money' || md.kind === 'count');

    /* --- D3: ořež osu na skutečný rozsah dat (spend SE POČÍTÁ jako data) --- */
    var trim = realRange(dates, series, payload.spendByIdx);
    if (trim) {
      dates = dates.slice(trim.lo, trim.hi + 1);
      series = series.map(function (s) {
        return { name: s.name, data: (s.data || []).slice(trim.lo, trim.hi + 1), estIdx: s.estIdx,
                 // A4 — zralost se musí ořezat SPOLU s daty, jinak se rozjede index
                 // a tooltip by u týdne ukazoval zralost jiného týdne.
                 mat: s.mat ? s.mat.slice(trim.lo, trim.hi + 1) : s.mat };
      });
    }
    var L = dates.length;

    /* --- D1/D4 krok 1: rozděl série na „velké" a „malé" (dle spendu období) ---
       Neznámý spend = série zůstává (radši nic neschovat, než schovat bez důkazu).
       „Ostatní" je agregát → nikdy se neskrývá.

       ★ G6 (Filip 17. 7.): „ten poslední graf je furt jako na hovno, v tom se nedá moc vyznat,
       to ještě kriticky projdi a zkus to vymyslet přehledněji, abys tam ty data fakt viděl."
       PŘÍČINA (změřeno naostro v prohlížeči, ne odhad): graf měl **23 sérií** — 11 funnelů,
       každý DVAKRÁT (plná čára + čárkovaný ocas pro nedojetá data). Jedenáct překrytých
       křivek nepřečte nikdo.
       Filtr „malých" (< 1 % spendu okna) přitom EXISTOVAL, ale běžel jen u POMĚROVÝCH metrik
       (ratio) — a default metrika je **Spend**, takže se nikdy nezapnul a lezlo tam všechno.
       → Pouštíme ho na VŠECHNY metriky. Nic se nemaže: schované série jdou jedním klikem
         zpátky („+N malých") a součet nezkreslí, protože „Ostatní" agreguje server. */
    var thr = null, small = [], vis = [], built = [];
    if (spendInfo && spendInfo.total > 0) thr = spendInfo.total * SMALL_SPEND_PCT;

    /* --- A2: kde začíná NEKOMPLETNÍ (šrafovaný) ocas — viz incompleteBandStart --- */
    var bandStart = incompleteBandStart(weekly, L);

    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      var name = (s.name != null && s.name !== '') ? String(s.name) : '(bez názvu)';
      var raw = (s.data || []).map(num);
      var sp = (spendInfo && spendInfo.byName) ? spendInfo.byName[name] : undefined;
      var isSmall = (thr != null && name !== 'Ostatní' && sp !== undefined && sp < thr);
      built.push({ name: name, color: colorFor(name), data: raw, mat: s.mat,
                   estIdx: (bandStart < 0 ? L : bandStart), spend: sp, small: isSmall });
    }

    for (var b0 = 0; b0 < built.length; b0++) {
      if (built[b0].small && !sel.showSmall) small.push(built[b0]);
      else vis.push(built[b0]);
    }
    // Kdyby byly „malé" úplně všechny (extrémně roztříštěné období), radši ukaž vše
    // než prázdný graf — a napiš to v patičce.
    var allSmall = false;
    if (!vis.length && small.length) { vis = small.slice(); small = []; allSmall = true; }

    /* --- F1 krok 2: ochrana osy (p95), když outlier i tak plácne graf --- */
    var clip = sel.noClip ? null : clipInfo(vis, md.kind);

    /* --- série --- */
    var echSeries = [], legendNames = [], endDots = [];
    var matByName = Object.create(null);        // A4 — tooltip si sáhne pro zralost
    for (var b = 0; b < vis.length; b++) {
      var it = vis[b];
      legendNames.push(it.name);
      if (it.mat) matByName[it.name] = it.mat;
      var solid = new Array(L), dashed = new Array(L), hasDashed = false;
      for (var k = 0; k < L; k++) {
        solid[k]  = (k <= it.estIdx - 1) ? it.data[k] : null;   // potvrzená část
        dashed[k] = (k >= it.estIdx - 1) ? it.data[k] : null;   // estimating (o 1 zpět kvůli napojení)
        if (k >= it.estIdx && it.data[k] != null) hasDashed = true;
      }
      echSeries.push({
        name: it.name, type: 'line', data: solid,
        showSymbol: false, symbolSize: 6, connectNulls: false, smooth: false,
        lineStyle: { width: 2.2, color: it.color },
        itemStyle: { color: it.color },
        emphasis: { focus: 'series', lineStyle: { width: 3 } },
        areaStyle: useArea ? { color: hexA(it.color, 0.10) } : undefined,
        z: 3
      });
      if (hasDashed) {
        echSeries.push({
          name: it.name, type: 'line', data: dashed,
          showSymbol: false, symbolSize: 5, connectNulls: false, smooth: false,
          lineStyle: { width: 2, color: it.color, type: 'dashed', opacity: 0.85 },
          itemStyle: { color: it.color, opacity: 0.7 },
          areaStyle: useArea ? { color: hexA(it.color, 0.05) } : undefined,
          /* ⚠️ TOOLTIP TU MUSÍ ZŮSTAT ZAPNUTÝ. Bývalo tu `tooltip:{show:false}` („hodnotu
           * ukáže plná série"), jenže na ŠRAFOVANÉM ocasu má plná série null → formatter
           * neměl JEDINÝ platný řádek → na posledních koších se tooltip NEUKÁZAL VŮBEC
           * (Filip 14. 8.: „červenec vidím, srpen už ne, přestože tyčka tam vede").
           * Duplicitu na styčném bodě řeší dedup ve formatteru (seen[seriesName]). */
          z: 2
        });
        /* Koncový bod šrafované linky (Filip 14. 8.): trvale viditelný kroužek na
         * POSLEDNÍM koši, ať je kam najet myší pro aktuální (dotékající) hodnoty.
         * Vlastní scatter série, protože `showSymbol:false` na čáře zahazuje i per-bod
         * symboly; `silent` → nekrade hover ose, tooltip řeší axisPointer. */
        for (var e0 = L - 1; e0 >= 0; e0--) {
          if (dashed[e0] != null) {
            endDots.push({ value: [dates[e0], dashed[e0]],
                           itemStyle: { color: it.color, borderColor: '#fff', borderWidth: 1.5 } });
            break;
          }
        }
      }
    }

    // koncové body šrafovaných ocasů (mimo legendu — legend.data je jen legendNames)
    if (endDots.length) {
      echSeries.push({
        name: '__endDots__', type: 'scatter', silent: true, data: endDots,
        symbolSize: 7, tooltip: { show: false }, z: 4
      });
    }

    // guide série: pás nekompletních dat, hranice a referenční linky (mimo legendu)
    var markAreaData = [], markLineData = [];
    if (bandStart >= 0 && bandStart < L) {
      markAreaData.push([{ xAxis: dates[bandStart] }, { xAxis: dates[L - 1] }]);
      markLineData.push({
        xAxis: dates[bandStart],
        label: { formatter: 'data dotékají', color: MUTED, fontSize: 10, position: 'insideEndTop' },
        lineStyle: { color: EST_LINE, type: 'dashed', width: 1 }
      });
    }
    /* C3 — break-even linka. Dnes PLOŠNÁ 2,0 → kontext funnelu se neřeší a linka je
     * i na tabu Náušnice (config: „Náušnice" => 2). Kontext se pořád posílá pro případ,
     * že by se někdy jeden funnel odlišil (mechanika v roasRefLines žije):
     *   split=funnel        → funnel JE název série (jen VIDITELNÉ, tj. `vis`)
     *   split=event/optim.  → funnel míchá; jen když je vyfiltrovaný jeden (sel.funnel)
     * ⚠️ NIKDY nekreslíme 1,0 „aspoň něco" — to byla ta lež z C3. */
    var beInfo = null;
    if (isRoas) {
      var ctxFunnels = [];
      if (tab === 'rings') {
        if (sel.split === 'funnel') ctxFunnels = vis.map(function (x) { return x.name; });
        else if (Array.isArray(sel.funnel) && sel.funnel.length) ctxFunnels = sel.funnel.slice();
      }
      beInfo = roasRefLines(ctxFunnels);
      for (var rl = 0; rl < beInfo.lines.length; rl++) markLineData.push(beInfo.lines[rl]);
      /* ⚠️ POPISKY SE NESMÍ PŘEKRÝT. break-even (2,0) sedí VLEVO nahoře, winner (5,0)
       * proto VPRAVO. Dřív byly OBA vlevo (break-even „insideStartTop" + winner
       * „insideStartTop") — dokud byly hodnoty 1,5/2,0/3,0 tři, rozdíl 1,0 ROAS ≈ 21 px
       * je udržel oddělené, jenže po zploštění na JEDNU linku 2,0 zbyly vlevo dva texty
       * vzdálené 1,0 ROAS a při nízkém grafu (přepínač „Nízký" = 250 px) se slily.
       * Rozhodit je na opačné strany je proti tomu imunní na jakékoli výšce i rozsahu osy. */
      markLineData.push(refLine(winnerRoas(), 'winner ' + axisLabel(winnerRoas(), 'roas'), REF_WINNER, 'insideEndTop'));
    }
    echSeries.push({
      name: '__guide__', type: 'line', data: [], silent: true, z: 1,
      markArea: markAreaData.length ? { silent: true, itemStyle: { color: EST_BAND }, data: markAreaData } : undefined,
      markLine: markLineData.length ? {
        silent: true, symbol: 'none', data: markLineData,
        lineStyle: { width: 1 }, emphasis: { disabled: true }
      } : undefined
    });

    // zachovej výběr legendy pro série, které stále existují (napříč změnou metriky)
    var prevSel = {};
    try {
      var po = chart.getOption();
      if (po && po.legend && po.legend[0] && po.legend[0].selected) prevSel = po.legend[0].selected;
    } catch (e) { /* noop */ }
    var selected = {};
    for (var n = 0; n < legendNames.length; n++) {
      selected[legendNames[n]] = (prevSel[legendNames[n]] === undefined) ? true : prevSel[legendNames[n]];
    }

    var lay = chartLayout((els.canvas && els.canvas.clientWidth) || 900);

    chart.setOption({
      color: PALETTE,
      animationDuration: 320,
      grid: gridOpt(lay),
      legend: legendOpt(legendNames, selected, lay),
      tooltip: Object.assign(tooltipBase(), { formatter: makeTooltip(md, weekly, matByName, bandStart, granKey) }),
      // E2/E3 — dataZoom je pryč (viz 0d) → osa Y drží nulu NATIVNĚ přes min:0.
      xAxis: {
        type: 'category', boundaryGap: false, data: dates,
        axisLine: { lineStyle: { color: AXIS } },
        axisTick: { show: false },
        axisLabel: { color: MUTED, fontSize: 11, hideOverlap: true,
                     formatter: function (val) {
                       return granKey === 'month' ? monthLabel(val)
                            : granKey === 'week'  ? weekLabel(val)
                            : fmtDate(val); } }
      },
      yAxis: yValueAxis(md.kind, clip ? clip.max : null),
      series: echSeries
    }, { notMerge: true });
    chart.resize();

    var hasMat = Object.keys(matByName).length > 0;
    renderNote(md, tab, weekly, dates, trim, hasMat);
    renderFoot(md, bandStart, L, {
      small: small, thr: thr, clip: clip, allSmall: allSmall, weekly: weekly, tab: tab,
      spendMissing: (ratio && !spendInfo), be: beInfo, hasMat: hasMat, isRoas: isRoas
    });
  }

  /* tooltip: dedup série podle jména (plná vs. přerušovaná), skip null, seřaď desc.
   *
   * A4 (FEEDBACK-3) — u TRŽBOVÝCH metrik nese KAŽDÝ řádek i ZRALOST té série v tom
   * týdnu/dni: barevný kroužek (A3) + „XX % reálné". Filip: „chtěl bych tam vidět
   * i procento zralosti… tady to mi dává představu", „to je důležité".
   * Bez ní je „ROAS 0,54×" nečitelné — nevíš, jestli je dopočtené z 90 % nebo z 25 %.
   * A5 — hlavička „Týden od 6. 7." (ne „2026-07-06", ne „7-6"). */
  function makeTooltip(md, weekly, matByName, bandStart, granKey) {
    var showMat = metricRevenueBased(md) && matByName && Object.keys(matByName).length > 0;
    return function (params) {
      if (!params || !params.length) return '';
      var seen = {}, order = [];
      for (var i = 0; i < params.length; i++) {
        var p = params[i];
        if (p.seriesName === '__guide__') continue;
        var v = p.value;
        var valid = !(v == null || v === '' || isNaN(v));
        if (!(p.seriesName in seen)) { seen[p.seriesName] = { color: p.color, value: valid ? Number(v) : null }; order.push(p.seriesName); }
        else if (valid) { seen[p.seriesName].value = Number(v); if (p.color) seen[p.seriesName].color = p.color; }
      }
      var idx = params[0].dataIndex;
      var rows = [];
      for (var j = 0; j < order.length; j++) {
        var o = seen[order[j]];
        if (o.value == null) continue;
        var mv = (showMat && matByName[order[j]]) ? matByName[order[j]][idx] : undefined;
        rows.push({ name: order[j], color: o.color, value: o.value, mat: (mv === undefined ? null : mv) });
      }
      rows.sort(function (a, b) { return b.value - a.value; });
      if (!rows.length) return '';

      // N6 — u týdnů „Týden 6. 7. – 12. 7." (Filip: v hoveru OD KDY DO KDY).
      // Clamp na zvolené období: koš ISO týdne může začínat před `from` (okno 17. 6.
      // → první koš od 15. 6.) a poslední týden končí dneškem, ne v neděli.
      var st0 = state();
      var head = '<div style="font-weight:600;margin-bottom:6px;color:' + INK + '">' +
                 (granKey === 'month'
                   ? esc(monthLabelLong(params[0].axisValue))
                   : weekly
                   ? esc(weekLabelRange(params[0].axisValue, { from: st0.from, to: st0.to }))
                   : esc(fmtDate(params[0].axisValue))) +
                 (bandStart >= 0 && idx >= bandStart
                   ? '<span style="font-weight:400;color:' + MUTED + '"> · ' +
                     (weekly ? 'běží' : 'data dotékají') + '</span>' : '') +
                 '</div>';
      var body = '';
      for (var r = 0; r < rows.length; r++) {
        body += '<div style="display:flex;align-items:center;gap:7px;margin:2px 0;">' +
          '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + rows[r].color + ';"></span>' +
          '<span style="flex:1;color:' + INK + ';">' + esc(truncate(rows[r].name, 30)) + '</span>' +
          (showMat
            ? '<span style="margin-left:10px;color:' + matColor(rows[r].mat) + ';font-size:11.5px;' +
              'font-weight:600;white-space:nowrap" title="zralost">' + matDot(rows[r].mat) + ' ' +
              esc(matPct(rows[r].mat)) + '</span>'
            : '') +
          '<span style="font-weight:600;color:' + INK + ';margin-left:12px;">' + fmtValue(rows[r].value, md.kind) + '</span>' +
          '</div>';
      }
      if (showMat) {
        body += '<div style="border-top:1px solid #efe8db;margin:6px 0 4px"></div>' +
                '<div style="color:' + MUTED + ';font-size:11px;max-width:270px;white-space:normal">' +
                'Kroužek = <b>zralost</b>: kolik % tržby je reálné (zbytek dopočet). ' +
                '<span style="color:' + MAT_RED + '">&lt;25 %</span> · ' +
                '<span style="color:' + MAT_ORANGE + '">25–50 %</span> · ' +
                '<span style="color:' + MAT_YELLOW + '">50–75 %</span> · ' +
                '<span style="color:' + MAT_GREEN + '">&gt;75 %</span></div>';
      }
      return head + body;
    };
  }

  /* A4 + D3 — VĚTA NAD GRAFEM. Musí být vidět dřív, než Filip začne číst čísla. */
  function renderNote(md, tab, weekly, dates, trim, hasMat) {
    if (!els.note) return;
    var bits = [];

    if (hasMat) {
      bits.push('<b>V hoveru je u každé série i zralost</b> — kolik % té tržby jsou reálné ' +
                'peníze a kolik dopočet (% provolaných × % proběhlých schůzek). ' +
                'ROAS už dopočet obsahuje; zralost říká, <b>nakolik tomu číslu věřit</b> — ' +
                'je rozdíl, když je dopočtené z 25 % nebo z 90 %.');
    } else if (metricRevenueBased(md)) {
      // A0 — proč tu zralost NENÍ. Radši to říct, než aby ji Filip hledal (nebo aby
      // se dopočítala jinak než všude jinde a ukázala jiné číslo pod stejným jménem).
      bits.push('<b>Zralost tu v hoveru není</b> — ' +
                (tab === 'earrings'
                  ? 'server ji umí rozpadnout jen po <b>funnelech a eventech</b>, a tenhle graf ' +
                    'jede po kreativách. Zralost každé kreativy je v tabulce níž a v jejím rozkliku.'
                  // rings: funnel/event/optimalizace zralost UMÍ (optimization == event) →
                  // když tu tahle věta je, nepovedl se dotáhnout *_trend. Reload obvykle stačí.
                  : 'nepovedlo se ji dotáhnout z trendu (viz konzole). Zkus reload.'));
    }
    // D3 — když se osa ořízla, řekni od kdy data vůbec jsou (jinak to vypadá jako chyba)
    if (trim && dates.length) {
      bits.push('Tenhle tab má data až <b>od ' + esc(fmtDate(dates[0])) + '</b> — ' +
                'prázdné období před ním je oříznuté, ať graf nekreslí měsíc nicoty.');
    }

    if (!bits.length) { els.note.hidden = true; return; }
    els.note.innerHTML = bits.join(' ');
    els.note.hidden = false;
  }

  // Patička = MÍSTO, KDE SE PŘIZNÁVÁ, co graf neukazuje. Nikdy tiše nezkreslovat.
  function renderFoot(md, bandStart, L, info) {
    if (!els.foot) return;
    info = info || {};
    var bits = [];

    if (bandStart >= 0 && bandStart < L) {
      var n = L - bandStart;
      // A2 — pás značí NEKOMPLETNÍ okno (data tečou), NE dozrávání tržby. Viz incompleteBandStart.
      var what = info.weekly
        ? 'běžící týden šrafovaně — ještě není dojetý'
        : ('poslední ' + n + ' dny šrafovaně — data z Mety ještě dotékají');
      bits.push('<span class="hatch"></span><span>' + esc(what) + '. Nesrovnávej se staršími.</span>');
    }
    // C3 — legenda referenčních linek. ŽÁDNÁ „1,0" (byla to lež). Dnes JEDNA plošná 2,0.
    if (info.isRoas && info.be) {
      if (info.be.drawn.length) {
        for (var d0 = 0; d0 < info.be.drawn.length; d0++) {
          var dd0 = info.be.drawn[d0];
          bits.push('<span style="color:' + dd0.color + '">┅ ' + esc(beLabel(dd0.funnel, dd0.value)) +
                    '</span>' + (dd0.names.length > 1 ? '<span> (' + esc(dd0.names.length + '× funnel') + ')</span>' : ''));
        }
        bits.push(info.be.flat
          ? '<span class="warn">Platí plošně pro všechny funnely i náušnice. Pod linkou = prodělek → kill. ' +
            'Těsně nad ní taky není OK.</span>'
          : '<span class="warn">Pod linkou = prodělek → kill. Těsně nad ní taky není OK.</span>');
      } else if (info.tab === 'rings') {
        bits.push('<span class="warn">Break-even linka není: pro tenhle funnel není break-even ' +
                  'zadaný. Radši žádná linka než lživá.</span>');
      }
      bits.push('<span style="color:' + REF_WINNER + '">┅ winner ' + axisLabel(winnerRoas(), 'roas') + '</span>');
    }
    // A4 — legenda barev zralosti (hodnoty samotné jsou v hoveru)
    if (info.hasMat) {
      bits.push('<span>zralost v hoveru: ' +
                '<span style="color:' + MAT_RED + '">●&lt;25 %</span> ' +
                '<span style="color:' + MAT_ORANGE + '">●25–50</span> ' +
                '<span style="color:' + MAT_YELLOW + '">●50–75</span> ' +
                '<span style="color:' + MAT_GREEN + '">●&gt;75</span></span>');
    }

    // F1 — skryté malé série (VŽDY vyjmenované + zrušitelné)
    var mName = (md && md.kind === 'roas') ? 'ROAS' : ((md && md.label) || 'hodnota');
    if (info.small && info.small.length) {
      var names = info.small.map(function (s) { return truncate(s.name, 22); });
      var shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) + ' dalších' : '');
      bits.push('<span class="warn">' + plSkryto(info.small.length) + ' s malým spendem (&lt; ' +
                fmtMoney(info.thr) + ' za období): ' + esc(shown) + ' — ' + esc(mName) + ' na nich ustřeluje.</span>' +
                ' <button type="button" class="acx-link" data-acx="show-small">zobrazit i je</button>');
    } else if (info.allSmall) {
      bits.push('<span class="warn">Všechny série mají malý spend (&lt; ' + fmtMoney(info.thr) +
                ') → nefiltruji, ale ' + esc(mName) + ' ber s rezervou.</span>');
    } else if (info.spendMissing) {
      bits.push('<span class="warn">Spend sérií se nenačetl → malé série nešlo odfiltrovat (' +
                esc(mName) + ' může ustřelovat).</span>');
    }

    // F1 — ořez osy (VŽDY napsaný + zrušitelný)
    if (info.clip) {
      var cn = info.clip.names.map(function (x) { return truncate(x, 22); }).slice(0, 3).join(', ');
      bits.push('<span class="warn">Osa oříznuta na p95 (' + axisLabel(info.clip.max, md.kind) + ') — ' +
                plSerie(info.clip.names.length) +
                ' mimo rozsah: ' + esc(cn) + '. Hodnoty jsou celé v tooltipu.</span>' +
                ' <button type="button" class="acx-link" data-acx="no-clip">zrušit ořez</button>');
    } else if (sel.noClip) {
      bits.push('<button type="button" class="acx-link" data-acx="do-clip">zapnout ořez osy (p95)</button>');
    }

    els.foot.innerHTML = footHTML(bits);            // M3 — 1 bit = 1 flex item
    els.foot.style.display = bits.length ? 'flex' : 'none';

    var a = els.foot.querySelector('[data-acx="show-small"]');
    if (a) a.addEventListener('click', function () {
      sel.showSmall = true;
      buildControls(currentTab());
      rerender(currentTab());
    });
    var b = els.foot.querySelector('[data-acx="no-clip"]');
    if (b) b.addEventListener('click', function () { sel.noClip = true; rerender(currentTab()); });
    var c = els.foot.querySelector('[data-acx="do-clip"]');
    if (c) c.addEventListener('click', function () { sel.noClip = false; rerender(currentTab()); });
  }

  /* =========================================================================
   * 7) TÝDENNÍ GRAF (FEEDBACK F4) → #weekly-root
   *    ADS.api('weekly', { weeks:18, tab }) — tvar odpovědi bereme tolerantně
   *    (viz normalizeWeekly), ať se FE nerozbije o detail formátu z api.php.
   * ====================================================================== */

  var weekly = { root: null, chart: null, els: {}, seq: 0,
    /* G2: zvolená metrika horního grafu. Pamatuje se — Filip se dívá na to, co ho zrovna
       pálí, a nechce to po každém reloadu přepínat zpátky. */
    metric: (function () {
      try {
        var v = localStorage.getItem('ads.weekly.metric');
        // Whitelist natvrdo: W_METRICS je definované až níž a stará/pokažená hodnota
        // v localStorage by jinak shodila graf hned při startu.
        return ['roas', 'revenue', 'spend', 'cpl', 'cpa'].indexOf(v) > -1 ? v : 'roas';
      } catch (_) { return 'roas'; }
    })(),
    /* Filip: „to v závorce posledních 18 týdnů dej pryč a dej mi tam variantu, kolik dnů" →
     * přepínač horizontu 30/90/180 dní (fetch přepočítá na týdny). Pamatuje se. */
    days: (function () {
      try { var v = parseInt(localStorage.getItem('ads.weekly.days'), 10);
        return [30, 90, 180].indexOf(v) > -1 ? v : 180; } catch (_) { return 180; }
    })()
  };
  var WEEKLY_DAY_OPTS = [30, 90, 180];
  function weeklyWeeks() { return Math.max(3, Math.ceil((weekly.days || 180) / 7)); }

  /* A5 + N6 — TÝDNY ČESKY. Filip: hover musí říct „Týden od 6. 7.", ne „7-6".
   * Odkud se „7-6" bralo: tooltip týdenního grafu skládal `'Týden ' + d.labels[i]`,
   * jenže `d.labels[i]` je SYROVÝ `week_start` z api.php = „2026-07-06" → v bublině
   * stálo „Týden 2026-07-06". weekLabel() se na něj vůbec nepustil. Opraveno: všechny
   * hlavičky jedou přes weekLabelLong()/weekLabelRange().
   *
   * ⚠️ N6 (FEEDBACK-5) — Filip: „v legendě stačí ten začátek, ale kde je víc info
   *    (hover/tooltip), tam má být OD KDY DO KDY." → TŘI úrovně, každá na svém místě:
   *      weekLabel      → „6. 7."               osa X (musí být krátké, jinak se popisky slijí)
   *      weekLabelLong  → „Týden od 6. 7."      legenda / úzké hlavičky
   *      weekLabelRange → „Týden 6. 7. – 12. 7." VŠECHNY tooltipy (tady je místo na plnou informaci)
   *
   * ⚠️ Konec týdne se NEHÁDÁ na start+6, když ho server pošle (`week_end` posílá
   *    `?action=weekly` i `funnel_trend`) — a hlavně se KLAMPUJE na zvolené období:
   *    okno 17. 6. – 16. 7. má první koš ISO týdne od 15. 6., ale data z 15.–16. 6.
   *    v něm NEJSOU. Tooltip „15. 6. – 21. 6." by tedy lhal o rozsahu, ze kterého to
   *    číslo je. Ověřeno naostro: funnel_trend vrací buckets od 2026-06-15 pro
   *    from=2026-06-17 → clamp posune start na 17. 6. Poslední (běžící) týden se
   *    stejným způsobem ořízne na dnešek a nese navíc „· běží". */
  /** F7-2/M: popisek měsíčního koše — „Čec 26" na osu, ať se nečte jako datum dne. */
  var MES_SHORT = ['led','úno','bře','dub','kvě','čvn','čvc','srp','zář','říj','lis','pro'];
  function monthLabel(v) {
    var m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})/);
    if (!m) return String(v);
    return (MES_SHORT[Number(m[2]) - 1] || m[2]) + ' ' + m[1].slice(2);
  }
  var MES_LONG = ['Leden','Únor','Březen','Duben','Květen','Červen',
                  'Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];
  function monthLabelLong(v) {
    var m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})/);
    if (!m) return String(v);
    return (MES_LONG[Number(m[2]) - 1] || m[2]) + ' ' + m[1];
  }

  function weekLabel(v) {
    var s = String(v == null ? '' : v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Number(m[3]) + '. ' + Number(m[2]) + '.';       // začátek týdne → „16. 6."
    var w = s.match(/^(\d{4})-?W(\d{1,2})$/i);
    if (w) return 'T' + Number(w[2]);                              // ISO týden → „T25"
    return s;
  }
  function weekLabelLong(v) {
    var s = String(v == null ? '' : v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'Týden od ' + weekLabel(s);
    var w = s.match(/^(\d{4})-?W(\d{1,2})$/i);
    if (w) return Number(w[2]) + '. kalendářní týden';
    return 'Týden ' + s;
  }
  /** Dnešek jako 'YYYY-MM-DD' — LOKÁLNĚ, ne v UTC.
   *  ⚠️ `new Date().toISOString()` by v CEST (UTC+2) vrátilo do 02:00 ráno VČEREJŠÍ datum
   *      → běžící týden by se v tooltipu ořízl o den dřív. Server (PHP date('Y-m-d'))
   *      jede taky v lokálním čase, takže tohle s ním drží krok. */
  function todayStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1), day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }
  /** 'YYYY-MM-DD' + n dní → 'YYYY-MM-DD' (UTC — stejný důvod jako u isoWeekStart). */
  function addDaysStr(s, n) {
    var d = asDateStr(s);
    if (!d) return null;
    var t = new Date(d + 'T00:00:00Z');
    if (isNaN(t.getTime())) return null;
    return new Date(t.getTime() + n * 86400000).toISOString().slice(0, 10);
  }
  /** N6 — „6. 7. – 12. 7." (rozsah týdne, oříznutý na zvolené okno).
   *  `end` = konec ze serveru (week_end), jinak start+6. Vrací null, když start není datum. */
  function weekRangeTxt(start, opts) {
    opts = opts || {};
    var s = asDateStr(start);
    if (!s) return null;
    var e = asDateStr(opts.end) || addDaysStr(s, 6);
    if (!e) return null;
    if (opts.from && asDateStr(opts.from) && asDateStr(opts.from) > s) s = asDateStr(opts.from);
    if (opts.to   && asDateStr(opts.to)   && asDateStr(opts.to)   < e) e = asDateStr(opts.to);
    if (s > e) return weekLabel(s);                 // degenerovaný clamp → radši jen start
    if (s === e) return weekLabel(s);               // jednodenní zbytek týdne
    return weekLabel(s) + ' – ' + weekLabel(e);
  }
  /** N6 — hlavička tooltipu: „Týden 6. 7. – 12. 7." (fallback = „Týden od 6. 7."). */
  function weekLabelRange(v, opts) {
    var r = weekRangeTxt(v, opts);
    return r ? 'Týden ' + r : weekLabelLong(v);
  }
  function firstArr() {
    for (var i = 0; i < arguments.length; i++) if (Array.isArray(arguments[i])) return arguments[i];
    return null;
  }
  function pickNum(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (o[keys[i]] != null && o[keys[i]] !== '') { var n = Number(o[keys[i]]); if (isFinite(n)) return n; }
    }
    return null;
  }
  /**
   * Tolerantní normalizace `weekly`. Bere tři tvary:
   *  A) řádkový:   { weeks:[{week_start|week|datum, roas_real, roas_model, spend, revenue_*}] } | rovnou pole
   *  B) sloupcový: { weeks|dates|labels:[…], roas_real:[…], roas_model:[…], spend:[…] }
   *  C) series:    { weeks|dates:[…], series:[{name:'ROAS model', data:[…]}, …] }
   * Vrací null, když nic z toho nesedí → UI to ŘEKNE (žádná vymyšlená data).
   *
   * Navíc k ROAS vytahuje `starts` (začátek týdne = 'YYYY-MM-DD') → z něj se počítá
   * ZRALOST týdne. Bez `starts` neumíme dozrávání dopočítat a graf to musí přiznat.
   *
   * ⚠️ BUG (opraveno 16.7.): api.php posílá `week_start` + `iso_week`, jenže tenhle
   * parser hledal jen `week`/`label`/`datum`/`date`/`iso` → nic nesedělo a labely
   * propadly až na String(i+1). Osa X pak ukazovala „1…18" místo datumů týdnů —
   * a `starts` (a tím i zralost) by nebyly vůbec. Kandidáty teď vede `week_start`.
   */
  function normalizeWeekly(res) {
    var r = unwrap(res);
    if (!r || typeof r !== 'object') return null;

    // A) řádkový
    var rows = null;
    if (Array.isArray(r)) rows = r;
    else if (Array.isArray(r.weeks) && r.weeks.length && typeof r.weeks[0] === 'object' && !Array.isArray(r.weeks[0])) rows = r.weeks;
    else if (Array.isArray(r.rows) && r.rows.length && typeof r.rows[0] === 'object') rows = r.rows;
    if (rows) {
      // G2: `cpl`/`cpa`/`leads` jsou tu nově — bez nich by přepínač metrik neměl co ukázat.
      var out = { labels: [], starts: [], ends: [], partial: [], ripe: [], pct_call: [], pct_schuzek: [],
                  roas_real: [], roas_model: [], spend: [], rev_real: [], rev_model: [], rev_created: [],
                  cpl: [], cpa: [], leads: [] };
      for (var i = 0; i < rows.length; i++) {
        var w = rows[i] || {};
        var start = asDateStr(w.week_start) || asDateStr(w.weekStart) || asDateStr(w.datum) ||
                    asDateStr(w.date) || asDateStr(w.week);
        var lbl = start ||
                  (w.week != null ? w.week :
                  (w.label != null ? w.label :
                  (w.iso_week != null ? w.iso_week :
                  (w.iso != null ? w.iso : String(i + 1)))));
        out.labels.push(lbl);
        out.starts.push(start);
        // N6 — konec týdne pro tooltip „od–do". api.php ho posílá jako `week_end`
        // (ověřeno naostro 16. 7.); když ne, dopočítá se start+6 ve weekRangeTxt().
        out.ends.push(asDateStr(w.week_end) || asDateStr(w.weekEnd) || null);
        out.partial.push(!!w.partial);
        // A0/A1 — ZRALOST ZE SERVERU je zdroj pravdy (`zralost` = %call × %schůzek).
        // Ověřeno naostro 16. 7.: `?action=weekly` ji posílá u každého týdne.
        // `maturity`/`ripeness` jsou jen staré aliasy, kdyby jel starší api.php.
        out.ripe.push(pickNum(w, ['zralost', 'maturity', 'ripeness', 'ripe']));
        var pc = pickNum(w, ['pct_call']), ps = pickNum(w, ['pct_schuzek']);
        out.pct_call.push(pc);
        out.pct_schuzek.push(ps);
        out.roas_real.push(pickNum(w, ['roas_real', 'roasReal', 'roas']));
        out.roas_model.push(pickNum(w, ['roas_model', 'roasModel']));
        out.spend.push(pickNum(w, ['spend']));
        out.rev_real.push(pickNum(w, ['revenue_real', 'revenue', 'rev_real']));
        out.rev_model.push(pickNum(w, ['revenue_model', 'rev_model']));
        out.rev_created.push(pickNum(w, ['revenue_created', 'rev_created']));   // náušnice = tržba celkem
        out.cpl.push(pickNum(w, ['cpl']));
        out.cpa.push(pickNum(w, ['cpa', 'cps']));
        out.leads.push(pickNum(w, ['leads']));
      }
      return out.labels.length ? out : null;
    }

    var labels = firstArr(r.weeks, r.dates, r.labels, r.categories);
    if (!labels || !labels.length) return null;
    var starts = labels.map(asDateStr);

    // B) sloupcový
    if (Array.isArray(r.roas_real) || Array.isArray(r.roas_model)) {
      return {
        labels: labels, starts: starts, ends: (r.week_end || r.ends || []).map(asDateStr), partial: [],
        ripe:        (r.zralost || r.maturity || r.ripeness || []).map(num),
        pct_call:    (r.pct_call || []).map(num),
        pct_schuzek: (r.pct_schuzek || []).map(num),
        roas_real:  (r.roas_real  || []).map(num),
        roas_model: (r.roas_model || []).map(num),
        spend:      (r.spend || []).map(num),
        rev_real:   (r.revenue_real  || r.revenue || []).map(num),
        rev_model:  (r.revenue_model || []).map(num)
      };
    }

    // C) series
    if (Array.isArray(r.series)) {
      var find = function (re) {
        for (var s = 0; s < r.series.length; s++) if (re.test(String(r.series[s].name || ''))) return (r.series[s].data || []).map(num);
        return [];
      };
      var real = find(/re[aá]l|real|skute/i), model = find(/model/i);
      if (!real.length && !model.length) return null;
      return {
        labels: labels, starts: starts, ends: [], partial: [], ripe: [], pct_call: [], pct_schuzek: [],
        roas_real: real, roas_model: model,
        spend: find(/spend|útrat|utrat/i), rev_real: [], rev_model: []
      };
    }
    return null;
  }

  /* A1/A0 — ZRALOST TÝDNE.
   *
   * ⚠️ POŘADÍ ZDROJŮ PŘEHOZENO 16. 7. (iterace 5) — SERVER JE PRVNÍ. Dřív měl přednost
   *    poměr revenue_real/revenue_model a server se bral až jako fallback. Bylo to
   *    ŠPATNĚ a bylo to VIDĚT:
   *      A0 (závazný koncept): zralost = %call × %schůzek. Nic jiného.
   *      Ostrá data 16. 7., týden 29. 6. (?action=weekly):
   *        server  zralost = 0,5698  (pct_call 1,0 × pct_schuzek 0,5698)   ← tabulky, wizard, dlaždice
   *        real/model      = 1 052 440 / 1 376 150 = 0,7648                ← tenhle graf
   *      → Filip by v týdenním grafu viděl 76 %, o dvě sekce níž v tabulce 57 %.
   *        Dvě různá čísla pod jedním jménem „zralost" = přesně to, čemu se má
   *        zabránit (a přesně to, na co by se zeptal: „která z nich platí?").
   *    Ty dvě veličiny nejsou totéž: revenue_model se počítá na DENNÍM řádku a pak se
   *    sčítá (parita s Lookerem, SPEC §1), takže Σreal/Σmodel je tržbou vážený průměr
   *    denních zralostí — příbuzné číslo, ale JINÉ. Zdroj pravdy je jeden: server.
   *
   * Pořadí: 1) server `zralost` → 2) pct_call × pct_schuzek (dopočet téhož vzorce, kdyby
   * starší api.php `zralost` neposílalo) → 3) revenue_real/revenue_model jako POSLEDNÍ
   * záchrana, ať graf o indikátor nepřijde úplně (a patička to přizná).
   * Vrací pole zralostí + `src` (odkud to je) pro patičku. */
  function weekMaturities(d, n) {
    var out = [], src = 'none';
    for (var i = 0; i < n; i++) {
      // 1) SERVER — A0 zdroj pravdy (`zralost` = %call × %schůzek, jmenovatel called_base)
      var sv = d.ripe && d.ripe[i];
      if (sv != null && isFinite(sv) && sv >= 0) {
        if (src === 'none') src = 'server';
        out.push(sv > 1 ? 1 : sv); continue;
      }
      // 2) týž vzorec dopočítaný z komponent, které server posílá vždycky
      var pc = d.pct_call && d.pct_call[i], ps = d.pct_schuzek && d.pct_schuzek[i];
      if (pc != null && isFinite(pc) && pc > 0) {
        var prod = (ps != null && isFinite(ps) && ps >= 0) ? pc * ps : pc;
        if (src === 'none') src = 'pct';
        out.push(prod > 1 ? 1 : prod); continue;
      }
      // 3) poslední záchrana — JINÁ veličina, proto to patička napíše
      var m = maturityOf(d.rev_real && d.rev_real[i], d.rev_model && d.rev_model[i]);
      if (m != null) { if (src === 'none') src = 'revenue'; out.push(m); continue; }
      out.push(null);          // týden bez dat → zralost NEEXISTUJE (ne 0 %!)
    }
    return { list: out, src: src };
  }

  /* ★ G2 — METRIKY HORNÍHO GRAFU. Filip vyjmenoval: ROAS · Spend · absolutní tržba ·
   * průměrný CPL · CPA.
   *
   * `split: true` = sloupec je STACK (plná = reálné, šrafovaná = dopočet). Dává smysl JEN
   * tam, kde dopočet existuje:
   *   • ROAS a Tržba — ano (dopočtená část je reálná veličina)
   *   • Spend — NE, spend je vždycky skutečný, „dopočtený spend" neexistuje
   *   • CPL — NE, počítá se z leadů, které dopočet nemění
   *   • CPA — NE; dopočet je UŽ UVNITŘ čísla (rezervace / %hovorů), rozpad by ho počítal dvakrát
   * Rozdělit sloupec tam, kde dopočet není, by lhalo — proto ta vlastnost, ne jednotné chování.
   */
  var W_METRICS = [
    { key: 'roas',    label: 'ROAS',   kind: 'roas',  split: true,
      hint: 'ROAS model — plná část jsou reálné peníze, šrafovaná dopočet' },
    { key: 'revenue', label: 'Tržba',  kind: 'money', split: true,
      hint: 'Absolutní tržba v Kč — plná část reálná, šrafovaná dopočtená' },
    { key: 'spend',   label: 'Spend',  kind: 'money', split: false,
      hint: 'Kolik jsme protočili — vždy skutečné peníze, nic se nedopočítává' },
    // G3-G4: CPL/CPA = kind 'cost' (ne 'money') → dostanou stejný auto-clip (winsorizace
    // na p95) jako v hlavním grafu; jinak jeden drahý týden zplácne osu a graf je plochý.
    // Formát zůstává v Kč (kind 'cost' se formátuje jako peníze), jsou to jednořádkové ceny.
    { key: 'cpl',     label: 'CPL',    kind: 'cost',  split: false,
      hint: 'Průměrná cena za lead: spend ÷ všechny leady toho týdne' },
    { key: 'cpa',     label: 'CPA',    kind: 'cost',  split: false,
      hint: 'Průměrná cena za rezervaci, dopočtená dle % hovorů' }
  ];
  var W_TITLE = { roas: 'Vývoj ROAS po týdnech', revenue: 'Vývoj tržby po týdnech',
                  spend: 'Vývoj spendu po týdnech', cpl: 'Vývoj CPL po týdnech',
                  cpa: 'Vývoj CPA po týdnech' };
  function wMetric() {
    for (var i = 0; i < W_METRICS.length; i++) if (W_METRICS[i].key === weekly.metric) return W_METRICS[i];
    return W_METRICS[0];
  }

  /* ★ Terminologie real/model (Filip 17. 7., „sjednotíme to VŠUDE"):
   *   ROAS → „ROAS real" / „ROAS model"   ·   Tržba → „Tržba real" / „Tržba model"
   * Nikde ne bare „ROAS"/„tržba"/„dopočet". U nedělitelných metrik (spend/CPL/CPA) je jen
   * jedno číslo (žádný model) → vracíme { one: label }. */
  function wLabels(M) {
    if (!M.split) return { one: M.label };
    var stem = (M.key === 'roas') ? 'ROAS' : 'Tržba';
    // Náušnice nemají model ani „real" — horní díl je CELKEM, spodní ZAPLACENO (Filip 18. 7.).
    if (currentTab() === 'earrings') return { real: stem + ' zaplaceno', model: stem + ' celkem' };
    return { real: stem + ' real', model: stem + ' model' };
  }

  function mountWeekly() {
    if (weekly.els.canvas && weekly.els.canvas.isConnected) return true;

    var root = (window.ADS && window.ADS.el) ? window.ADS.el('#weekly-root') : document.getElementById('weekly-root');
    if (!root) return false;               // mount přidává index.html (jiný agent) → zatím ticho
    injectCss();
    if (weekly.chart) { untrackChart(weekly.chart); try { weekly.chart.dispose(); } catch (e) { /* noop */ } weekly.chart = null; }

    root.innerHTML =
      '<section class="acx-card">' +
        '<div class="acx-head">' +
          '<div class="acx-title"><span class="dot"></span><span data-acx="wtitle">Vývoj ROAS po týdnech</span></div>' +
          /* Přepínač horizontu (30/90/180 dní) — Filip: závorku „posledních N týdnů" pryč,
           * místo ní volba, kolik dnů zpět. */
          '<div class="acx-seg acx-wrange" data-acx="wrange">' +
            WEEKLY_DAY_OPTS.map(function (d) {
              return '<button type="button" data-d="' + d + '"' + (d === weekly.days ? ' class="is-active"' : '') + '>' + d + ' dní</button>';
            }).join('') +
          '</div>' +
          /* ★ G2 (Filip 17. 7.): přepínání metriky (ROAS/Spend/Tržba/CPL/CPA). */
          '<div class="acx-seg acx-wmet" data-acx="wmetric">' +
            W_METRICS.map(function (m) {
              return '<button type="button" data-k="' + m.key + '" title="' + esc(m.hint) + '">' +
                     esc(m.label) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="acx-note" data-acx="wnote" hidden></div>' +
        '<div class="acx-body">' +
          '<div class="acx-canvas is-weekly" data-acx="wcanvas"></div>' +
          '<div class="acx-overlay" data-acx="woverlay"></div>' +
        '</div>' +
        '<div class="acx-foot" data-acx="wfoot"></div>' +
      '</section>';

    weekly.root = root;
    weekly.els = {
      canvas:  root.querySelector('[data-acx="wcanvas"]'),
      overlay: root.querySelector('[data-acx="woverlay"]'),
      note:    root.querySelector('[data-acx="wnote"]'),
      foot:    root.querySelector('[data-acx="wfoot"]')
    };
    if (!window.echarts) return false;
    weekly.chart = window.echarts.init(weekly.els.canvas, null, { renderer: 'canvas' });
    trackChart(weekly.chart, weekly.els.canvas);
    /* G2 — přepnutí metriky. Data už máme (weekly.data), takže se NEfetchuje znovu:
     * všechny metriky chodí v jedné odpovědi `?action=weekly`. Překreslí se jen graf. */
    var mSeg = root.querySelector('[data-acx="wmetric"]');
    if (mSeg) mSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]');
      if (!b || b.dataset.k === weekly.metric) return;
      weekly.metric = b.dataset.k;
      try { localStorage.setItem('ads.weekly.metric', weekly.metric); } catch (_) {}
      syncWMetricBtns();
      if (weekly.data) renderWeekly(weekly.data);
    });
    // Přepnutí horizontu (30/90/180 dní) → refetch s jiným počtem týdnů.
    var rSeg = root.querySelector('[data-acx="wrange"]');
    if (rSeg) rSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-d]');
      if (!b) return;
      var d = parseInt(b.dataset.d, 10);
      if (d === weekly.days) return;
      weekly.days = d;
      try { localStorage.setItem('ads.weekly.days', String(d)); } catch (_) {}
      [].forEach.call(rSeg.querySelectorAll('button'), function (x) {
        x.classList.toggle('is-active', parseInt(x.dataset.d, 10) === d);
      });
      loadWeekly();
    });
    syncWMetricBtns();

    return true;
  }

  /** Aktivní stav tlačítek metriky + skrytí CPL na náušnicích (K1: CPL tam nedává smysl). */
  function syncWMetricBtns() {
    if (!weekly.root) return;
    var isEar = currentTab() === 'earrings';
    [].forEach.call(weekly.root.querySelectorAll('[data-acx="wmetric"] button'), function (b) {
      b.classList.toggle('is-active', b.dataset.k === weekly.metric);
      // Náušnice CPL nemají (server posílá null) → tlačítko schovat, ne nabízet prázdný graf.
      b.hidden = (isEar && b.dataset.k === 'cpl');
    });
    if (isEar && weekly.metric === 'cpl') weekly.metric = 'roas';
  }

  function wOverlay(msg, spin) {
    if (!weekly.els.overlay) return;
    weekly.els.overlay.innerHTML = (spin ? '<div class="acx-spin"></div>' : '') + '<div>' + esc(msg) + '</div>';
    weekly.els.overlay.classList.add('show');
  }
  function wHide() { if (weekly.els.overlay) weekly.els.overlay.classList.remove('show'); }
  // prázdný/chybový stav: schovej i vysvětlivku a patičku, ať nevisí u nečeho, co se nevykreslilo
  function wClearAux() {
    if (weekly.els.note) weekly.els.note.hidden = true;
    if (weekly.els.foot) weekly.els.foot.style.display = 'none';
  }

  function loadWeekly() {
    if (!mountWeekly()) return;
    var tab = currentTab();
    var my = ++weekly.seq;
    wOverlay('Načítám týdenní vývoj…', true);

    Promise.resolve(window.ADS.api('weekly', { weeks: weeklyWeeks(), tab: tab }))
      .then(function (res) {
        if (my !== weekly.seq) return;
        var d = normalizeWeekly(res);
        if (!d || !d.labels.length) {
          weekly.chart.clear();
          wOverlay('Týdenní data zatím nejsou (api.php: ?action=weekly).', false);
          wClearAux();
          return;
        }
        renderWeekly(d);
      })
      .catch(function (err) {
        if (my !== weekly.seq) return;
        var status = err && err.status;
        weekly.chart.clear();
        wOverlay(status === 404
          ? 'Endpoint ?action=weekly na serveru zatím není.'
          : 'Týdenní graf se nepodařilo načíst' + (status ? ' (HTTP ' + status + ')' : '') + '.', false);
        wClearAux();
        console.error('[charts] weekly selhalo', { status: status, body: err && err.body });
      });
  }

  function renderWeekly(d) {
    // G2: data drž — přepnutí metriky pak jen překreslí (všechny metriky chodí v JEDNÉ odpovědi).
    weekly.data = d;
    wHide();
    var n = d.labels.length;
    var labels = d.labels.map(weekLabel);

    /* ★ G2 — co se kreslí, řídí zvolená metrika (W_METRICS), ne natvrdo ROAS.
     * `real`  = spodní PLNÁ část stacku (u nedělitelných metrik = celý sloupec)
     * `model` = CELKOVÁ výška; rozdíl model−real je šrafovaný dopočet.
     * U metrik bez dopočtu (spend/CPL/CPA) je model === real → `gap` vyjde 0 a šrafa
     * se vůbec nenakreslí. Tím je jedna kreslicí cesta pro všechny metriky. */
    var M = wMetric();
    // U náušnic NENÍ dopočtový „model" — horní díl je TRŽBA CELKEM (revenue_created).
    // Proto pro ně bereme created místo modelu (Filip: „jen zaplaceno a celkem").
    var earW = currentTab() === 'earrings';
    var earCreatedRoas = earW ? (d.rev_created || []).map(function (c, i) {
      var s = (d.spend || [])[i]; return (c != null && s) ? (c / s) : null;
    }) : null;
    var real, model;
    if (M.key === 'roas')         { real = d.roas_real || []; model = earW ? (earCreatedRoas || []) : (d.roas_model || []); }
    else if (M.key === 'revenue') { real = d.rev_real  || []; model = earW ? (d.rev_created || []) : (d.rev_model || []); }
    else if (M.key === 'spend')   { real = d.spend || []; model = d.spend || []; }
    else if (M.key === 'cpl')     { real = d.cpl   || []; model = d.cpl   || []; }
    else                          { real = d.cpa   || []; model = d.cpa   || []; }
    real = real.slice(0, n); model = model.slice(0, n);

    var tEl = weekly.root && weekly.root.querySelector('[data-acx="wtitle"]');
    if (tEl) tEl.textContent = (W_TITLE[M.key] || 'Vývoj po týdnech');   // závorka „posledních N týdnů" pryč (Filip)

    /* --- ZRALOST TÝDNŮ (A1/A4 — PŘEPSANÝ KONCEPT, FEEDBACK-3) --------------
       ❌ PRYČ: zralost podle STÁŘÍ týdne (RIPE_WEEKS 35/70/90 %). Byla to jiná veličina
          a Filip ji zrušil. Ostrá data 16. 7. ukazují, jak moc to bylo mimo: týden
          13. 4. je 3 měsíce starý (podle staré logiky „100 % zralý"), ale reálně je
          dopočtený z 46 % — a naopak týden 8. 6. má 86 %. Se stářím to nekoreluje.

       ❌ PRYČ TAKY: série „ROAS po dopočtu zralosti" (= roas_model ÷ zralost).
          Pod NOVOU definicí by DVAKRÁT dopočítávala totéž: roas_model už dopočet
          obsahuje a zralost je jeho PŘEVRÁCENÁ hodnota → model ÷ (real/model)
          = model²/real = nesmysl. Filip to řekl přesně: „dopočet zralost už řeší ve
          výpočtu, tohle je jenom informativně". Takže: dopočet zůstává v ROAS modelu,
          zralost je INDIKÁTOR DŮVĚRY vedle něj. Ubyla i jedna série z legendy. */
    var tab = currentTab();
    var mat = weekMaturities(d, n);
    var ripe = mat.list;

    // A2 — šrafuje se BĚŽÍCÍ týden (není dojetý), ne „poslední tři" podle kalendáře.
    // `partial` posílá api.php; když ne, je to poslední týden v řadě.
    var runningFrom = n;
    for (var pi = 0; pi < n; pi++) if (d.partial && d.partial[pi]) { runningFrom = pi; break; }
    if (runningFrom === n && n > 0) runningFrom = n - 1;
    var markArea = (runningFrom < n) ? [[{ xAxis: labels[runningFrom] }, { xAxis: labels[n - 1] }]] : [];

    var vis = [];
    if (real.length)  vis.push({ name: 'ROAS real', data: real });
    if (model.length) vis.push({ name: 'ROAS model',  data: model });
    var clip = clipInfo(vis, M.kind);

    /* ★ N1 — SLOUPEC JE STACK ZE DVOU DÍLŮ (Filip 17. 7.):
     *   spodní PLNÝ  = ROAS real        („to je to, co proběhlo, tržba realizovaná")
     *   horní ŠRAFOVANÝ = ROAS model − ROAS real   (dopočet)
     *   celková výška = ROAS model
     * Filip: „ta aktuální bude plná a ta dopočtená bude šrafovaná… tím pádem pak tam
     * nepotřebujeme tu svislou čáru, teda tu spojovací, takovou tu hnědou."
     *
     * PROČ je to lepší než sloupec + linka: poměr plné části k celku JE zralost.
     * Invariant `roas_model = roas_real / zralost` je tím vidět OČIMA, ne z čísla —
     * nízká zralost = malý plný kus a velká šrafa nad ním.
     *
     * ❌ PRYČ: hnědá linka „ROAS model" (nahradil ji vrchol stacku).
     * ❌ PRYČ: barva sloupce dle zralosti (A3/A4 z iterace 3). Zralost teď nese POMĚR
     *    dílů — obarvovat k tomu ještě sloupec by říkalo totéž dvakrát a pralo by se to
     *    se šrafou. Barvy zralosti zůstávají v tabulce, kde poměr vidět není.
     */
    /* ★ N2 (Filip 17. 7.): „šrafovaná část měla mít barvu podle procenta dopočtených tržeb —
     * když je 9 % reálných, respektive pod 30 %… podle těch barviček zralosti by měli mít barvičku."
     * → Plná část má JEDNU klidnou barvu (jsou to prostě peníze, ty barvu nepotřebují).
     *   ŠRAFA nese barvu ZRALOSTI toho týdne (matColor): <25 % červená · 25–50 oranžová ·
     *   50–75 žlutá · >75 zelená. Čím červenější šrafa, tím míň z toho sloupce jsou reálné peníze.
     * Proč to funguje: velikost šrafy říká KOLIK se dopočítalo, barva říká NAKOLIK tomu věřit.
     * Dvě různé informace, dva různé kanály — nepřekrývají se. */
    var C_REAL  = '#7fa88a';   // plná část — realizovaná tržba (klidná zelená, sedí do krém+zlatá)
    // Šrafa = barva zralosti týdne (prsteny). U NÁUŠNIC ale šrafa NENÍ dopočet přes zralost —
    // je to NEZAPLACENÁ část (celkem − zaplaceno), takže zralostní barva by lhala → neutrální amber.
    var C_EAR_UNPAID = '#c2913f';
    var C_HATCH = function (i) { return earW ? C_EAR_UNPAID : matColor(ripe[i]); };

    // Dopočet = model − real. Nikdy záporný (zaokrouhlení serveru), null když model chybí.
    // zralost = null (nedopočítává se) → rozdíl 0 → sloupec je celý plný a žádná šrafa nevznikne.
    var gap = real.map(function (rv, i) {
      var mv = model[i];
      if (rv == null || mv == null || isNaN(rv) || isNaN(mv)) return null;
      return Math.max(0, mv - rv);
    });

    /* Běžící (nedojetý) týden = JINÁ informace než dopočet → NESMÍ to být druhá šrafa,
     * jinak se to plete. Signál: nižší krytí + čárkovaný obrys (+ markArea pásmo níž). */
    function stackStyle(base, i, hatch) {
      var st = { color: hexA(base, i >= runningFrom ? 0.34 : 0.85) };
      if (hatch) {
        st.color = hexA(base, i >= runningFrom ? 0.10 : 0.18);
        st.decal = { color: hexA(base, i >= runningFrom ? 0.40 : 0.75),
                     dashArrayX: [1, 0], dashArrayY: [3, 4], rotation: -Math.PI / 4 };
      }
      if (i >= runningFrom) { st.borderColor = hexA(base, 0.7); st.borderWidth = 1; st.borderType = 'dashed'; }
      return st;
    }

    var LAB = wLabels(M);
    var series = [];
    if (real.length) {
      series.push({
        name: M.split ? LAB.real : LAB.one, type: 'bar', stack: 'wk', data: real.map(function (v, i) {
          return { value: v, itemStyle: stackStyle(C_REAL, i, false) };
        }),
        itemStyle: { color: C_REAL },      // legenda: plná zelená = přesně to, co je v grafu
        barMaxWidth: 30, emphasis: { itemStyle: { opacity: 1 } }, z: 2
      });
    }
    if (model.length && M.split) {
      series.push({
        // Šrafovaný díl = dopočet (model − reálná), jeho VRCHOL sedí na modelu → v legendě
        // „… model" (Filip: legenda má znít „ROAS real / ROAS model", ne „Dopočet").
        name: LAB.model, type: 'bar', stack: 'wk', data: gap.map(function (v, i) {
          return { value: v, itemStyle: stackStyle(C_HATCH(i), i, true) };
        }),
        /* ⚠️ LEGENDA NESMÍ LHÁT (poučení z 16. 7.): šrafa má barvu PER TÝDEN (zralost), takže
         * série sama jednu barvu nemá → ECharts by legendě dal náhodnou z palety. Neutrální
         * šeď je pravdivá („tahle série nemá jednu barvu") a co ty barvy znamenají, říká
         * legenda zralosti pod grafem. */
        itemStyle: { color: hexA('#9a9384', 0.18), borderRadius: [4, 4, 0, 0],
                     decal: { color: hexA('#9a9384', 0.75), dashArrayX: [1, 0], dashArrayY: [3, 4], rotation: -Math.PI / 4 } },
        barMaxWidth: 30, emphasis: { itemStyle: { opacity: 1 } }, z: 3
      });
    }

    /* C3 — BREAK-EVEN. ⚠️ PŘEPSÁNO 16. 7. (iterace 4/5): PLOŠNĚ 2,0 → JEDNA LINKA.
     *
     * ❌ PRYČ: PÁSMO min–max se dvěma popisky („zásnubní 1,5" – „snubní 2,0"). Mělo
     *    smysl, dokud měl každý funnel jiný break-even a tenhle blended graf ležel mezi
     *    nimi. Dnes mají všechny funnely 2,0 → pásmo by mělo nulovou šířku a dva popisky
     *    přes sebe. Filip doslova: „dvě linie v jednom grafu je blbý."
     * ❌ PRYČ TAKY: gate „jen prsteny". Break-even 2,0 platí i pro náušnice (ověřeno
     *    v ostrém `?action=config`: breakeven.funnels.„Náušnice" = 2, flat = true).
     *    Dřív se linka na tabu Náušnice schovala, protože prstenové 2,0/1,5 by pro ně
     *    lhaly — to už neplatí, hodnota je jedna a společná.
     *
     * Per-funnel větev zůstává živá pro případ, že by se někdy jeden funnel odlišil.
     *
     * ⚠️ G2: linky break-even a winner platí JEN pro ROAS. Na grafu spendu / CPL / CPA
     * by „2×" byla vodorovná čára v korunách — tedy nesmysl, který navíc rozbije měřítko
     * (break-even 2 Kč na ose, kde jsou desetitisíce). Proto se u jiných metrik nekreslí. */
    var isRoasMetric = (M.key === 'roas');
    var fl = isRoasMetric ? breakevenFlat() : { flat: false, value: null };
    var beLo = null, beHi = null;
    if (fl.flat && fl.value) {
      beLo = beHi = fl.value;
    } else if (!isRoasMetric) {
      beLo = beHi = null;
    } else {
      var beVals = [];
      var beMapW = breakevenMap();
      Object.keys(beMapW).forEach(function (k) { if (beMapW[k] > 0) beVals.push(beMapW[k]); });
      beVals.sort(function (a, b) { return a - b; });
      beLo = beVals.length ? beVals[0] : null;
      beHi = beVals.length ? beVals[beVals.length - 1] : null;
    }

    var gLines = [];
    if (beLo != null && beHi != null && beHi > beLo) {
      gLines.push(refLine(beLo, 'break-even ' + axisLabel(beLo, 'roas'), REF_BREAKEVEN, 'insideStartTop'));
      gLines.push(refLine(beHi, 'break-even ' + axisLabel(beHi, 'roas'), REF_BREAKEVEN, 'insideEndTop'));
    } else if (beLo != null) {
      gLines.push(refLine(beLo, 'break-even ' + axisLabel(beLo, 'roas'), REF_BREAKEVEN, 'insideStartTop'));
    }
    // winner VPRAVO — break-even sedí vlevo, na 1,0 ROAS od sebe by se popisky slily.
    // winner VPRAVO — a jen u ROAS (viz komentář výš: v korunách je „5×" nesmysl)
    if (isRoasMetric) {
      gLines.push(refLine(winnerRoas(), 'winner ' + axisLabel(winnerRoas(), 'roas'), REF_WINNER, 'insideEndTop'));
    }

    var gAreas = [];
    if (markArea.length) for (var ga = 0; ga < markArea.length; ga++) gAreas.push(markArea[ga]);
    // pásmo break-even (vodorovné) — jemné, ať nepřebije data
    if (beLo != null && beHi != null && beHi > beLo) {
      gAreas.push([{ yAxis: beLo, itemStyle: { color: hexA(REF_BREAKEVEN, 0.07) } }, { yAxis: beHi }]);
    }
    series.push({
      name: '__guide__', type: 'line', data: [], silent: true, z: 1,
      markArea: gAreas.length ? { silent: true, itemStyle: { color: INCOMPLETE_BAND }, data: gAreas } : undefined,
      markLine: { silent: true, symbol: 'none', data: gLines, lineStyle: { width: 1 }, emphasis: { disabled: true } }
    });

    var fmtTip = function (params) {
      if (!params || !params.length) return '';
      var i = params[0].dataIndex;
      // N6 — tooltip = „Týden 6. 7. – 12. 7." (Filip: kde je víc info, tam OD KDY DO KDY).
      // Konec bere ze serveru (`week_end`); běžící týden se ořízne na dnešek + „· běží".
      var out = '<div style="font-weight:600;margin-bottom:6px;color:' + INK + '">' +
                esc(weekLabelRange(d.starts[i] || d.labels[i], {
                  end: d.ends && d.ends[i],
                  to: (i >= runningFrom) ? todayStr() : null
                })) +
                (i >= runningFrom ? '<span style="font-weight:400;color:' + MUTED + '"> · běží</span>' : '') +
                '</div>';
      /* N1 — sloupec je stack, takže tooltip musí číst jako sčítání:
       *     Tržba real  2,9×
       *   + Dopočet       2,7×
       *   ─────────────────────
       *   = ROAS model    5,6×   ·  zralost 51 %
       * Bez součtu by tam svítilo osamocené „Dopočet 2,7×", což samo o sobě nic neříká.
       * Součet dopočítáváme z dílů (ne z d.model), ať tooltip nemůže tvrdit něco jiného,
       * než co je nakreslené. */
      var rowTip = function (label, val, col, hatch) {
        var sw = hatch
          ? 'background:' + hexA(col, 0.18) + ';border:1px solid ' + hexA(col, 0.7) +
            ';background-image:repeating-linear-gradient(-45deg,' + hexA(col, 0.7) + ' 0 2px,transparent 2px 5px);'
          : 'background:' + col + ';';
        return '<div style="display:flex;align-items:center;gap:7px;margin:2px 0;">' +
          '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;' + sw + '"></span>' +
          '<span style="flex:1;color:' + INK + ';">' + esc(label) + '</span>' +
          '<span style="font-weight:600;margin-left:14px;">' + fmtValue(Number(val), M.kind) + '</span></div>';
      };
      /* ★ OPRAVA 17. 7. (Filip): tooltip měl 3 řádky „Tržba real / Dopočet / ROAS model"
       * i pro ROAS metriku (label „Tržba…", ale hodnota je násobek) → matoucí a nekonzistentní.
       * Nově PŘESNĚ DVA řádky, popsané dle metriky (wLabels): reálná + model(TOTAL).
       * Dopočet (increment) se jako samostatný řádek NEUKAZUJE — Filip: „má tam být napsaný
       * ROAS real, ROAS model a ty násobky", ne tři čísla, kde se pak model objeví potřetí.
       * Zralost se ukazuje JEDNOU (blok níž), ne duplicitně jako „z toho reálné". */
      var rv = real[i], gv = gap[i];
      var tot = (rv != null && !isNaN(rv)) ? rv + (gv || 0) : null;
      if (!M.split) {
        // spend / CPL / CPA — jedno skutečné číslo, žádný model, žádná zralost
        if (rv != null && !isNaN(rv)) out += rowTip(LAB.one, rv, C_REAL, false);
      } else {
        // Filip: obě metriky POD SEBOU se swatchem, BEZ oddělovací čáry. Real = plná zelená,
        // model = ŠRAFOVANÝ swatch (barva zralosti týdne = stejná řeč jako sloupec v grafu).
        if (rv != null && !isNaN(rv)) out += rowTip(LAB.real, rv, C_REAL, false);
        if (tot != null) out += rowTip(LAB.model, tot, C_HATCH(i), true);
      }
      // CZK kontext do tooltipu (když ho server posílá). U metriky „Tržba" už jsou reálná/model
      // v horních řádcích → v CZK bloku nechávám jen Spend, ať se to nezdvojuje. Terminologie
      // „Tržba model" (ne „dopočtená") — sjednoceno s ROAS model.
      var money = [['Spend', d.spend && d.spend[i]]];
      if (M.key !== 'revenue') {
        if (earW) {
          money.push(['Tržba zaplaceno', d.rev_real && d.rev_real[i]]);
          money.push(['Tržba celkem',    d.rev_created && d.rev_created[i]]);
        } else {
          money.push(['Tržba real', d.rev_real && d.rev_real[i]]);
          money.push(['Tržba model',  d.rev_model && d.rev_model[i]]);
        }
      }
      money = money.filter(function (x) { return x[1] != null && isFinite(x[1]); });
      if (money.length) {
        out += '<div style="border-top:1px solid #efe8db;margin:6px 0 4px"></div>';
        for (var m = 0; m < money.length; m++) {
          out += '<div style="display:flex;gap:14px;margin:2px 0;color:' + MUTED + '">' +
            '<span style="flex:1">' + money[m][0] + '</span>' +
            '<span style="font-weight:600;color:' + INK + '">' + fmtMoney(money[m][1]) + '</span></div>';
        }
      }
      /* A4 — ZRALOST. Filip: „to je důležité", „chtěl bych tam vidět i procento zralosti".
         Bez ní je „ROAS model 0,54×" nečitelné: nevíš, jestli za ním jsou peníze,
         nebo dopočet. Ukazujeme JEDNOU (ne duplicitně „z toho reálné" + „Zralost").
         Jen u tržbových metrik (ROAS/Tržba) — u spendu/CPL/CPA se nic nedopočítává. */
      if (!M.split) return out;
      // NÁUŠNICE: žádná zralost. Šrafa = nezaplaceno (celkem − zaplaceno). Ukážeme podíl zaplaceno.
      if (earW) {
        var paidV = real[i], totV = tot;
        if (totV != null && totV > 0 && paidV != null) {
          var paidPct = Math.round(100 * paidV / totV);
          out += '<div style="border-top:1px solid #efe8db;margin:6px 0 4px"></div>' +
                 '<div style="color:' + MUTED + ';font-size:11.5px;max-width:260px;white-space:normal">' +
                 '<b style="color:' + INK + '">' + paidPct + ' % už zaplaceno</b> (plná část). Šrafovaná = objednávky, ' +
                 'které ještě nedorazily. Žádný modelový dopočet — jen skutečné peníze.</div>';
        }
        return out;
      }
      var rp = ripe[i];
      out += '<div style="border-top:1px solid #efe8db;margin:6px 0 4px"></div>' +
             '<div style="display:flex;gap:14px;margin:2px 0;align-items:center">' +
             '<span style="flex:1;color:' + MUTED + '">Zralost ' + matDot(rp) + '</span>' +
             '<span style="font-weight:700;color:' + matColor(rp) + '">' + esc(matPct(rp)) + '</span></div>';
      if (rp == null) {
        out += '<div style="margin-top:3px;color:' + MUTED + ';font-size:11.5px;max-width:260px;white-space:normal">' +
               'Bez tržby se zralost nedá spočítat — není co dopočítávat.</div>';
      } else {
        out += '<div style="margin-top:3px;color:' + MUTED + ';font-size:11.5px;max-width:260px;white-space:normal">' +
               '<b style="color:' + matColor(rp) + '">' + esc(matPct(rp)) + ' tržby je reálné</b>, zbytek dopočet ' +
               '(' + (tab === 'earrings' ? '% provolaných' : '% provolaných × % proběhlých schůzek') + '). ' +
               'ROAS model ten dopočet už obsahuje — tohle říká, nakolik mu věřit.' +
               (rp < MAT_TOO_FRESH
                 ? ' <span style="color:' + MAT_RED + '">Dopočet je tu ×' +
                   (Math.round(10 / rp) / 10).toString().replace('.', ',') +
                   ' — jedna objednávka s ním zamává, ber ho jako indicii, ne jako číslo.</span>'
                 : '') +
               '</div>';
      }
      return out;
    };

    weekly.chart.setOption({
      animationDuration: 320,
      // H5 — top = GRID_TOP, ať se popisek osy („ROAS") neuřízne (viz komentář u GRID_TOP).
      grid: { left: 8, right: 16, top: GRID_TOP, bottom: 28, containLabel: true },
      legend: {
        // N1: legenda = přesně dva díly stacku. `data` bere ze SÉRIÍ (ne z `vis`, což je
        // pomocná struktura pro ořez osy) — jinak by nabízela názvy, které v grafu nejsou.
        bottom: 0, left: 'center',
        data: series.filter(function (s) { return s.type === 'bar'; }).map(function (s) { return s.name; }),
        icon: 'roundRect', itemWidth: 12, itemHeight: 6, itemGap: 18,
        textStyle: { color: MUTED, fontSize: 11.5 }, inactiveColor: '#cfc8ba'
      },
      tooltip: Object.assign(tooltipBase(), { formatter: fmtTip, axisPointer: { type: 'shadow' } }),
      xAxis: {
        type: 'category', data: labels,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: { color: MUTED, fontSize: 11, hideOverlap: true }
      },
      yAxis: yValueAxis(M.kind, clip ? clip.max : null),
      series: series
    }, { notMerge: true });
    weekly.chart.resize();

    /* --- (d) VĚTA NAD GRAFEM. N1: sloupec je stack → vysvětli DÍLY, ne barvy zralosti.
     *     G9 (Filip): texty pod/nad grafy zkrátit, nepsat zbytečnosti. Tohle je minimum,
     *     bez kterého by šrafa byla hádanka. --- */
    if (weekly.els.note) {
      // G2: text musí sedět na ZVOLENOU metriku. U spendu/CPL/CPA se dopočet nekreslí,
      // takže o šrafě mlčíme — vysvětlovat něco, co tam není, je matoucí (G9: nepsat zbytečnosti).
      weekly.els.note.innerHTML = !M.split
        ? ('<b>' + esc(M.label) + '</b> — ' + esc(M.hint) + '.' +
           (runningFrom < n ? ' Poslední sloupec je <b>běžící týden</b>, ještě není dojetý.' : ''))
        : earW
          // NÁUŠNICE: šrafa = NEZAPLACENO (celkem − zaplaceno), žádná zralost ani dopočet.
          ? ('<b>Sloupec = ' + (M.key === 'roas' ? 'ROAS celkem' : 'tržba celkem') + '.</b> ' +
             'Plná část je <b>už zaplaceno</b>, ' +
             '<span style="color:' + C_EAR_UNPAID + '">šrafovaná</span> jsou <b>objednávky, které ještě nedorazily</b> ' +
             '(nezaplaceno). Nic se nemodeluje — jen skutečné peníze.' +
             (runningFrom < n ? ' Poslední sloupec je <b>běžící týden</b> — ještě není dojetý.' : ''))
          : ('<b>Sloupec = ' + (M.key === 'roas' ? 'ROAS model' : 'tržba celkem') + '.</b> ' +
             'Plná část jsou <b>peníze, co reálně přišly</b>, šrafovaná je <b>dopočet</b> na 100 % ' +
             'provolaných × proběhlých schůzek. ' +
             // N2: šrafa nese barvu zralosti → legendu barev je nutné vrátit, jinak je to hádanka.
             '<b>Barva šrafy = zralost</b> (kolik % už je reálných): ' +
             '<span style="color:' + MAT_RED + '">■ &lt;25 %</span> · ' +
             '<span style="color:' + MAT_ORANGE + '">■ 25–50 %</span> · ' +
             '<span style="color:' + MAT_YELLOW + '">■ 50–75 %</span> · ' +
             '<span style="color:' + MAT_GREEN + '">■ &gt;75 %</span>.' +
             (runningFrom < n ? ' Poslední sloupec je <b>běžící týden</b> — ještě není dojetý.' : ''));
      weekly.els.note.hidden = false;
    }

    var bits = [];
    // ⚠️ N1: „šrafovaně = běžící týden" už tu BÝT NESMÍ — šrafa teď znamená DOPOČET.
    // Nechat obojí = dva různé významy pro jeden vizuál, což je horší než nic neříct.
    // Běžící týden je odlišený krytím + čárkovaným obrysem a je popsaný ve větě NAD grafem.
    if (runningFrom < n) {
      bits.push('<span>poslední sloupec = <b>běžící týden</b>, nesrovnávej ho s celými</span>');
    }
    // A4 — rozptyl zralosti napříč okny je sám o sobě informace („někde 46 %, jinde 86 %").
    // U NÁUŠNIC zralost nefiguruje (šrafa = nezaplaceno) → tenhle bit se vynechává.
    var mv = ripe.filter(function (x) { return x != null; });
    if (!earW && mv.length) {
      var mn = Math.min.apply(null, mv), mx = Math.max.apply(null, mv);
      bits.push('<span>zralost v okně: <b style="color:' + matColor(mn) + '">' + matPct(mn) +
                '</b> – <b style="color:' + matColor(mx) + '">' + matPct(mx) + '</b>' +
                ' · poslední týden <b style="color:' + matColor(ripe[n - 1]) + '">' + matPct(ripe[n - 1]) +
                '</b></span>');
    }
    // A0 — když zralost NEJDE ze serveru, přiznej to: fallback je JINÁ veličina.
    if (!earW && mat.src === 'revenue') {
      bits.push('<span class="warn">Zralost je tu dopočtená z poměru tržba reálná / dopočtená — ' +
                'server ji u těchhle týdnů neposlal. Není to úplně totéž co %provolaných × %schůzek, ' +
                'ber ji orientačně.</span>');
    }
    // C3 — legenda break-even. Dnes JEDNA plošná linka (viz blok u gLines výš).
    if (beLo != null && beHi != null && beHi > beLo) {
      bits.push('<span style="color:' + REF_BREAKEVEN + '">┅ break-even ' + axisLabel(beLo, 'roas') +
                '–' + axisLabel(beHi, 'roas') + '</span>' +
                '<span> = pásmo; tenhle graf míchá víc funnelů s různým break-evenem. ' +
                'Pod ním prodělek u všech.</span>');
    } else if (beLo != null) {
      bits.push('<span style="color:' + REF_BREAKEVEN + '">┅ break-even ' + axisLabel(beLo, 'roas') + '</span>' +
                '<span> = plošně pro všechny funnely i náušnice. Pod ním prodělek → kill.</span>');
    }
    if (clip) {
      bits.push('<span class="warn">Osa oříznuta na p95 (' + axisLabel(clip.max, 'roas') + ') — ' +
                clip.names.length + '× mimo rozsah; přesné hodnoty v tooltipu.</span>');
    }
    if (weekly.els.foot) {
      weekly.els.foot.innerHTML = footHTML(bits);   // M3 — 1 bit = 1 flex item
      weekly.els.foot.style.display = bits.length ? 'flex' : 'none';
    }
  }

  /* =========================================================================
   * 8) MINI TREND JEDNÉ KREATIVY (FEEDBACK-2 H1) → window.ADS.miniTrend()
   *
   * ┌─ PROČ TO DŘÍV NEFUNGOVALO (Filip: „grafy na úrovni kreativ nefungujou,
   * │  což je mega užitečný") — ověřeno naostro 16.7. curlem na ostrou api.php:
   * │    ?action=creative_trend…      → {"error":"neznámá akce: creative_trend"}
   * │    ?action=timeseries&split=creative&tab=rings
   * │                                 → 400 {"error":"neznámý split: creative",
   * │                                        "allowed":["funnel","event","optimization"]}
   * │  Původní kód zkoušel PŘESNĚ tyhle dvě cesty. Obě jsou slepé → modal vždycky
   * │  skončil hláškou „trend nejde načíst". Kód nebyl rozbitý, jen si psal na
   * │  endpoint, který nikdo nikdy nenapsal.
   * └─
   * ŘEŠENÍ BEZ ZÁSAHU DO api.php: `?action=creatives&from&to&tab` vrací per-kreativa
   * agregát ZA LIBOVOLNÉ OKNO (spend, roas_real, roas_model, cpa, bookings…). Zavoláme
   * ho jednou na KAŽDÝ ISO TÝDEN a poskládáme z toho týdenní řadu.
   *
   * Proč je to i SPRÁVNĚ, ne jen dostupné:
   *   - Týden agreguje SERVER ze surových řádků a metriku počítá až z jejich součtu
   *     → přesně to, co D2 vyžaduje (žádné průměrování hotových denních ROAS).
   *   - Filip u trendu kreativy stejně chce týdny, ne denní šum z pěti leadů.
   * Cena: 1 request/týden (~104 kB gzip u prstenů). Cache je klíčovaná OKNEM, ne
   * kreativou → druhý modal nad stejným obdobím jede z cache, i pro jinou kreativu.
   * Strop MINI_MAX_WEEKS drží 180denní okno na rozumných 13 requestech.
   * ====================================================================== */

  var MINI_MAX_WEEKS = 13;      // ~kvartál; víc už se do minigrafu stejně nevejde
  var MINI_CONC      = 4;       // souběžných requestů (server dělá compute_creatives na každý)
  var weekAggCache = Object.create(null);   // 'tab|from|to' → Promise<{creative → row}>

  // Rozpad [from,to] na ISO týdny (pondělí–neděle), oříznuté do okna.
  function isoWeeksIn(from, to, maxWeeks) {
    var f = isoWeekStart(from), t = asDateStr(to);
    if (!f || !t) return [];
    var out = [];
    var cur = new Date(f + 'T00:00:00Z');
    var end = new Date(t + 'T00:00:00Z');
    while (cur <= end) {
      var ws = cur.toISOString().slice(0, 10);
      var we = new Date(cur.getTime() + 6 * 86400000).toISOString().slice(0, 10);
      out.push({ start: ws, from: (ws < from ? from : ws), to: (we > t ? t : we) });
      cur = new Date(cur.getTime() + 7 * 86400000);
    }
    if (maxWeeks && out.length > maxWeeks) out = out.slice(out.length - maxWeeks);
    return out;
  }

  // Jedno okno → mapa kreativa → řádek. Cachované (sdílené přes všechny kreativy).
  /* F7/C3: `event` = volitelné zúžení na JEDNU optimalizaci/event (?action=creatives ho
   * jako filtr umí už dnes). Je součástí cache klíče — jinak by se rozpad podle eventu
   * tiše kreslil z dat „za všechny eventy". */
  function creativesWindow(tab, from, to, event) {
    var ev = event || '';
    var ck = [tab, from, to, ev].join('|');
    if (weekAggCache[ck]) return weekAggCache[ck];
    var params = { tab: tab, from: from, to: to };
    if (ev) params.event = ev;
    weekAggCache[ck] = Promise.resolve(window.ADS.api('creatives', params))
      .then(function (res) {
        var rows = unwrap(res);
        if (!Array.isArray(rows)) rows = (rows && rows.rows) || [];
        var by = Object.create(null);
        for (var i = 0; i < rows.length; i++) by[String(rows[i].creative)] = rows[i];
        return by;
      })
      .catch(function (err) { weekAggCache[ck] = null; throw err; });
    return weekAggCache[ck];
  }

  // Requesty po dávkách — 13 souběžných compute_creatives by server zbytečně sundalo.
  function mapLimit(items, limit, fn) {
    var out = new Array(items.length), i = 0;
    function worker() {
      if (i >= items.length) return Promise.resolve();
      var my = i++;
      return Promise.resolve(fn(items[my], my)).then(function (r) { out[my] = r; return worker(); });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(worker());
    return Promise.all(runners).then(function () { return out; });
  }

  /**
   * Týdenní trend jedné kreativy přes ?action=creatives (viz blok výš).
   * → { dates:[week_start…], roas_real:[], roas_model:[], cpa:[], cpl:[], spend:[],
   *     rev_real:[], rev_model:[], mat:[], funnel, weeksTotal }
   *
   * D5 (FEEDBACK-3) — bereme i TRŽBU: „ať si uvědomím, jak velký vzorek to je".
   * D4 (FEEDBACK-3) — a CPL: „nejčastěji když se sníží CPL, tak se to propadne".
   * A4 — zralost per týden z revenue_real/revenue_model téhle kreativy (sekce 0c).
   */
  function trendViaCreatives(o) {
    var weeks = isoWeeksIn(o.from, o.to, MINI_MAX_WEEKS);
    if (!weeks.length) return Promise.resolve(null);

    return mapLimit(weeks, MINI_CONC, function (w) {
      return creativesWindow(o.tab, w.from, w.to, o.event).catch(function () { return null; });
    }).then(function (maps) {
      /* F7/C2: vedle složené zralosti (`mat`) vezeme i JEJÍ SLOŽKY (Filip 23. 7.:
       * „viděl malinkým písmem napsaný třeba třicet procent hovorů, nula procent
       * rezervací. Abych viděl, kolik z toho jako proběhlo, a podle toho se mohl
       * rozhodnout."). Data už v odpovědi ?action=creatives byla, jen se zahazovala.
       * `matEmpty` = 0 rezervací → druhá složka je dosazená, ne naměřená (viz F7/B). */
      var d = { dates: [], ranges: [], roas_real: [], roas_model: [], cpa: [], cpl: [], spend: [],
                rev_real: [], rev_model: [], mat: [], matCall: [], matSch: [], matEmpty: [],
                bookings: [], funnel: null,
                weeksTotal: weeks.length, any: false };
      for (var i = 0; i < weeks.length; i++) {
        var row = maps[i] ? maps[i][o.creative] : null;
        d.dates.push(weeks[i].start);
        // N6 — isoWeeksIn() už koš OŘÍZL na zvolené období (`w.from`/`w.to`) a přesně
        // na tenhle rozsah se ptal server → do tooltipu jde 1:1, bez dohadování.
        d.ranges.push({ from: weeks[i].from, to: weeks[i].to });
        if (!row) {
          d.roas_real.push(null); d.roas_model.push(null); d.cpa.push(null); d.cpl.push(null);
          d.spend.push(null); d.rev_real.push(null); d.rev_model.push(null); d.mat.push(null);
          d.matCall.push(null); d.matSch.push(null); d.matEmpty.push(false); d.bookings.push(null);
          continue;
        }
        d.any = true;
        // C3 — funnel kreativy → break-even linka. Bereme z posledního týdne, kde je
        // (funnel se u kreativy nemění; `funnel_derived` je z prefixu, ale pro linku stačí).
        if (row.funnel && row.funnel !== '---') d.funnel = row.funnel;
        var sp = num(row.spend);
        d.spend.push(sp);
        // ROAS bez spendu není 0, je to „nedefinováno" → díra, ne čára po nule.
        d.roas_real.push(sp > 0 ? num(row.roas_real) : null);
        d.roas_model.push(sp > 0 ? num(row.roas_model) : null);
        var cpa = num(row.cpa != null ? row.cpa : row.cps);
        d.cpa.push(cpa > 0 ? cpa : null);      // 0 = žádná rezervace → díra, ne „CPA 0 Kč"
        var cpl = num(row.cpl);
        d.cpl.push(cpl > 0 ? cpl : null);      // 0 = žádný lead → díra, ne „CPL 0 Kč"
        var rr = num(row.revenue_real), rm = num(row.revenue_model);
        d.rev_real.push(rr);
        d.rev_model.push(rm);
        // A0 — zralost ZE SERVERU (`zralost` = %call × %schůzek; u náušnic %call samotné).
        // ⚠️ Dřív se tu počítalo maturityOf(rr, rm) = real/model → jiné číslo než to,
        //    které o té samé kreativě ukazuje tabulka i dlaždice (obě čtou `row.zralost`).
        //    `?action=creatives` ho vrací u každého řádku (ověřeno naostro 16. 7.),
        //    takže není důvod si ho počítat po svém. real/model zůstává jako záchrana.
        var zs = num(row.zralost);
        d.mat.push((zs != null && zs >= 0) ? Math.min(zs, 1) : maturityOf(rr, rm));
        // F7/C2 — složky zralosti do tooltipu (viz komentář u inicializace `d`)
        d.matCall.push(num(row.pct_call));
        d.matSch.push(num(row.pct_schuzek));
        d.matEmpty.push(!!row.schuzek_empty);
        d.bookings.push(num(row.bookings));
      }
      return d.any ? d : null;
    });
  }

  /**
   * window.ADS.miniTrend(el, { creative, tab, from, to })   ← SIGNATURA JE KONTRAKT, NEMĚNIT
   * Týdenní trend JEDNÉ kreativy: ROAS (levá osa, od 0) + CPA (pravá osa, od 0).
   * Volá ho tables.js z openTrendModal po kliknutí na reklamu. Vrací { dispose() }.
   */
  function miniTrend(target, opts) {
    opts = opts || {};
    var host = (typeof target === 'string') ? document.querySelector(target) : target;
    if (!host) { console.warn('[charts] miniTrend: cílový element neexistuje'); return { dispose: function () {} }; }
    injectCss();

    var st = state();
    var o = {
      creative: String(opts.creative || ''),
      tab: (opts.tab === 'earrings') ? 'earrings' : (opts.tab || currentTab()),
      from: opts.from || st.from,
      to:   opts.to   || st.to,
      event: String(opts.event || '')   // F7/C3 — '' = všechny optimalizace dohromady
    };

    host.innerHTML = '<div class="acx-mini"><div class="acx-mini-msg"><span class="acx-spin"></span>Načítám týdenní trend…</div></div>';
    var box = host.firstChild;
    var inst = null;
    var alive = true;

    function fail(msg) {
      if (!alive) return;
      box.innerHTML = '<div class="acx-mini-msg">' + esc(msg) + '</div>';
    }

    if (!o.creative) { fail('Chybí kód kreativy — trend nejde načíst.'); return { dispose: function () {} }; }
    if (!o.from || !o.to) { fail('Chybí období — trend nejde načíst.'); return { dispose: function () {} }; }

    trendViaCreatives(o)
      .then(function (d) {
        if (!alive) return;
        if (!d || !d.dates.length) {
          // Není to chyba, je to fakt: kreativa v tomhle okně neutratila ani korunu.
          fail('Kreativa ' + o.creative + ' nemá v období ' + fmtDate(o.from) + ' – ' + fmtDate(o.to) +
               (o.event ? ' u optimalizace „' + o.event + '"' : '') + ' žádná data (spend ani konverze).');
          return;
        }
        renderMini(box, d, o);
        inst = window.echarts && window.echarts.getInstanceByDom(box.querySelector('.acx-mini-canvas'));
      })
      .catch(function (err) {
        if (!alive) return;
        var status = err && err.status;
        console.error('[charts] miniTrend selhal', { creative: o.creative, tab: o.tab, status: status, body: err && err.body });
        fail(status === 401
          ? 'Přihlášení vypršelo — obnov stránku.'
          : 'Trend se nepodařilo načíst' + (status ? ' (HTTP ' + status + ')' : '') + '.');
      });

    return {
      dispose: function () {
        alive = false;
        untrackChart(inst);
        try { if (inst) inst.dispose(); } catch (e) { /* noop */ }
      }
    };
  }

  function renderMini(box, d, o) {
    box.innerHTML = '<div class="acx-mini-canvas"></div><div class="acx-mini-foot"></div>';
    var canvas = box.querySelector('.acx-mini-canvas');
    var foot   = box.querySelector('.acx-mini-foot');
    if (!window.echarts) { box.innerHTML = '<div class="acx-mini-msg">Knihovna grafů se nenačetla.</div>'; return; }

    var chartM = window.echarts.init(canvas, null, { renderer: 'canvas' });
    trackChart(chartM, canvas);

    var L = d.dates.length;
    // A2 — šrafuje se jen BĚŽÍCÍ týden (poslední koš okna končí dneškem → není dojetý).
    // Časová zralost („poslední 3 týdny dozrávají") je zahozená — viz sekce 0c/A2.
    var estIdx = Math.max(0, L - 1);

    /* Ořez osy na p95 se tu SCHVÁLNĚ NEDĚLÁ.
     * Guard proti outlierům existuje kvůli grafu s 10+ sériemi, kde jedna ustřelená
     * série zplácne ostatní na nulu. Tady je série JEDNA (tahle kreativa) — není koho
     * chránit a špička JE ta informace, kvůli které Filip modal otevřel.
     * Navíc p95 z ~5 týdenních bodů nic neznamená: ověřeno na P-287-001 — z hodnot
     * [0,0,10.85,0,0] + [0,0,5.43,0,0] vyšlo p95 = 8,5 a ořez usekl přesně ten
     * jediný týden, kdy kreativa vydělala (10,85×). Osa Y stejně startuje na 0. */
    var clip = null;

    // Řada je „prázdná", až když v ní není ANI JEDNO číslo — délku má vždycky (paddujeme null).
    function hasAny(a) {
      if (!a) return false;
      for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) return true;
      return false;
    }
    // ⚠️ showSymbol: true je tu POVINNÉ, ne kosmetika. Týdenní řada má díry (kreativa
    // týden neběžela, nebo neměla rezervaci) a `connectNulls:false` je nespojuje — což
    // je správně. Jenže osamocený bod mezi dvěma nully NEMÁ jak nakreslit čáru → bez
    // markeru by se kreativa s daty v jediném týdnu vykreslila jako PRÁZDNÝ GRAF.
    var SYM = { showSymbol: true, symbolSize: 5, connectNulls: false };

    var series = [];
    var hasModel = hasAny(d.roas_model), hasReal = hasAny(d.roas_real);
    var hasCpa = hasAny(d.cpa), hasCpl = hasAny(d.cpl);
    if (hasModel) {
      series.push(Object.assign({
        name: 'ROAS model', type: 'line', data: d.roas_model, yAxisIndex: 0,
        smooth: false, lineStyle: { width: 2.2, color: '#3b6fb0' },
        itemStyle: { color: '#3b6fb0' }, areaStyle: { color: hexA('#3b6fb0', 0.10) }, z: 3
      }, SYM));
    }
    if (hasReal) {
      series.push(Object.assign({
        name: 'ROAS real', type: 'line', data: d.roas_real, yAxisIndex: 0,
        smooth: false, lineStyle: { width: 1.6, color: '#5aa77f' },
        itemStyle: { color: '#5aa77f' }, z: 3
      }, SYM));
    }
    if (hasCpa) {
      series.push(Object.assign({
        name: 'CPA', type: 'line', data: d.cpa, yAxisIndex: 1,
        smooth: false, lineStyle: { width: 1.8, color: '#c9704a', type: 'dashed' },
        itemStyle: { color: '#c9704a' }, z: 2
      }, SYM));
    }
    /* D4 — CPL. Filip: „nejčastěji když se sníží CPL, tak se to propadne" → chce vidět,
     * KAM CPL jede, ne jen jeho číslo.
     * ⚠️ CPL MUSÍ mít VLASTNÍ osu, i když je to taky koruny jako CPA. Na ostrých datech
     *    (E-028-001, 6 týdnů) je CPA 10–50× větší než CPL (cpl 122–180 vs cpa 1 469–6 240).
     *    Na společné ose by CPL ležel na 2–3 % výšky → jeho 31% propad (180→124) = ~2 px,
     *    tedy přesně ten signál, kvůli kterému ho Filip chce, by NEBYL VIDĚT.
     *    Proto třetí osa s offsetem. Cena: ~44 px vpravo. Stojí to za to. */
    if (hasCpl) {
      series.push(Object.assign({
        name: 'CPL', type: 'line', data: d.cpl, yAxisIndex: 2,
        smooth: false, lineStyle: { width: 1.6, color: '#7d6bb0', type: 'dotted' },
        itemStyle: { color: '#7d6bb0' }, z: 2
      }, SYM));
    }
    var mark = [];
    if (estIdx < L && L > 1) {
      mark.push([{ xAxis: d.dates[estIdx] }, { xAxis: d.dates[L - 1] }]);
    }
    // C3 — break-even. Dnes PLOŠNÝCH 2,0 → linka i pro náušnice i pro kreativu bez
    // funnelu (breakevenFor() to v plošném režimu vrací bez ohledu na funnel).
    // Gate „jen prsteny" je pryč ze stejného důvodu jako u týdenního grafu.
    var beV = breakevenFor(d.funnel);
    var gl = [];
    if (beV != null) gl.push(refLine(beV, 'break-even ' + axisLabel(beV, 'roas'), REF_BREAKEVEN));
    series.push({
      name: '__guide__', type: 'line', data: [], silent: true, yAxisIndex: 0, z: 1,
      markArea: mark.length ? { silent: true, itemStyle: { color: EST_BAND }, data: mark } : undefined,
      markLine: gl.length ? { silent: true, symbol: 'none', data: gl, lineStyle: { width: 1 }, emphasis: { disabled: true } } : undefined
    });

    /* graf-přehlednost — Filip: „mini graf je zmatečný, 4 série a 3 osy Y." → DEFAULTNĚ
     * jsou vidět jen OBĚ ROAS (jedna osa). CPA/CPL jsou v legendě VYPNUTÉ; kdo je zapne,
     * dostane jejich osu (CPA a CPL musí mít VLASTNÍ osu — CPA je 10–50× větší, na společné
     * by se pohyb CPL ztratil). Kitco tažení hýbe jen ROAS osou (osa 0) — to Filip bere. */
    var yRoas = yValueAxis('roas', clip ? clip.max : null);
    yRoas.name = 'ROAS'; yRoas.nameTextStyle = { color: MUTED, fontSize: 10, align: 'left' };
    var yCpa = yValueAxis('cost', null);
    // Filip 19. 7.: CPL/CPA jsou rozhodovací metriky → v detailu VIDITELNÉ defaultně (osa i série).
    yCpa.name = 'CPA'; yCpa.splitLine = { show: false }; yCpa.show = hasCpa;
    yCpa.nameTextStyle = { color: MUTED, fontSize: 10, align: 'right' };
    yCpa.axisLabel = { color: '#c9704a', fontSize: 10, formatter: function (v) { return axisLabel(v, 'cost'); } };
    var yCpl = yValueAxis('cost', null);
    yCpl.name = 'CPL'; yCpl.splitLine = { show: false }; yCpl.show = hasCpl;
    yCpl.offset = hasCpa ? 40 : 0;      // vedle CPA osy; když CPA není, sedne si na její místo
    yCpl.nameTextStyle = { color: MUTED, fontSize: 10, align: 'right' };
    yCpl.axisLabel = { color: '#7d6bb0', fontSize: 10, formatter: function (v) { return axisLabel(v, 'cost'); } };
    // Legenda: CPA/CPL defaultně ZAPNUTÉ (Filip je chce hned vidět). Kdo je nechce, vypne v legendě.
    var legSel = {};
    if (hasCpa) legSel['CPA'] = true;
    if (hasCpl) legSel['CPL'] = true;
    // Pravý okraj gridu musí pojmout osy CPA + CPL (CPL je s offsetem 40px). Filip 20. 7.:
    // s oběma zapnutými CPL osa přetékala za okraj. Dvě osy = 84, jedna = 48, žádná = 8.
    function gridRight(cpa, cpl) { return (cpa && cpl) ? 84 : ((cpa || cpl) ? 48 : 8); }

    chartM.setOption({
      animationDuration: 260,
      // H5 — i mini graf má názvy os (ROAS/CPA/CPL). Při top:26 mu zbývaly 3,8 px nad
      // písmeny → nebyl uříznutý, ale stačila by změna fontu. Jede na stejné konstantě
      // jako velké grafy; 4 px navíc z 216px karty nikdo nepozná, uříznutého „ROAS" ano.
      grid: { left: 4, right: gridRight(hasCpa, hasCpl), top: GRID_TOP, bottom: 24, containLabel: true },
      legend: {
        bottom: 0, left: 'center', icon: 'roundRect', itemWidth: 11, itemHeight: 3, itemGap: 14,
        data: series.filter(function (s) { return s.name !== '__guide__'; }).map(function (s) { return s.name; }),
        selected: legSel,
        textStyle: { color: MUTED, fontSize: 10.5 }, inactiveColor: '#cfc8ba'
      },
      tooltip: Object.assign(tooltipBase(), {
        formatter: function (params) {
          if (!params || !params.length) return '';
          var i = params[0].dataIndex;
          // N6 — „Týden 6. 7. – 12. 7." (rozsah, na který se ptal server — viz d.ranges)
          var rg = (d.ranges && d.ranges[i]) || {};
          var out = '<div style="font-weight:600;margin-bottom:5px;color:' + INK + '">' +
                    esc(weekLabelRange(params[0].axisValue, { from: rg.from, to: rg.to })) +
                    (i >= estIdx ? '<span style="font-weight:400;color:' + MUTED + '"> · běží</span>' : '') +
                    '</div>';
          for (var p = 0; p < params.length; p++) {
            var it = params[p];
            if (it.seriesName === '__guide__' || it.value == null || isNaN(it.value)) continue;
            var isCost = (it.seriesName === 'CPA' || it.seriesName === 'CPL');
            out += '<div style="display:flex;align-items:center;gap:7px;margin:2px 0;">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + it.color + ';"></span>' +
              '<span style="flex:1">' + esc(it.seriesName) + '</span>' +
              '<span style="font-weight:600;margin-left:12px">' +
              fmtValue(Number(it.value), isCost ? 'cost' : 'roas') + '</span></div>';
          }
          /* D5 — SPEND *A TRŽBA*. Filip: „ať si uvědomím, jak velký vzorek to je."
             Bez tržby vedle spendu je ROAS 10× z 500 Kč k nerozeznání od ROAS 10×
             z 50 000 Kč — a to je celý rozdíl mezi náhodou a winnerem. */
          var money = [
            ['Spend',         d.spend    && d.spend[i],    MUTED],
            ['Tržba real',  d.rev_real && d.rev_real[i], MUTED],
            ['Tržba model',   d.rev_model && d.rev_model[i], MUTED]
          ].filter(function (x) { return x[1] != null && isFinite(x[1]); });
          if (money.length) {
            out += '<div style="border-top:1px solid #efe8db;margin:5px 0 3px"></div>';
            for (var m = 0; m < money.length; m++) {
              out += '<div style="display:flex;gap:12px;margin:1px 0;color:' + money[m][2] + '">' +
                '<span style="flex:1">' + money[m][0] + '</span>' +
                '<span style="font-weight:600;color:' + INK + '">' + fmtMoney(money[m][1]) + '</span></div>';
            }
          }
          // A4 — zralost TÝDNE úplně dole (Filip 20. 7.: „ukazovat zralost pro ten týden").
          // Ukazuje se VŽDY jako ČÍSLO (Filip: „ne proškrtnutá pomlčka, buď nula nebo číslo").
          // Týden bez rezervace → nic nedozrálo → 0 % (červená = nízká důvěra, čerstvá data).
          var mm = d.mat && d.mat[i];
          var mv = (mm != null) ? mm : 0;
          out += '<div style="border-top:1px solid #efe8db;margin:5px 0 2px"></div>' +
            '<div style="display:flex;gap:12px;margin:2px 0;align-items:center">' +
            '<span style="flex:1;color:' + MUTED + '">Zralost týdne ' + matDot(mv) + '</span>' +
            '<span style="font-weight:700;color:' + matColor(mv) + '" ' +
            (mm == null ? 'title="Zatím žádná rezervace → nic z tohoto týdne ještě nedozrálo (0 %)"' : '') + '>' +
            esc(matPct(mv)) + '</span></div>';
          /* F7/C2 — ROZPAD ZRALOSTI malým písmem (Filip 23. 7.: „viděl malinkým písmem
           * napsaný třeba třicet procent hovorů, nula procent rezervací. Abych viděl,
           * kolik z toho jako proběhlo, a podle toho se mohl rozhodnout.").
           * Samotné složené číslo neřekne, JESTLI se nevolalo, nebo neproběhly schůzky —
           * a to je přesně rozdíl mezi „počkej" a „něco vázne".
           * ⚠️ Když nevznikla ANI JEDNA rezervace, píšeme počet (0 rezervací), ne „100 %":
           *    ta jednička je dosazená, aby nespadla zralost (F7/B), ne naměřená. */
          var pc = d.matCall && d.matCall[i], ps = d.matSch && d.matSch[i];
          var bk = d.bookings && d.bookings[i];
          var emptySch = d.matEmpty && d.matEmpty[i];
          if (pc != null) {
            var schTxt = emptySch
              ? '<b>0</b> rezervací'
              : (ps != null ? '<b>' + esc(matPct(ps)) + '</b> rezervací' : 'rezervace neznámé');
            out += '<div style="margin:1px 0 0;font-size:10px;color:' + MUTED + '">' +
              '<b>' + esc(matPct(pc)) + '</b> hovorů · ' + schTxt +
              (emptySch && bk === 0 ? ' <i>(není na co čekat)</i>' : '') + '</div>';
          }
          return out;
        }
      }),
      xAxis: {
        type: 'category', boundaryGap: false, data: d.dates,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: { color: MUTED, fontSize: 10, hideOverlap: true, formatter: function (v) { return weekLabel(v); } }
      },
      yAxis: [yRoas, yCpa, yCpl],
      series: series
    }, { notMerge: true });
    // graf-přehlednost: osa CPA/CPL se ukáže/schová podle toho, co je v legendě zapnuté.
    chartM.on('legendselectchanged', function (ev) {
      var s = (ev && ev.selected) || {};
      var showCpa = hasCpa && s['CPA'] !== false;
      var showCpl = hasCpl && s['CPL'] !== false;
      chartM.setOption({
        grid: { right: gridRight(showCpa, showCpl) },
        yAxis: [{}, { show: showCpa }, { show: showCpl, offset: showCpa ? 40 : 0 }]
      });
    });
    chartM.resize();
    // modal se otevírá s animací → přeměř, až doběhne layout
    setTimeout(function () { safeResize(chartM, canvas); }, 60);

    var bits = [];
    bits.push('<b>' + esc(o.creative) + '</b>' + (d.funnel ? ' · ' + esc(d.funnel) : '') +
              ' · po týdnech · ' + fmtDate(o.from) + ' – ' + fmtDate(o.to));
    if (estIdx < L && L > 1) bits.push('<span style="color:#a2622c">poslední týden běží</span>');
    if (beV != null) {
      bits.push('<span style="color:' + REF_BREAKEVEN + '">┅ break-even ' + axisLabel(beV, 'roas') + '</span>');
    } else if (o.tab !== 'earrings') {
      bits.push('<span style="color:#a2622c">break-even linka není — funnel kreativy ho nemá zadaný</span>');
    }
    if (clip) bits.push('<span style="color:#a2622c">osa ROAS oříznuta na p95 (' + axisLabel(clip.max, 'roas') + '), špičky jsou v tooltipu</span>');
    if (!hasCpa) bits.push('CPA není — kreativa nemá v období rezervaci');
    if (!hasCpl) bits.push('CPL není — kreativa nemá v období lead');
    if (hasCpa && hasCpl) bits.push('CPA a CPL mají <b>každý svou osu</b> (CPA bývá 10–50× CPL)');
    if (d.weeksTotal >= MINI_MAX_WEEKS) bits.push('zobrazeno posledních ' + MINI_MAX_WEEKS + ' týdnů');
    foot.innerHTML = bits.join(' · ');
  }

  /* =========================================================================
   * 9) vstupní bod
   * ====================================================================== */

  function onReady() {
    var tab = currentTab();
    // whitelist metrik ze serveru → teprve pak stavíme ovládání (žádné HTTP 400)
    ensureAllowed().then(function () {
      if (mountFor(tab)) {
        syncSelToTab(tab);
        buildControls(tab);
        if (chart) chart.resize();   // view mohlo být skryté ([hidden] → 0×0)
        scheduleLoad();
      }
      loadWeekly();                  // F4 — mount #weekly-root (když v index.html je)
    });
  }

  // expozice miniTrend (M1) — tables.js ji volá v modalu po kliknutí na reklamu
  function exposeApi() {
    if (!window.ADS) return false;
    window.ADS.miniTrend = miniTrend;
    return true;
  }

  (function boot() {
    exposeApi();
    if (window.ADS && typeof window.ADS.onReady === 'function') { window.ADS.onReady(onReady); return; }
    var tries = 0;
    var iv = setInterval(function () {
      if (window.ADS && typeof window.ADS.onReady === 'function') {
        clearInterval(iv);
        exposeApi();
        window.ADS.onReady(onReady);
      } else if (++tries > 400) clearInterval(iv);   // ~12 s pojistka
    }, 30);
  })();

})();
