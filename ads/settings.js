/* ==========================================================================
 * NK Ads Dashboard — NASTAVENÍ (settings.js)
 * --------------------------------------------------------------------------
 * Filip (16. 7.): „všechno, co používáme, seřazené do SEKCÍ. Nemusí tam toho
 * být zbytečně hodně teďka." → co je v configu, patří sem.
 *
 * ZODPOVĚDNOST: jen mount #view-settings. Routing (ADS.route + event
 * 'routechange') a <script> tag v index.html dělá shell agent.
 *
 * KONTRAKT S API (staví api agent):
 *   GET  ?action=settings_get                    → {sections:[{key,title,desc,items:[…]}]}
 *   POST ?action=settings_save  {values:{K:v,…}} → {ok:true, saved:[…]}
 *   GET  ?action=overview&from&to&tab            → totals.kill_count / totals.winner_count
 *
 * Klient je ZÁMĚRNĚ TOLERANTNÍ k tvaru odpovědi (normItem/normSections) —
 * settings_get vzniká paralelně a nesmí nás rozbít drobná odchylka v názvu klíče.
 * Když endpoint neexistuje vůbec, spadneme na ?action=config (read-only režim
 * s poctivým bannerem) — Filip nikdy neuvidí prázdnou/rozbitou stránku.
 *
 * POPISY ČESKY: server je zdroj pravdy pro to, CO existuje (a jakou to má
 * hodnotu). Texty „co to dělá" vlastní CATALOG tady — Filip explicitně nechce
 * jen názvy konstant. Server může poslat vlastní `desc` a přebije katalog.
 *
 * DOPAD: po uložení prahu, který hýbe kill/winners, se přenačte ?action=overview
 * a nad sekcemi se vypíše „kill 8 → 12" (+ „Vrátit zpět"). Ať Filip vidí, co dělá.
 *
 * S3 (17. 7.) — DVĚ ZÁLOŽKY. Filip: „ty nejdůležitější věci jako hraniční ROASy
 * a takový dej jako hlavní a pak tam dej pod záložku třeba jakože pokročilé."
 * Dělení drží SECTION_TAB (klíč sekce → záložka), ne pořadí — server může sekce
 * přeskládat a rozdělení to ustojí. Neznámá sekce padá do Pokročilých: radši ji
 * Filip najde o klik dál, než aby mu zaplevelila Hlavní. Hledání jde NAPŘÍČ oběma.
 *
 * S4 (17. 7.) — VIZUÁLNÍ ŠKÁLA ROAS. Filip: „ROAS 30 a ROAS 3 stejnou barvou…
 * to nemůže bejt. Podobně jak to je v Google tabulkách, podmíněné formátování."
 * Ze čtyř zlomů (ROAS_GREEN/LGREEN/YELLOW/ORANGE) se stane JEDEN ovladač: pruh
 * s taženými hranicemi + přesné číselné vstupy + živý náhled. Ukládá se ale pořád
 * po jednom klíči přes settings_save — kontrakt s API se NEMĚNÍ (viz doSave).
 *
 * Styly: css/settings.css (dřív inline string tady). Načtení viz ensureCss() —
 * <link> si modul v případě nouze přidá sám, ať nezávisí na cizím index.html.
 * Barvy/rádiusy z proměnných styles.css (s fallbackem) → konzistence se shellem.
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__ADS_SETTINGS_LOADED__) return;
  window.__ADS_SETTINGS_LOADED__ = true;

  var MOUNT_ID = 'view-settings';
  var MOUNT_SEL = '#' + MOUNT_ID;
  /* Klíč routy NEHÁDÁME: bereme ho z ADS.ROUTES podle `mount` (zdroj pravdy = shell).
     Shell dnes routuje česky (#/nastaveni) — kdyby se klíč přejmenoval, tohle to ustojí.
     Fallback je jen pro případ, že by registr ještě nebyl naplněný. */
  var ROUTE_FALLBACK = ['nastaveni', 'settings'];

  /* ------------------------------------------------------------------ *
   * Utility (defenzivní — modul nesmí spadnout, když shell ještě nemá ADS)
   * ------------------------------------------------------------------ */
  function A() { return window.ADS || {}; }
  function esc(s) {
    var f = A()._esc;
    if (f) return f(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function mount() { return document.querySelector(MOUNT_SEL); }
  function toast(msg, type) {
    var t = A().toast;
    if (t) { t(msg, type); return; }
    console.log('[settings]', type || 'info', msg);
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  /* '2026-07-15 18:40:00' → '15. 7. 2026 18:40' (server posílá DATETIME) */
  function fmtWhen(ts) {
    if (!ts) return '';
    var s = String(ts);
    var f = A().fmt;
    var d = f ? f.date(s) : s.slice(0, 10);
    var m = s.match(/(\d{2}):(\d{2})/);
    return d + (m ? ' ' + m[1] + ':' + m[2] : '');
  }

  /* Čísla česky: 2.5 → „2,5"; bez zbytečných nul (2.0 → „2"). */
  function fmtNum(v, dec) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    var s = (dec == null) ? String(n) : n.toFixed(dec);
    if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', ',');
  }
  /* „2,5" i „2.5" → 2.5. Prázdné → null (ať jde odlišit od 0). */
  function parseNum(s) {
    if (s == null) return null;
    var t = String(s).trim().replace(/\s| /g, '').replace(',', '.');
    if (t === '') return null;
    if (!/^-?\d*\.?\d+$/.test(t)) return NaN;
    return Number(t);
  }

  /* ================================================================== *
   * KATALOG — české popisy „co to dělá", typy, meze, jednotky.
   * Zdroj: config.sample.php + reálné použití v api.php (ověřeno čtením kódu).
   * type:  roas | money | int | pct | float | bool | select | text | json
   * impact:'kill' | 'winners' | 'both' | 'colors' | null  → hlídá se dopad
   * ================================================================== */
  var CATALOG = {
    /* ---- Break-even ---- */
    FUNNEL_BREAKEVEN_DEFAULT: {
      s: 'breakeven', label: 'Break-even ROAS', type: 'roas', unit: '×', min: 0, max: 20, step: 0.1, impact: 'kill',
      desc: 'Hranice, pod kterou kreativa prodělává. Platí plošně pro všechny funnely. Kotví se na ROAS model. Kreslí se jako referenční linka v grafech a spouští kill vrstvu 4 (zralá kreativa pod break-even). Je to SAFE hranice — reálný break-even je vyšší, počítá se s tím, že se ne všechna tržba dotrackuje.',
      danger: function (v) { return v <= 0 ? 'Break-even 0 vypne kill vrstvu 4 — žádná zralá kreativa už nebude označená jako prodělečná a linka v grafech zmizí.' : ''; }
    },

    /* ---- Winners / škálování ---- */
    WINNER_ROAS: {
      s: 'winners', label: 'Winner: minimální ROAS model', type: 'roas', unit: '×', min: 0, max: 30, step: 0.1, impact: 'winners',
      desc: 'Od jakého ROAS model se kreativa počítá jako winner (zelená sekce). Níž = víc winnerů, ale i slabší kusy mezi nimi.',
      danger: function (v) { return v <= 0 ? 'Winner ROAS 0 označí za winnera úplně každou kreativu.' : ''; }
    },
    WINNER_MIN_BOOKINGS: {
      s: 'winners', label: 'Winner: minimálně schůzek', type: 'int', unit: 'schůzek', min: 0, max: 200, step: 1, impact: 'winners',
      desc: 'Kolik schůzek musí kreativa mít, aby se vůbec směla stát winnerem. Chrání před tím, aby z jedné náhodné schůzky vznikl „winner" s obřím ROASem a třemi leady.'
    },
    SCALE_MIN_BOOKINGS: {
      s: 'winners', label: 'Scale-ready: minimálně schůzek', type: 'int', unit: 'schůzek', min: 0, max: 500, step: 1, impact: 'winners',
      desc: 'Od kolika schůzek je winner označený jako připravený na škálování (✓✓✓). Samotné škálování dělá Vojta/Filip v Ads Manageru — dashboard rozpočty nemění.'
    },

    /* ---- Kill prahy ---- */
    SPEND_NO_LEAD_MIN: {
      s: 'kill', label: 'Kill 1 — utraceno bez jediného leadu', type: 'money', unit: 'Kč', min: 0, max: 100000, step: 50, impact: 'kill',
      desc: 'Kolik smí kreativa spálit úplně bez leadu, než ji dashboard navrhne zabít. Pod touhle částkou se bere jako „čekáme na data" a v kill sekci se vůbec neukáže.',
      danger: function (v) { return v <= 0 ? 'Nula znamená, že kill kandidát je každá kreativa hned po startu — ještě než stihne přinést první lead.' : ''; }
    },
    CPL_EXTREME: {
      s: 'kill', label: 'Kill 3 — extrémní cena za lead', type: 'money', unit: 'Kč', min: 0, max: 100000, step: 50, impact: 'kill',
      desc: 'Cena za lead, nad kterou je kreativa automaticky kill kandidát.',
      danger: function (v) { return v <= 0 ? 'Nula označí za extrémní CPL úplně každou kreativu, která má aspoň jeden lead.' : ''; }
    },
    TICHY_MIN_LEADS: {
      s: 'kill', label: 'Kill 2 — tichý žrout: minimálně leadů', type: 'int', unit: 'leadů', min: 0, max: 500, step: 1, impact: 'kill',
      desc: 'Kolik leadů musí kreativa nasbírat, aby se dala označit za „tichého žrouta" (leady chodí, ale žádná schůzka z nich není).'
    },
    TICHY_MIN_CALLED: {
      s: 'kill', label: 'Kill 2 — tichý žrout: minimálně provoláno', type: 'int', unit: 'leadů', min: 0, max: 500, step: 1, impact: 'kill',
      desc: 'Kolik leadů musí být provoláno, aby „žádné schůzky" vůbec něco znamenalo. Neprovolaný lead o kvalitě kreativy neříká nic — chyba je pak na call centru, ne v reklamě.'
    },
    MATURE_MIN_BOOKINGS: {
      s: 'kill', label: 'Kill 4 — zralá kreativa: minimálně schůzek', type: 'int', unit: 'schůzek', min: 0, max: 200, step: 1, impact: 'kill',
      desc: 'Od kolika schůzek se kreativa bere jako dost zralá na to, aby se soudila podle ROAS (kill pod break-even). Pozor: skutečnou laťku drží statistický minimální vzorek níž — bere se přísnější z těch dvou.'
    },
    EARLY_KILL_SPEND: {
      s: 'kill', label: 'Mladá kreativa — hranice spendu', type: 'money', unit: 'Kč', min: 0, max: 100000, step: 50, impact: 'kill',
      desc: 'Pod tímhle spendem a bez jediné schůzky je kreativa „mladá" a dashboard ji nekilluje — nemá dost dat na to, aby se dala soudit.'
    },
    GRACE_DAYS_DEFAULT: {
      s: 'kill', label: 'Ochranná lhůta nové kreativy', type: 'int', unit: 'dní', min: 0, max: 30, step: 1, impact: 'kill',
      desc: 'Kolik dní po startu se kreativa nekilluje na CPL ani jako tichý žrout — má čas na rozjezd. Vrstva „utraceno bez leadu" běží dál. Jednotlivé funnely můžou mít vlastní lhůtu (viz Nuance pravidel).'
    },
    KILL_FALSE_ALARM: {
      s: 'kill', label: 'Přípustná šance, že killneme dobrou kreativu', type: 'pct', unit: '%', min: 1, max: 50, step: 1, impact: 'kill',
      desc: 'Statistická pojistka. Dobrá kreativa může mít 0 prodejů jen smůlou — tohle říká, jak velkou takovou smůlu ještě tolerujeme. Z toho se DOPOČÍTÁ minimální vzorek, který kreativa musí mít, než ji vrstva 4 smí zabít: n > ln(α) / ln(1−p). Nižší číslo = opatrnější dashboard (zabíjí později, ale jistěji).',
      derive: function (v, ctx) {
        var g = (ctx && ctx.kill_guards) || {};
        var out = [];
        /* Jednotku skloňujeme SAMI. Server posílá `sample_unit` v 1. pádě („rezervace")
           → „≥ 8 rezervace" je patvar. Filip tohle čte, tak ať to je česky. */
        var UNIT = {
          rings: ['rezervaci', 'rezervace', 'rezervací'],
          earrings: ['poptávku', 'poptávky', 'poptávek']
        };
        ['rings', 'earrings'].forEach(function (tab) {
          var p = g[tab] && Number(g[tab].base_rate);
          if (!p || p <= 0 || p >= 1 || !(v > 0 && v < 1)) return;
          var n = Math.ceil(Math.log(v) / Math.log(1 - p));
          var u = UNIT[tab] || ['', '', ''];
          out.push('kreativy: ≥ ' + n + ' ' + plural(n, u[0], u[1], u[2]));
        });
        return out.length ? '→ minimální vzorek pro kill: ' + out.join(' · ') : '';
      },
      danger: function (v) { return v >= 0.5 ? 'Nad 50 % znamená, že každý druhý kill může být omyl na dobré kreativě.' : ''; }
    },

    /* ---- Náušnice ---- */
    EARRINGS_SPEND_MULTIPLE: {
      s: 'earrings', label: 'Náušnice: násobek průměrné ceny za rezervaci', type: 'float', unit: '×', min: 0, max: 20, step: 0.1, impact: 'kill',
      desc: 'Filip: „když spálí víc než ~2× průměrný cost per reservation, označit jako špatné." Práh se počítá dynamicky za zvolené okno: násobek × průměrná cena za rezervaci, počítaná JEN z kreativ, které aspoň jednou konvertovaly (= kolik stojí rezervace, když to funguje). Kalibruje se sám, jak se cena mění. Ladí se — je to nový funnel s malým vzorkem.'
    },
    EARRINGS_SPEND_DYN_MIN: {
      s: 'earrings', label: 'Náušnice: spodní mantinel prahu', type: 'money', unit: 'Kč', min: 0, max: 50000, step: 50, impact: 'kill',
      desc: 'Pod tímhle prahem se náušnicová kreativa nekilluje nikdy — pojistka proti tomu, aby divoký malý vzorek stlačil práh k nule a dashboard začal kosit všechno.'
    },
    EARRINGS_SPEND_DYN_MAX: {
      s: 'earrings', label: 'Náušnice: horní mantinel prahu', type: 'money', unit: 'Kč', min: 0, max: 200000, step: 100, impact: 'kill',
      desc: 'Strop dynamického prahu. Když průměrná cena za rezervaci vyletí (rozbitý/malý vzorek), práh se dál nezvedá — jinak by se kill u náušnic tiše vypnul.'
    },

    /* ---- Semafor ---- */
    ROAS_GREEN: {
      s: 'semafor', label: 'Zelená od', type: 'roas', unit: '×', min: 0, max: 50, step: 0.1, impact: 'colors',
      desc: 'ROAS model, od kterého se číslo v tabulkách obarví zeleně. Jen barva — na kill/winners nemá vliv.'
    },
    ROAS_LGREEN: {
      s: 'semafor', label: 'Světle zelená od', type: 'roas', unit: '×', min: 0, max: 50, step: 0.1, impact: 'colors',
      desc: 'Od téhle hodnoty světle zelená (pásmo těsně nad break-even).'
    },
    ROAS_YELLOW: {
      s: 'semafor', label: 'Žlutá od', type: 'roas', unit: '×', min: 0, max: 50, step: 0.1, impact: 'colors',
      desc: 'Od téhle hodnoty žlutá.'
    },
    ROAS_ORANGE: {
      s: 'semafor', label: 'Oranžová od (pod ní červená)', type: 'roas', unit: '×', min: 0, max: 50, step: 0.1, impact: 'colors',
      desc: 'Od téhle hodnoty oranžová; všechno pod ní je červené.'
    },

    /* ---- Health ---- */
    HEALTH_YELLOW: {
      s: 'health', label: 'Žlutá od', type: 'pct', unit: '%', min: 0, max: 100, step: 1, impact: 'colors',
      desc: 'Health nahoře = kolik % spendu teče do kreativ s ROAS < 1. Od tohohle podílu je číslo žluté.'
    },
    HEALTH_RED: {
      s: 'health', label: 'Červená od', type: 'pct', unit: '%', min: 0, max: 100, step: 1, impact: 'colors',
      desc: 'Od tohohle podílu spendu v prodělku je health červený.'
    },

    /* ---- Zralost ---- */
    ZRALOST_GREEN: {
      s: 'zralost', label: 'Zelená od', type: 'pct', unit: '%', min: 0, max: 100, step: 1, impact: 'colors',
      desc: 'Zralost = % provolaných × % proběhlých schůzek = kolik z tržby je REÁLNÉ a kolik dopočet (u náušnic jen % provolaných). Není to stáří dat a nevstupuje do výpočtu — je to indikátor důvěry: je rozdíl, když je ROAS dopočtený z 25 % nebo z 90 %. Od tohohle podílu je kroužek zelený.'
    },
    ZRALOST_YELLOW: {
      s: 'zralost', label: 'Žlutá od', type: 'pct', unit: '%', min: 0, max: 100, step: 1, impact: 'colors',
      desc: 'Od tohohle podílu reálné tržby je zralost žlutá.'
    },
    ZRALOST_ORANGE: {
      s: 'zralost', label: 'Oranžová od (pod ní červená)', type: 'pct', unit: '%', min: 0, max: 100, step: 1, impact: 'colors',
      desc: 'Od tohohle podílu oranžová; pod ní červená = většina tržby je dopočet, číslu se nedá moc věřit.'
    },

    /* ---- Model / dopočet ---- */
    CALL_RATE_MIN: {
      s: 'model', label: 'Minimální % provolání (clamp)', type: 'pct', unit: '%', min: 1, max: 100, step: 1, impact: 'both',
      desc: 'Spodní pojistka pro dopočet. Modelová tržba se dělí procentem provolání — kdyby bylo skoro nulové, vyletěl by ROAS do nesmyslných výšin. Tohle je podlaha, pod kterou se % provolání pro výpočet nepustí.',
      danger: function (v) { return v <= 0 ? 'Nula = kreativa bez jediného provolaného leadu dostane nekonečnou modelovou tržbu.' : ''; }
    },
    DOPOCET_WARN_PCT: {
      s: 'model', label: 'Varovat, když je dopočet nad', type: 'pct', unit: '%', min: 0, max: 100, step: 1,
      desc: 'Nad tímhle podílem dopočtu dostane řádek badge „velký dopočet" — číslo je z větší části modelované, ne naměřené. Jen upozornění.'
    },
    CALL_RATE_WARN: {
      s: 'model', label: 'Varovat, když je % provolání pod', type: 'pct', unit: '%', min: 0, max: 100, step: 1,
      desc: 'Pod tímhle % provolání taky vyskočí badge „velký dopočet". Druhá cesta ke stejnému varování.'
    },

    /* ---- Anomálie ---- */
    ANOMALY_PCT: {
      s: 'anomaly', label: 'Odchylka pro anomálii', type: 'pct', unit: '%', min: 0, max: 300, step: 5,
      desc: 'O kolik se musí včerejší CPL funnelu lišit od mediánu předchozích 7 dní, aby vyskočil červený anomálie banner a doporučení ve wizardu. Níž = citlivější (a víc falešných poplachů).'
    },

    /* ---- Období / provoz ---- */
    NEW_ADS_DAYS: {
      s: 'period', label: 'Co je „nová reklama"', type: 'int', unit: 'dní', min: 1, max: 90, step: 1,
      desc: 'Kreativa vytvořená v posledních X dnech se ukáže v sekci Nejnovější reklamy.'
    },
    ESTIMATING_DAYS: {
      s: 'period', label: 'Dny, kde data ještě dotékají', type: 'int', unit: 'dní', min: 0, max: 14, step: 1,
      desc: 'Posledních X dní v grafech je šrafovaných s poznámkou „data ještě dotékají" — nejsou kompletní a nedá se podle nich soudit.'
    },
    CACHE_TTL_MIN: {
      s: 'period', label: 'Data jsou čerstvá', type: 'int', unit: 'minut', min: 1, max: 1440, step: 5,
      desc: 'Po jaké době se poslední obnovení označí za staré (čas vedle tlačítka „Obnovit teď").'
    },
    THUMB_SMALL_PX: {
      s: 'period', label: 'Náhled v tabulce', type: 'int', unit: 'px', min: 60, max: 1200, step: 20,
      desc: 'Šířka malého náhledu, který se stahuje z Mety do cache pro řádky tabulek.'
    },
    THUMB_BIG_PX: {
      s: 'period', label: 'Náhled ve velkém (hover / dlaždice)', type: 'int', unit: 'px', min: 200, max: 2400, step: 20,
      desc: 'Šířka velkého náhledu pro hover pop-up, dlaždice a modal.'
    },
    THUMB_MAX_AGE_DAYS: {
      s: 'period', label: 'Obnovit náhled po', type: 'int', unit: 'dnech', min: 1, max: 90, step: 1,
      desc: 'Jak dlouho se náhled drží v cache, než se stáhne znovu (Meta podepisuje URL a časem je zneplatní).'
    },
    META_META_WINDOW_DAYS: {
      s: 'period', label: 'Jak daleko zpět tahat reklamy z Mety', type: 'int', unit: 'dní', min: 7, max: 730, step: 7,
      desc: 'Okno pro stahování metadat reklam (náhled, status, datum vytvoření). Delší = pomalejší refresh.'
    },

    /* ---- Mapování (read-only) ---- */
    REMARKETING_PREFIX: {
      s: 'mapping', label: 'Prefix remarketingu (nevyhodnocuje se)', type: 'text',
      desc: 'Kreativy s tímhle prefixem vypadávají ze VŠECH tabů, segmentů, grafů i anomálií. Filip: „tam neřešíme vůbec nic, běží s malým budgetem."'
    },
    EARRINGS_PREFIX: {
      s: 'mapping', label: 'Prefix náušnic', type: 'text',
      desc: 'Podle tohohle prefixu se oddělují světy: náušnice nejsou v BigQuery, prsteny nejsou v Ninox share view. Bez toho by si taby křížily kill kandidáty.'
    },
    PREFIX_FUNNEL_MIN_PURITY: {
      s: 'mapping', label: 'Minimální čistota prefixu pro mapování funnelu', type: 'pct', unit: '%', min: 0, max: 100, step: 1,
      desc: 'Když kreativa nemá v BigQuery ani jeden lead, funnel se hádá z prefixu kódu. Mapují se jen prefixy, které mají aspoň takovouhle čistotu (L- má 78 % → radši se nemapuje a zůstane „---", než aby dashboard lhal).'
    },

    /* ---- Skryté (nepoužívané) ---- */
    KILL_ROAS_MIN: {
      hidden: 'Kill vrstva 4 jede od 16. 7. na break-even (plošně 2,0) — tahle konstanta se už nepoužívá.'
    }
  };

  /* Sekce: pořadí + hlavičky. Klíč sedí na CATALOG[].s */
  var SECTIONS = [
    { key: 'breakeven', ico: '⚖️', title: 'Break-even', desc: 'Jedna linka pro všechno. Nejsilnější knoflík v celém nástroji — sahá na kill i na grafy.' },
    { key: 'winners', ico: '🟢', title: 'Winners a škálování', desc: 'Kdy je kreativa vítěz a kdy je připravená na škálování.' },
    { key: 'kill', ico: '🔴', title: 'Kill prahy', desc: 'Čtyři vrstvy, podle kterých se kreativa dostane do sekce „Na kill". Kreativa může spadnout do víc vrstev — ukáže se ta nejvyšší priorita.' },
    { key: 'earrings', ico: '💎', title: 'Náušnice', desc: 'Náušnice mají jiný svět: poptávky a rezervace místo leadů a schůzek. Práh se počítá relativně k ceně za rezervaci, ne fixně.' },
    { key: 'semafor', ico: '🚦', title: 'Semafor ROAS (barvy)', desc: 'Jen obarvení čísel v tabulkách. Hodnoty musí klesat: zelená ≥ světle zelená ≥ žlutá ≥ oranžová.' },
    { key: 'health', ico: '❤️', title: 'Health (barvy)', desc: 'Velké číslo nahoře — kolik peněz teče do prodělku.' },
    { key: 'zralost', ico: '⏳', title: 'Zralost (barvy)', desc: 'Kolik % tržby je reálné a kolik dopočet. Indikátor důvěry v číslo, ne vstup do výpočtu.' },
    { key: 'model', ico: '🧮', title: 'Modelová tržba a dopočet', desc: 'Jak se dopočítává „tržba celkem". Parita s Lookerem — sahat sem jen s rozmyslem.' },
    { key: 'anomaly', ico: '⚡', title: 'Anomálie', desc: 'Kdy nástroj křikne, že se funnel zhoršil.' },
    { key: 'period', ico: '📅', title: 'Období, náhledy, provoz', desc: 'Co je nová reklama, kde data ještě dotékají, jak velké náhledy tahat.' },
    { key: 'mapping', ico: '🔤', title: 'Mapování kreativ', desc: 'Prefixy kódů a hádání funnelu, když kreativa nemá v BigQuery ani jeden lead.' },
    { key: 'other', ico: '⚙️', title: 'Ostatní', desc: 'Konstanty, které zatím nemají vlastní sekci.' }
  ];

  /* ================================================================== *
   * S3 — ZÁLOŽKY: Hlavní / Pokročilé
   * ------------------------------------------------------------------
   * Filip nechal dělení na mně („už nechám na tobě, co usoudíš"). Kritérium:
   * do HLAVNÍCH patří to, co mění ROZHODNUTÍ nástroje (co se killne, co je
   * winner, kde je hranice zisku, jakou barvou to Filip uvidí) — to jsou
   * knoflíky, na které sahá průběžně a podle výsledků. Do POKROČILÝCH jde to,
   * co se nastaví jednou a pak se toho nikdo nedotkne (statistika, mechanika
   * dopočtu, prefixy, délky oken, cache) — sáhnutí bez rozmyslu tam nadělá
   * škodu, kterou není vidět.
   *
   * Proč mapou a ne pořadím: sekce chodí ze serveru (api.php settings_registry)
   * a ten je smí přeskládat nebo přidat novou. Neznámá sekce → Pokročilé.
   * ================================================================== */
  var TAB_MAIN = 'hlavni', TAB_ADV = 'pokrocile';
  var TABS = [
    { key: TAB_MAIN, title: 'Hlavní', hint: 'Hranice zisku, winneři, kill a barvy' },
    { key: TAB_ADV, title: 'Pokročilé', hint: 'Statistika, dopočet, mapování, provoz' }
  ];
  var TAB_TITLE = { hlavni: 'Hlavní', pokrocile: 'Pokročilé' };
  var SECTION_TAB = {
    /* klíče sekcí ze serveru (api.php settings_registry) */
    ziskovost: TAB_MAIN,      // break-even + winner/scale prahy
    kill: TAB_MAIN,
    nausnice: TAB_MAIN,       // kill prahy náušnic (S5)
    statistika: TAB_ADV,
    // Semafor je HLAVNÍ: bydlí v něm vizuální škála ROAS (S4) a Filip ji zadal jako jednu
    // z klíčových věcí („ROAS 30 a ROAS 3 nesmí bejt stejně zelený… hezkej vizuální picker").
    // Barvy jsou rozhodnutí — podle nich Filip kouká, co killnout a co škálovat.
    // (Původní plán agenta — vytáhnout ROAS_* do syntetické sekce `roas_scale` — se nekonal;
    //  škála se renderuje přímo v hlavičce téhle sekce, viz sectionHTML().)
    semafor: TAB_MAIN,
    model: TAB_ADV,
    zobrazeni: TAB_ADV,
    mapovani: TAB_ADV,
    /* klíče z fallbacku ?action=config (groupFlat podle CATALOG[].s) */
    breakeven: TAB_MAIN, winners: TAB_MAIN, earrings: TAB_MAIN,
    health: TAB_ADV, zralost: TAB_ADV, anomaly: TAB_ADV, period: TAB_ADV,
    mapping: TAB_ADV, other: TAB_ADV
  };
  /* Barevná škála ROAS (S4) — vlastní syntetická sekce, viz buildScaleSection(). */
  var SCALE_SECTION = 'roas_scale';
  SECTION_TAB[SCALE_SECTION] = TAB_MAIN;
  function tabOf(secKey) { return SECTION_TAB[secKey] || TAB_ADV; }

  /* ================================================================== *
   * S4 — VIZUÁLNÍ ŠKÁLA ROAS
   * ------------------------------------------------------------------
   * Pořadí je ZÁVAZNÉ: od nejvyššího zlomu dolů. Na tom stojí clampBreak()
   * (soused nahoře = strop, soused dole = podlaha) i kreslení pásem.
   * Pod posledním zlomem (oranžová) je červená — ta vlastní práh nemá.
   * ================================================================== */
  var ROAS_BREAKS = [
    { key: 'ROAS_GREEN', band: 'green', label: 'Zelená' },
    { key: 'ROAS_LGREEN', band: 'lgreen', label: 'Světle zelená' },
    { key: 'ROAS_YELLOW', band: 'yellow', label: 'Žlutá' },
    { key: 'ROAS_ORANGE', band: 'orange', label: 'Oranžová' }
  ];
  /* Osa pruhu. Roste po schodech, ne plynule — kdyby se počítala přesně z hodnot,
     ujížděla by Filipovi pod rukou při každém tažení. Hrubé schody = při běžném
     posunu se osa nehne vůbec. Přepočítá se navíc až po puštění (viz S.scaleDrag). */
  var AXIS_LADDER = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
  /* Živý náhled. Schválně obsahuje 3× / 4× / 12× / 30× — přesně ta čísla, na která
     Filip ukázal („ROAS 30 a ROAS 3 stejně zelený"). Ať na vlastní oči vidí, kdy
     je škála pořád rozbitá a kdy už ne. */
  var SCALE_SAMPLES = [0.8, 1.2, 1.6, 2.2, 3, 4, 12, 30];

  /* Vzájemné vazby — bez nich jde nastavit tiše rozbitý stav (např. zelená < žlutá). */
  var CROSS = [
    {
      keys: ['ROAS_GREEN', 'ROAS_LGREEN', 'ROAS_YELLOW', 'ROAS_ORANGE'],
      test: function (v) { return v.ROAS_GREEN >= v.ROAS_LGREEN && v.ROAS_LGREEN >= v.ROAS_YELLOW && v.ROAS_YELLOW >= v.ROAS_ORANGE; },
      msg: 'Semafor musí klesat: zelená ≥ světle zelená ≥ žlutá ≥ oranžová. Jinak se barvy přebijí a některá už nikdy nevyskočí.'
    },
    {
      keys: ['ZRALOST_GREEN', 'ZRALOST_YELLOW', 'ZRALOST_ORANGE'],
      test: function (v) { return v.ZRALOST_GREEN >= v.ZRALOST_YELLOW && v.ZRALOST_YELLOW >= v.ZRALOST_ORANGE; },
      msg: 'Zralost musí klesat: zelená ≥ žlutá ≥ oranžová.'
    },
    {
      keys: ['HEALTH_YELLOW', 'HEALTH_RED'],
      test: function (v) { return v.HEALTH_YELLOW <= v.HEALTH_RED; },
      msg: 'Health: žlutá musí být níž než červená (čím víc spendu v prodělku, tím hůř).'
    },
    {
      keys: ['EARRINGS_SPEND_DYN_MIN', 'EARRINGS_SPEND_DYN_MAX'],
      test: function (v) { return v.EARRINGS_SPEND_DYN_MIN <= v.EARRINGS_SPEND_DYN_MAX; },
      msg: 'Náušnice: spodní mantinel musí být níž než horní.'
    },
    {
      keys: ['TICHY_MIN_CALLED', 'TICHY_MIN_LEADS'],
      test: function (v) { return v.TICHY_MIN_CALLED <= v.TICHY_MIN_LEADS; },
      msg: 'Tichý žrout: provoláno nemůže být víc než leadů — vrstva 2 by se nikdy nespustila.'
    },
    {
      keys: ['WINNER_MIN_BOOKINGS', 'SCALE_MIN_BOOKINGS'],
      test: function (v) { return v.SCALE_MIN_BOOKINGS >= v.WINNER_MIN_BOOKINGS; },
      msg: 'Scale-ready musí být přísnější než winner (víc schůzek), jinak je scale-ready dřív než výhra.'
    }
  ];

  /* ------------------------------------------------------------------ *
   * Stav modulu
   * ------------------------------------------------------------------ */
  var S = {
    loaded: false,
    loading: false,
    error: null,
    readonly: false,      // fallback z ?action=config → jen čtení
    readonlyWhy: '',
    sections: [],         // [{key,ico,title,desc,items:[normItem]}]
    byKey: {},            // key → item
    /* S3: aktivní záložka. Pamatuje se — Filip chodí do Pokročilých kvůli jedné věci
       a nechce je pokaždé hledat znovu. */
    tab: (function () {
      try { var v = localStorage.getItem('ads.settings.tab'); return (v === 'pokrocile') ? v : 'hlavni'; }
      catch (_) { return 'hlavni'; }
    })(),
    edits: {},            // key → nová hodnota (jen změněné)
    mapRows: {},          // M5: key → [[k,v],…] rozpracovaný řádkový model mapy
    funnels: [],          // M5: seznam funnelů do výběrů (ze settings_get.funnels)
    overrideKeys: null,   // M5: povolené prahy pro FUNNEL_OVERRIDES (ze serveru, jinak fallback)
    saving: false,
    ctx: {},              // kill_guards apod. pro derive()
    lastImpact: null,     // {before,after,keys,prev}
    q: '',                // hledání
    // (S3: `tab` se inicializuje z localStorage výš, ř. 443–446 — DUPLICITNÍ
    //  `tab: TAB_MAIN` tady byl bug: přepisoval zapamatovanou záložku na „hlavní".)
    /* S4 — stav pickeru škály */
    scaleAxis: 0,         // horní konec osy pruhu (schod z AXIS_LADDER)
    scaleDrag: false,     // táhne se úchyt → osa zamrzlá, ať necuká
    scaleTyping: null,    // klíč, do kterého Filip zrovna píše → nepřepisovat mu ho
    scaleLast: {},        // poslední ČITELNÁ hodnota zlomu (drží pruh, když je v poli „2,")
    barHtml: null         // poslední HTML save baru → nepřekresluj beze změny (restart animace)
  };

  /* M5 — povolené prahy v FUNNEL_OVERRIDES.
   * ⚠️ ZRCADLO api.php `settings_override_keys()` (dnes se seznam v settings_get NEPOSÍLÁ).
   * Kdyby ho server někdy začal posílat (`override_keys`), má přednost — viz load().
   * Server validuje TOTÉŽ, takže rozjezd map = česká hláška z API, ne tichý rozpad.
   * Pozn.: `GRACE_DAYS` tu je schválně, i když se práh v registru jmenuje
   * GRACE_DAYS_DEFAULT — override klíč je bez sufixu (api.php:502). */
  var OVERRIDE_KEYS_FALLBACK = [
    'CPL_EXTREME', 'SPEND_NO_LEAD_MIN', 'TICHY_MIN_LEADS', 'TICHY_MIN_CALLED',
    'MATURE_MIN_BOOKINGS', 'WINNER_ROAS', 'WINNER_MIN_BOOKINGS', 'SCALE_MIN_BOOKINGS',
    'EARLY_KILL_SPEND', 'GRACE_DAYS'
  ];
  function overrideKeys() { return S.overrideKeys || OVERRIDE_KEYS_FALLBACK; }
  /* Český popisek prahu — vezmi label z registru (server ho posílá), jinak konstantu. */
  function thLabel(k) {
    var it = S.byKey[k] || S.byKey[k + '_DEFAULT'];
    return it ? it.label : k;
  }

  /* ------------------------------------------------------------------ *
   * Normalizace odpovědi (tolerantní — settings_get staví jiný agent)
   * ------------------------------------------------------------------ */
  function pick() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    return undefined;
  }
  /* Jako pick(), ale PRÁZDNÝ ŘETĚZEC bere jako „nevyplněno" a jde dál.
     Proč zvlášť: server u některých polí posílá desc:'' / label:'' — s obyčejným pick()
     by prázdný string vyhrál nad katalogem a Filipovi by zbyl holý název konstanty
     bez vysvětlení. Na hodnoty (value) tohle POUŽÍVAT NELZE — tam je '' legitimní. */
  function pickStr() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  }
  function prettyKey(k) {
    return String(k || '').toLowerCase().replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function inferType(v, cat) {
    if (cat && cat.type) return cat.type;
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    if (v && typeof v === 'object') return 'json';
    return 'text';
  }
  /* ------------------------------------------------------------------ *
   * normItem — sloučení serverového pole s katalogem.
   *
   * ⚠️ DĚLBA PRÁCE (ověřeno proti api.php settings_registry()):
   *   • label/desc  → SERVER vyhrává. Registr v api.php je psaný ke KÓDU, který to
   *     počítá (a je psaný česky a dobře). Katalog je fallback — kdyby server popis
   *     neposlal, ať tam není holý název konstanty.
   *   • type        → server posílá generické 'number' u VŠEHO (34×). To by z 0,15
   *     udělalo „0,15" místo „15 %" a z 450 „450" bez „Kč". Když tedy katalog zná
   *     konkrétnější typ (pct/money/roas/int), vyhrává KATALOG. Specifický serverový
   *     typ (map/map_number/json/text/select) se respektuje vždy.
   *   • min/max/step → SERVER vyhrává (je to jeho validace, zrcadlíme ji).
   *     ALE: procenta posílá v 0–1 (min 0, max 1, step 0.01) a my je kreslíme v 0–100
   *     → rozsah se přeškáluje ×100, jinak by „15 %" spadlo na „maximum je 1".
   *   • unit        → u pct náš '%' (server posílá „podíl (0–1)", což s naším vstupem
   *     nesedí), jinak server ('Kč', '× ROAS', 'prefix kódu' — ty jsou dobré).
   * ------------------------------------------------------------------ */
  function normItem(raw, key) {
    var k = String(pick(raw && raw.key, raw && raw.name, raw && raw.const, key) || '');
    var cat = CATALOG[k] || {};
    var value = pick(raw && raw.value, raw && raw.current, raw && raw.val, raw && raw.v);
    var dflt = pick(raw && raw['default'], raw && raw.default_value, raw && raw.dflt, raw && raw.def);

    var sType = raw && raw.type;
    var type;
    if (sType && sType !== 'number') type = sType;             // map/map_number/json/text/select
    else if (cat.type) type = cat.type;                        // pct/money/roas/int — čitelné
    else type = inferType(value, cat);
    if (type === 'number') type = Number.isInteger(Number(value)) ? 'int' : 'float';

    var isPct = (type === 'pct');
    var sMin = raw && raw.min, sMax = raw && raw.max, sStep = raw && raw.step;
    /* Server dává procenta v 0–1 → do našeho 0–100 prostoru */
    var pctScale = isPct && (sMax != null && Number(sMax) <= 1);
    var min = (sMin != null) ? (pctScale ? Number(sMin) * 100 : Number(sMin)) : cat.min;
    var max = (sMax != null) ? (pctScale ? Number(sMax) * 100 : Number(sMax)) : cat.max;
    var step = (sStep != null) ? (pctScale ? Number(sStep) * 100 : Number(sStep)) : pick(cat.step, 1);

    return {
      key: k,
      label: pickStr(raw && raw.label, raw && raw.title, cat.label, prettyKey(k)),
      desc: pickStr(raw && raw.desc, raw && raw.description, raw && raw.help, cat.desc, ''),
      type: type,
      value: value,
      dflt: dflt,
      min: min, max: max, step: step,
      unit: isPct ? '%' : pickStr(raw && raw.unit, cat.unit, ''),
      options: pick(raw && raw.options, cat.options, null),
      maxlen: pick(raw && raw.maxlen, null),
      readonly: !!pick(raw && raw.readonly, raw && raw.locked, cat.readonly, false),
      impact: pick(cat.impact, raw && raw.impact, null),
      derive: cat.derive || null,
      dangerFn: cat.danger || null,
      hidden: cat.hidden || null,
      /* server: overridden = v DB je řádek, který přebíjí config.php (+ kdo/kdy) */
      overridden: !!(raw && raw.overridden),
      who: (raw && raw.who) || '',
      updated_at: (raw && raw.updated_at) || null,
      keyLabel: (raw && raw.key_label) || null,
      valueLabel: (raw && raw.value_label) || null,
      sec: pick(raw && raw.section, cat.s, 'other')
    };
  }
  /* Přijme: {sections:[…]} · {sections:{k:{…}}} · {items:[…]} · {values:{K:v}} · holé {K:v} */
  function normSections(res) {
    var out = [];
    var secs = res && (res.sections || res.groups);
    if (secs && !Array.isArray(secs) && typeof secs === 'object') {
      secs = Object.keys(secs).map(function (k) {
        var s = secs[k] || {};
        if (!s.key) s.key = k;
        return s;
      });
    }
    if (Array.isArray(secs)) {
      secs.forEach(function (s) {
        var items = s.items || s.settings || s.fields || [];
        if (!Array.isArray(items) && typeof items === 'object') {
          items = Object.keys(items).map(function (k) { return normItem(items[k], k); });
        } else {
          items = items.map(function (it) { return normItem(it); });
        }
        items = items.filter(function (it) { return it.key; });
        var meta = null;
        for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].key === s.key) meta = SECTIONS[i];
        /* Stejné pravidlo jako u položek: hlavičky sekcí česky vlastní SECTIONS, server je fallback. */
        out.push({
          key: s.key || (meta && meta.key) || 'other',
          ico: pickStr(meta && meta.ico, s.ico, s.icon, '⚙️'),
          title: pickStr(s.title, s.label, meta && meta.title, prettyKey(s.key)),
          desc: pickStr(s.desc, s.description, meta && meta.desc, ''),
          items: items
        });
      });
      return out;
    }
    /* Plochý tvar → seskup podle katalogu */
    var flat = [];
    var src = (res && (res.items || res.settings)) || null;
    if (Array.isArray(src)) {
      flat = src.map(function (it) { return normItem(it); });
    } else {
      var vals = (res && (res.values || res.thresholds || res.th)) || res || {};
      flat = Object.keys(vals).filter(function (k) {
        return /^[A-Z][A-Z0-9_]*$/.test(k);          // jen konstanty, ne user/funnels/…
      }).map(function (k) {
        var v = vals[k];
        return normItem((v && typeof v === 'object' && !Array.isArray(v)) ? v : { value: v }, k);
      });
    }
    return groupFlat(flat);
  }
  function groupFlat(flat) {
    var bucket = {};
    flat.forEach(function (it) { (bucket[it.sec] = bucket[it.sec] || []).push(it); });
    var out = [];
    SECTIONS.forEach(function (s) {
      if (!bucket[s.key] || !bucket[s.key].length) return;
      out.push({ key: s.key, ico: s.ico, title: s.title, desc: s.desc, items: bucket[s.key] });
      delete bucket[s.key];
    });
    Object.keys(bucket).forEach(function (k) {
      out.push({ key: k, ico: '⚙️', title: prettyKey(k), desc: '', items: bucket[k] });
    });
    return out;
  }

  /* Katalogové pořadí uvnitř sekce (server pořadí respektujeme, když ho pošle) */
  function sortWithinSections(sections, serverOrdered) {
    if (serverOrdered) return sections;
    var order = Object.keys(CATALOG);
    sections.forEach(function (s) {
      s.items.sort(function (a, b) {
        var ia = order.indexOf(a.key), ib = order.indexOf(b.key);
        if (ia < 0) ia = 9999; if (ib < 0) ib = 9999;
        return ia - ib || a.key.localeCompare(b.key);
      });
    });
    return sections;
  }

  /* ------------------------------------------------------------------ *
   * Načtení
   * ------------------------------------------------------------------ */
  function load() {
    if (S.loading) return Promise.resolve();
    S.loading = true; S.error = null;
    render();
    return A().api('settings_get').then(function (res) {
      var serverOrdered = !!(res && (res.sections || res.groups));
      S.sections = sortWithinSections(normSections(res), serverOrdered);
      S.readonly = !!(res && res.readonly);
      S.readonlyWhy = (res && res.readonly_note) || '';
      S.ctx = { kill_guards: (res && res.kill_guards) || null };
      /* M5: seznam funnelů do výběrů v mapách — server ho posílá vedle sekcí. */
      S.funnels = (res && Array.isArray(res.funnels)) ? res.funnels.slice() : [];
      S.overrideKeys = (res && Array.isArray(res.override_keys) && res.override_keys.length)
        ? res.override_keys.slice() : null;
      finishLoad();
    }).catch(function (e) {
      /* settings_get ještě není nasazený → read-only z ?action=config.
         Radši poctivý read-only přehled než prázdná stránka. */
      return A().api('config').then(function (cfg) {
        var th = (cfg && (cfg.thresholds || cfg.th)) || {};
        var merged = {};
        Object.keys(th).forEach(function (k) { merged[k] = th[k]; });
        if (cfg && cfg.breakeven && cfg.breakeven['default'] != null) {
          merged.FUNNEL_BREAKEVEN_DEFAULT = cfg.breakeven['default'];
        }
        S.sections = sortWithinSections(normSections({ values: merged }), false);
        S.funnels = (cfg && Array.isArray(cfg.funnels)) ? cfg.funnels.slice() : [];
        S.readonly = true;
        S.readonlyWhy = 'Ukládání zatím není napojené (endpoint settings_get/settings_save neodpovídá' +
          (e && e.status ? ', HTTP ' + e.status : '') + '). Hodnoty jsou živé z configu, ale měnit je zatím nejde.';
        S.ctx = { kill_guards: (cfg && cfg.kill_guards) || null };
        finishLoad();
      }).catch(function (e2) {
        S.loading = false; S.loaded = false;
        S.error = 'Nastavení se nepodařilo načíst' + (e2 && e2.status ? ' (HTTP ' + e2.status + ')' : '') + '.';
        render();
      });
    });
  }
  function finishLoad() {
    S.byKey = {};
    S.sections.forEach(function (s) {
      s.items = s.items.filter(function (it) {
        if (it.hidden) { hiddenNotes[it.key] = it.hidden; return false; }
        return true;
      });
      s.items.forEach(function (it) { S.byKey[it.key] = it; });
    });
    S.sections = S.sections.filter(function (s) { return s.items.length; });
    S.loading = false; S.loaded = true; S.edits = {};
    S.mapRows = {};        // M5: řádkový model se staví líně z čerstvých hodnot
    render();
  }
  var hiddenNotes = {};

  /* ------------------------------------------------------------------ *
   * Hodnoty + validace
   * ------------------------------------------------------------------ */
  /* M5 — mapové typy: klíč → hodnota. UŽ SE EDITUJÍ (dřív jen ke čtení, viz kvHTML).
   *   map         PREFIX_FUNNEL_MAP  prefix → funnel (text)
   *   map_number  FUNNEL_BREAKEVEN   funnel → číslo
   *   json        FUNNEL_OVERRIDES   funnel → { práh: číslo }   (dvouúrovňová)
   * Typy drží server (api.php settings_registry) — my se jen řídíme `it.type`. */
  function isMapType(t) { return t === 'json' || t === 'map' || t === 'map_number'; }
  function isNestedType(t) { return t === 'json'; }

  /* ⚠️ PHP serializuje PRÁZDNÉ pole jako `[]`, ne `{}` → `FUNNEL_BREAKEVEN` přiteče
     ze serveru jako `[]` (ověřeno na reálném settings_get). Bez tohohle se `[]` vykreslilo
     doslova jako „[]" (přesně to Filip viděl) a `Object.keys` by pak sahal na pole. */
  function asMap(v) {
    if (Array.isArray(v) && v.length === 0) return {};
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }

  function curVal(it) { return (it.key in S.edits) ? S.edits[it.key] : it.value; }
  function isDirty(it) {
    if (!(it.key in S.edits)) return false;
    return !same(S.edits[it.key], it.value);
  }
  /* ⚠️ POZOR na objekty: `String({a:1})` === `String({b:2})` === '[object Object]'.
     Dokud tu byl jen String()-fallback, byly DVĚ různé mapy „stejné" → (1) editace mapy
     se nikdy neoznačila jako neuložená a (2) `doSave` vyhodnotil `backToDefault` na true
     a poslal settings_reset MÍSTO settings_save → Filipova výjimka pro funnel se tiše
     zahodila a hodnota se vrátila na default. Proto hloubkové porovnání. */
  function same(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
    var ao = a && typeof a === 'object', bo = b && typeof b === 'object';
    if (ao || bo) {
      if (!ao || !bo) return false;
      var ma = asMap(a), mb = asMap(b);
      var ka = Object.keys(ma).sort(), kb = Object.keys(mb).sort();
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return false;
        if (!same(ma[ka[i]], mb[kb[i]])) return false;
      }
      return true;
    }
    return String(a) === String(b);
  }
  function isDefault(it) {
    if (it.dflt === undefined) return true;
    return same(curVal(it), it.dflt);
  }
  function dirtyKeys() {
    return Object.keys(S.edits).filter(function (k) { return S.byKey[k] && isDirty(S.byKey[k]); });
  }

  /* Zobrazení hodnoty v inputu (pct = ×100) */
  function toInput(it, v) {
    if (v == null) return '';
    if (it.type === 'pct') return fmtNum(Math.round(num(v) * 1000) / 10);
    if (it.type === 'money' || it.type === 'int') return fmtNum(v, 0);
    if (it.type === 'roas' || it.type === 'float') return fmtNum(v);
    return String(v);
  }
  /* Input → uložená hodnota */
  function fromInput(it, s) {
    if (it.type === 'bool') return !!s;
    if (it.type === 'text' || it.type === 'select') return String(s);
    var n = parseNum(s);
    if (n === null || isNaN(n)) return n;   // null = prázdné, NaN = nečitelné
    if (it.type === 'pct') return Math.round(n * 10) / 1000;
    if (it.type === 'int' || it.type === 'money') return Math.round(n);
    return n;
  }
  /* Meze jsou v katalogu v JEDNOTKÁCH INPUTU (pct 0–100) → hodnoty porovnávej stejně */
  function inUnit(it, v) { return it.type === 'pct' ? num(v) * 100 : num(v); }

  /* ------------------------------------------------------------------ *
   * M5 — mapy: řádkový model
   * ------------------------------------------------------------------ *
   * Editujeme POLE DVOJIC [[k,v],…], ne rovnou objekt. Proč: v objektu nejde mít
   * dočasně prázdný ani duplicitní klíč (a přejmenování klíče by řádek přeskládalo
   * → poskočil by fokus). Do `S.edits` (= to, co se posílá) se pole serializuje až
   * když je celé platné; jinak tam necháme rozpracovaný stav a save bar drží chybu.
   */
  /* ⚠️ KOPÍRUJ vnořené objekty, nikdy je neber referencí.
     `curVal()` vrací `it.value` = hodnotu ZE SERVERU. Když se řádek chytne za referenci,
     editace prahu (`o[k]=1800`) přepíše rovnou `it.value` → `same(nové, it.value)` pak
     porovnává objekt sám se sebou, vyjde „stejné" → edit se zahodí, položka se neoznačí
     jako neuložená a NEULOŽÍ SE. (Chyceno 16. 7. na FUNNEL_OVERRIDES: změna prahu
     Náušnice 1500 → 1800 se tvářila, že projde, ale POST na server nikdy neodešel.) */
  function rowsOf(it) {
    if (S.mapRows[it.key]) return S.mapRows[it.key];
    var m = asMap(curVal(it));
    return (S.mapRows[it.key] = Object.keys(m).map(function (k) {
      return [k, isNestedType(it.type) ? Object.assign({}, asMap(m[k])) : m[k]];
    }));
  }
  function rowsToObj(rows) {
    var o = {};
    rows.forEach(function (r) { if (String(r[0]).trim() !== '') o[String(r[0]).trim()] = r[1]; });
    return o;
  }
  /* Řádky → S.edits (nebo úklid, když se rovnají serverové hodnotě). */
  function commitRows(it) {
    var rows = rowsOf(it);
    var obj = rowsToObj(rows);
    S.edits[it.key] = obj;
    if (same(obj, it.value)) delete S.edits[it.key];
  }
  function mapErr(it) {
    var rows = rowsOf(it);
    var seen = {};
    var kl = (it.keyLabel || 'Klíč');
    for (var i = 0; i < rows.length; i++) {
      var k = String(rows[i][0] || '').trim();
      var v = rows[i][1];
      if (k === '') return 'Vyplň „' + kl + '" u ' + (i + 1) + '. řádku (nebo řádek smaž).';
      if (seen[k]) return '„' + k + '" je tam dvakrát — nech jen jeden řádek.';
      seen[k] = 1;
      if (it.type === 'map') {
        if (!String(v || '').trim()) return '„' + k + '": vyber hodnotu.';
      } else if (it.type === 'map_number') {
        var n = num(v, NaN);
        if (v === null || v === '' || isNaN(n)) return '„' + k + '": tohle není číslo. Piš třeba 2,5.';
        if (it.min != null && n < it.min) return '„' + k + '": minimum je ' + fmtNum(it.min) + '.';
        if (it.max != null && n > it.max) return '„' + k + '": maximum je ' + fmtNum(it.max) + '.';
      } else if (isNestedType(it.type)) {
        var ov = asMap(v);
        var oks = Object.keys(ov);
        if (!oks.length) return '„' + k + '": přidej aspoň jeden práh (nebo funnel smaž).';
        for (var j = 0; j < oks.length; j++) {
          var nv = num(ov[oks[j]], NaN);
          if (ov[oks[j]] === null || ov[oks[j]] === '' || isNaN(nv)) return '„' + k + '" → ' + oks[j] + ': tohle není číslo.';
          if (nv < 0) return '„' + k + '" → ' + oks[j] + ': nesmí být záporné.';
        }
      }
    }
    if (rows.length > 64) return 'Maximum je 64 řádků.';
    return '';
  }

  function validateItem(it, v) {
    /* Nečíselné typy se nevalidují jako číslo. Bez téhle větve mapa spadla do číselné
       a napsala Filipovi „Tohle není číslo" u pole, které číslo vůbec nedrží. */
    if (isMapType(it.type)) return S.readonly ? '' : mapErr(it);
    if (it.type === 'bool' || it.type === 'select' || it.type === 'text') return '';
    if (v === null) return 'Vyplň hodnotu.';
    if (isNaN(v)) return 'Tohle není číslo. Piš třeba 2,5 nebo 450.';
    var u = inUnit(it, v);
    if (it.min != null && u < it.min) return 'Minimum je ' + fmtNum(it.min) + (it.unit ? ' ' + it.unit : '') + '.';
    if (it.max != null && u > it.max) return 'Maximum je ' + fmtNum(it.max) + (it.unit ? ' ' + it.unit : '') + '.';
    if ((it.type === 'int' || it.type === 'money') && Math.abs(v - Math.round(v)) > 1e-9) return 'Musí to být celé číslo.';
    return '';
  }
  function itemErr(it) { return validateItem(it, curVal(it)); }

  function crossErrors() {
    var out = [];
    CROSS.forEach(function (c) {
      var have = c.keys.every(function (k) { return S.byKey[k]; });
      if (!have) return;
      var vals = {};
      var bad = false;
      c.keys.forEach(function (k) {
        var v = curVal(S.byKey[k]);
        if (v === null || isNaN(v)) bad = true;
        vals[k] = num(v);
      });
      if (bad) return;                       // dílčí chyba se hlásí u položky
      if (!c.test(vals)) out.push({ keys: c.keys, msg: c.msg });
    });
    return out;
  }
  function dangers() {
    var out = [];
    dirtyKeys().forEach(function (k) {
      var it = S.byKey[k];
      if (!it || !it.dangerFn) return;
      var v = curVal(it);
      if (v === null || isNaN(v)) return;
      var m = it.dangerFn(v);
      if (m) out.push({ key: k, label: it.label, msg: m });
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * RENDER
   * ------------------------------------------------------------------ */
  function render() {
    var root = mount();
    if (!root) return;
    injectStyles();

    if (S.loading && !S.loaded) { root.innerHTML = skeleton(); return; }
    if (S.error) { root.innerHTML = errorBlock(S.error); wireError(root); return; }
    if (!S.loaded) { root.innerHTML = ''; return; }

    var dirty = dirtyKeys();
    var html = '' +
      '<div class="st-wrap">' +
        '<div class="st-head">' +
          '<div class="st-head-txt">' +
            '<h1 class="st-h1">Nastavení</h1>' +
            '<p class="st-lead">Prahy a pravidla, podle kterých dashboard rozhoduje o killu, winnerech a barvách. ' +
              'Změna platí pro všechny a projeví se hned po uložení.</p>' +
          '</div>' +
          '<div class="st-head-act">' +
            '<div class="st-search-wrap">' +
              '<span class="st-search-ico" aria-hidden="true">⌕</span>' +
              '<input id="st-search" class="st-search" type="search" placeholder="Hledat nastavení…" ' +
                'value="' + esc(S.q) + '" autocomplete="off" spellcheck="false">' +
            '</div>' +
            '<button id="st-reload" class="st-btn st-btn-ghost" type="button">Načíst znovu</button>' +
          '</div>' +
        '</div>' +
        (S.readonly ? banner('warn', 'Jen ke čtení', S.readonlyWhy) : '') +
        tabsHTML() +
        impactHTML() +
        '<div class="st-sections">' + S.sections.map(sectionHTML).join('') + '</div>' +
        hiddenHTML() +
      '</div>' +
      saveBarHTML(dirty);

    root.innerHTML = html;
    wire(root);
    applyFilter(root);
  }

  function skeleton() {
    var rows = '';
    for (var i = 0; i < 3; i++) {
      rows += '<div class="st-card st-sk"><div class="st-sk-h"></div><div class="st-sk-r"></div>' +
              '<div class="st-sk-r"></div><div class="st-sk-r"></div></div>';
    }
    return '<div class="st-wrap"><div class="st-head"><div class="st-head-txt">' +
           '<h1 class="st-h1">Nastavení</h1><p class="st-lead">Načítám…</p></div></div>' + rows + '</div>';
  }
  function errorBlock(msg) {
    return '<div class="st-wrap"><div class="st-card st-empty">' +
      '<div class="st-empty-ico">⚠️</div>' +
      '<h2 class="st-empty-h">' + esc(msg) + '</h2>' +
      '<p class="st-empty-p">Zkus to načíst znovu. Když to bude padat dál, je problém na API — ' +
        'nastavení se čte přes <code>?action=settings_get</code>.</p>' +
      '<button id="st-retry" class="st-btn st-btn-primary" type="button">Zkusit znovu</button>' +
      '</div></div>';
  }
  function wireError(root) {
    var b = root.querySelector('#st-retry');
    if (b) b.addEventListener('click', function () { S.error = null; load(); });
  }
  function banner(kind, title, text) {
    if (!text) return '';
    return '<div class="st-banner st-banner-' + kind + '">' +
      '<span class="st-banner-ico" aria-hidden="true">' + (kind === 'warn' ? '⚠️' : 'i') + '</span>' +
      '<div><b>' + esc(title) + '</b> · ' + esc(text) + '</div></div>';
  }
  function hiddenHTML() {
    var ks = Object.keys(hiddenNotes);
    if (!ks.length) return '';
    return '<p class="st-hiddennote">Skryto: ' + ks.map(function (k) {
      return '<code>' + esc(k) + '</code> — ' + esc(hiddenNotes[k]);
    }).join(' · ') + '</p>';
  }

  /* ★ S3 — ŘÁDEK ZÁLOŽEK. Filip: „tys tam toho nastavení dal celkem dost, tak ty
   * nejdůležitější věci jako hraniční ROASy a takový dej jako hlavní a pak tam dej pod
   * záložku třeba jakože pokročilé, a tam dej takový ty fakt jako detailový věci."
   *
   * Počty v záložce = kolik sekcí pod ni spadá; ať je vidět, že v Pokročilých něco JE
   * (jinak to vypadá jako prázdná záložka a nikdo tam neklikne).
   * Aktivní záložka se pamatuje — Filip se do Pokročilých vrací kvůli jedné věci a nechce
   * je hledat pokaždé znovu. */
  function tabCounts() {
    var c = {};
    c[TAB_MAIN] = 0; c[TAB_ADV] = 0;
    S.sections.forEach(function (s) { c[tabOf(s.key)]++; });
    return c;
  }
  function tabsHTML() {
    var c = tabCounts();
    return '<div class="st-tabs" role="tablist">' + TABS.map(function (t) {
      return '<button type="button" class="st-tab' + (S.tab === t.key ? ' is-on' : '') + '" ' +
        'role="tab" aria-selected="' + (S.tab === t.key ? 'true' : 'false') + '" ' +
        'data-st-tab="' + esc(t.key) + '" title="' + esc(t.hint) + '">' +
        esc(t.title) + '<span class="st-tab-n">' + (c[t.key] || 0) + '</span></button>';
    }).join('') + '</div>';
  }

  function sectionHTML(s) {
    // `data-tab` = podle čeho záložky filtrují (applyFilter to čte)
    return '<section class="st-card" data-sec="' + esc(s.key) + '" data-tab="' + esc(tabOf(s.key)) + '">' +
      '<header class="st-card-h">' +
        '<span class="st-card-ico" aria-hidden="true">' + esc(s.ico) + '</span>' +
        '<div class="st-card-hx">' +
          '<h2 class="st-card-t">' + esc(s.title) + '</h2>' +
          (s.desc ? '<p class="st-card-d">' + esc(s.desc) + '</p>' : '') +
        '</div>' +
        /* Holé číslo v rohu sekce se čte jako HODNOTA, ne jako počet. Filip 16. 7.:
           „u tý ziskovosti hranice zisku tam je pět a nejde to upravovat" — myslel přesně
           tenhle badge (Ziskovost má 5 položek), ne žádné nastavení. Proto slovo navíc.
           („nastavení" je v češtině stejné v jednotném i množném čísle → žádné skloňování.) */
        '<span class="st-card-n" title="Počet nastavení v této sekci">' +
          s.items.length + '<span class="st-card-n-u"> nastavení</span></span>' +
      '</header>' +
      // S4: u sekce semaforu jde NAD číselná pole vizuální škála — Filip chce vidět,
      // co ta čísla dělají, ne je odhadovat („hezkej vizuální picker… já si tam posunu ty škály").
      (s.key === 'semafor' ? roasScaleHTML() : '') +
      '<div class="st-items">' + s.items.map(itemHTML).join('') + '</div>' +
    '</section>';
  }

  /* ★ S4 — VIZUÁLNÍ ŠKÁLA ROAS (podmíněné formátování à la Google Sheets).
   *
   * Filip: „v tom ROAS model mi to stejnou barvou zvýrazňuje kreativy, který maj ROAS 30
   * a který maj ROAS 4, dokonce 3. Od tří nahoru to je zelený. To nemůže bejt. Na to bych
   * chtěl udělat nějakej hezký vizuální picker v nastavení. Ne picker barev teda, ale prostě
   * ty jednotlivý barvičky a já si tam posunu ty škály a bude tam volba pro jednotlivý funnely
   * to upravit, ale v základu to bude pro všechny stejný… podobně jak to je v Google tabulkách,
   * když se dělá podmíněné formátování."
   *
   * Barvy jsou DANÉ (červená→zelená), mění se jen ZLOMY — proto „ne picker barev".
   * Zlomy = existující klíče ROAS_ORANGE / ROAS_YELLOW / ROAS_LGREEN / ROAS_GREEN, takže
   * tenhle pruh je jen JINÝ POHLED na tatáž čtyři pole pod ním. Změna v poli → překreslí se
   * pruh; tažení úchytu → přepíše pole. Jeden zdroj pravdy, žádná druhá kopie hodnot.
   */
  var ROAS_STOPS = [
    { key: 'ROAS_ORANGE', color: '#c2603a', label: 'oranžová' },
    { key: 'ROAS_YELLOW', color: '#c9a227', label: 'žlutá' },
    { key: 'ROAS_LGREEN', color: '#7fa88a', label: 'sv. zelená' },
    { key: 'ROAS_GREEN',  color: '#3f8f5f', label: 'zelená' }
  ];
  var ROAS_SCALE_MAX = 12;   // horní konec pruhu; nad ním je stejně všechno „hvězda"

  function roasStopVals() {
    return ROAS_STOPS.map(function (s) {
      var it = S.byKey && S.byKey[s.key];
      var v = it ? Number(curVal(it)) : NaN;
      return isFinite(v) ? v : 0;
    });
  }

  function roasScaleHTML() {
    var v = roasStopVals();
    var pct = function (x) { return Math.max(0, Math.min(100, x / ROAS_SCALE_MAX * 100)); };
    // Pásma: červená do v[0], pak mezi zlomy, poslední zelená do konce.
    var bands = [
      { from: 0,    to: v[0], color: '#b34d4d', label: 'prodělek' },
      { from: v[0], to: v[1], color: '#c2603a', label: '' },
      { from: v[1], to: v[2], color: '#c9a227', label: '' },
      { from: v[2], to: v[3], color: '#7fa88a', label: 'winner' },
      { from: v[3], to: ROAS_SCALE_MAX, color: '#3f8f5f', label: 'hvězda' }
    ];
    var bar = bands.map(function (b) {
      var w = Math.max(0, pct(b.to) - pct(b.from));
      if (w <= 0) return '';
      return '<span class="rs-band" style="left:' + pct(b.from).toFixed(2) + '%;width:' + w.toFixed(2) +
             '%;background:' + b.color + '" title="' + (b.label || '') + '"></span>';
    }).join('');

    var handles = ROAS_STOPS.map(function (s, i) {
      return '<button type="button" class="rs-h" data-stop="' + i + '" ' +
             'style="left:' + pct(v[i]).toFixed(2) + '%;border-color:' + s.color + '" ' +
             'title="' + esc(s.label + ' od ' + fmtNum(v[i]) + '× — táhni nebo přepiš číslo dole') + '">' +
             '<span class="rs-h-v">' + fmtNum(v[i]) + '</span></button>';
    }).join('');

    // Referenční rysky: break-even a winner. Když se škála od nich odchýlí, je to VIDĚT.
    var refs = '';
    var be = S.byKey && S.byKey.FUNNEL_BREAKEVEN_DEFAULT ? Number(curVal(S.byKey.FUNNEL_BREAKEVEN_DEFAULT)) : null;
    var wr = S.byKey && S.byKey.WINNER_ROAS ? Number(curVal(S.byKey.WINNER_ROAS)) : null;
    if (isFinite(be)) refs += '<span class="rs-ref" style="left:' + pct(be).toFixed(2) + '%" title="break-even ' + fmtNum(be) + '× — pod tím je prodělek"><i></i>break-even</span>';
    if (isFinite(wr)) refs += '<span class="rs-ref rs-ref-w" style="left:' + pct(wr).toFixed(2) + '%" title="winner ' + fmtNum(wr) + '×"><i></i>winner</span>';

    return '<div class="rs-wrap" data-rs="1">' +
      '<div class="rs-head">Barevná škála ROAS — <b>posuň úchyty</b> nebo přepiš čísla dole. ' +
      'Ukázka: <span class="rs-ex" style="background:#b34d4d">1×</span>' +
      '<span class="rs-ex" style="background:#c9a227">' + fmtNum(v[1]) + '×</span>' +
      '<span class="rs-ex" style="background:#3f8f5f">' + fmtNum(ROAS_SCALE_MAX) + '×</span></div>' +
      '<div class="rs-bar">' + bar + refs + handles + '</div>' +
      '<div class="rs-axis"><span>0×</span><span>' + fmtNum(ROAS_SCALE_MAX / 2) + '×</span><span>' + fmtNum(ROAS_SCALE_MAX) + '×+</span></div>' +
    '</div>';
  }

  function impactPill(it) {
    if (!it.impact) return '';
    var map = {
      kill: ['mění kill', 'Po uložení se přepočítá, kolik kreativ je kill kandidátů.'],
      winners: ['mění winners', 'Po uložení se přepočítá, kolik kreativ je winnerů.'],
      both: ['mění kill i winners', 'Po uložení se přepočítají kill kandidáti i winneři.'],
      colors: ['jen barvy', 'Ovlivní jen obarvení čísel, ne to, co se killuje.']
    };
    var m = map[it.impact];
    if (!m) return '';
    var cls = it.impact === 'colors' ? 'st-pill-soft' : 'st-pill-impact';
    return '<span class="st-pill ' + cls + '" title="' + esc(m[1]) + '">' + esc(m[0]) + '</span>';
  }

  /* Mapa / JSON JEN KE ČTENÍ — používá se už jen ve fallback režimu (?action=config),
     kde se ukládat NEDÁ. Editor je kvHTML() níž. */
  function mapHTML(it, v) {
    var m = asMap(v);
    var ks = Object.keys(m);
    var rows = ks.map(function (k) {
      var val = m[k];
      var txt = (val && typeof val === 'object')
        ? Object.keys(asMap(val)).map(function (x) { return thLabel(x) + ': ' + asMap(val)[x]; }).join(' · ')
        : String(val);
      return '<div class="st-map-r"><code class="st-map-k">' + esc(k) + '</code>' +
             '<span class="st-map-a" aria-hidden="true">→</span>' +
             '<span class="st-map-v">' + esc(txt) + '</span></div>';
    }).join('');
    var head = (it.keyLabel || it.valueLabel)
      ? '<div class="st-map-h"><span>' + esc(it.keyLabel || '') + '</span><span>' + esc(it.valueLabel || '') + '</span></div>'
      : '';
    return '<div class="st-map">' + head +
      (ks.length ? rows : '<div class="st-map-empty">' + esc(emptyNote(it)) + '</div>') +
      '<div class="st-map-note">jen ke čtení — ukládání není napojené</div></div>';
  }

  /* Co znamená PRÁZDNÁ mapa. Filip musí vidět, že prázdno != rozbité. */
  function emptyNote(it) {
    if (it.key === 'FUNNEL_BREAKEVEN') {
      var d = S.byKey.FUNNEL_BREAKEVEN_DEFAULT;
      var dv = d ? fmtNum(curVal(d)) : '2';
      return 'Žádná výjimka → platí plošně ' + dv + '× pro všechny funnely i náušnice.';
    }
    if (it.key === 'FUNNEL_OVERRIDES') return 'Žádné nuance → všude platí globální prahy.';
    if (it.key === 'PREFIX_FUNNEL_MAP') return 'Prázdné → funnel se z prefixu nedopočítává (kreativy bez leadu zůstanou v `---`).';
    return 'Prázdné → platí plošný default.';
  }

  /* Výběr funnelu. `used` = klíče, co už v mapě jsou (ať je nejde přidat dvakrát),
     kromě toho vlastního. `extra` = hodnota, kterou server zná, ale v known_funnels
     není (např. „Náušnice“ v FUNNEL_OVERRIDES) → ať ji editor nezahodí. */
  function funnelSelect(cls, attrs, val, used) {
    var list = S.funnels.slice();
    if (val && list.indexOf(val) < 0) list.push(val);      // neznámou hodnotu neztrácej
    var opts = list.filter(function (f) { return f === val || !used || !used[f]; })
      .map(function (f) {
        return '<option value="' + esc(f) + '"' + (f === val ? ' selected' : '') + '>' + esc(f) + '</option>';
      }).join('');
    return '<div class="st-selwrap st-kv-sel"><select class="' + cls + '" ' + attrs + '>' +
           (val ? '' : '<option value="" selected>— vyber —</option>') + opts + '</select></div>';
  }

  /* ------------------------------------------------------------------ *
   * M5 — KV EDITOR (mapa klíč → hodnota)
   * ------------------------------------------------------------------ *
   * Filip 16. 7. (odpověď 1): „break-even + zvážit rozdělení snubní/zásnubní" → tohle
   * je přesně ten knoflík. Dřív se vykreslilo „[]" a „jen pro čtení · mění se v configu".
   *
   * Řádek = klíč + hodnota + [×]. Klíč: u FUNNEL_BREAKEVEN/FUNNEL_OVERRIDES = VÝBĚR
   * funnelu (psát ho ručně = překlep = tichý override, který nikdy nesedne), u
   * PREFIX_FUNNEL_MAP = volný text (prefix, server žádný číselník nemá).
   * `data-ri` = index řádku, ne klíč → přejmenování klíče nerozbije fokus (viz renderSoft).
   */
  function kvHTML(it) {
    var rows = rowsOf(it);
    var nested = isNestedType(it.type);
    var used = {};
    rows.forEach(function (r) { used[String(r[0])] = 1; });

    var head = '<div class="st-kv-h"><span>' + esc(it.keyLabel || (nested ? 'Funnel' : 'Klíč')) + '</span>' +
               '<span>' + esc(it.valueLabel || (nested ? 'Nuance prahů' : 'Hodnota')) + '</span></div>';

    var body = rows.map(function (r, i) {
      var k = r[0], v = r[1];
      var keyCtl;
      if (it.type === 'map') {
        keyCtl = '<input class="st-input st-kv-k" type="text" data-k="' + esc(it.key) + '" data-ri="' + i +
                 '" data-role="k" value="' + esc(k) + '" autocomplete="off" spellcheck="false" ' +
                 'placeholder="' + esc(it.keyLabel || 'klíč') + '" aria-label="' + esc(it.keyLabel || 'klíč') + '">';
      } else {
        keyCtl = funnelSelect('st-sel st-kv-k', 'data-k="' + esc(it.key) + '" data-ri="' + i +
                              '" data-role="k" aria-label="Funnel"', k, used);
      }

      var valCtl;
      if (it.type === 'map_number') {
        valCtl = '<div class="st-field st-kv-num">' +
          '<input class="st-input st-input-num st-kv-v" type="text" inputmode="decimal" ' +
            'data-k="' + esc(it.key) + '" data-ri="' + i + '" data-role="v" ' +
            'value="' + esc(fmtNum(v)) + '" autocomplete="off" spellcheck="false" aria-label="Hodnota">' +
          (it.unit ? '<span class="st-unit">' + esc(it.unit) + '</span>' : '') + '</div>';
      } else if (it.type === 'map') {
        valCtl = funnelSelect('st-sel st-kv-v', 'data-k="' + esc(it.key) + '" data-ri="' + i +
                              '" data-role="v" aria-label="Funnel"', v, null);
      } else {
        valCtl = nestedHTML(it, i, asMap(v));
      }

      return '<div class="st-kv-r' + (nested ? ' is-nested' : '') + '" data-ri="' + i + '">' +
        '<div class="st-kv-c">' + keyCtl + '</div>' +
        '<div class="st-kv-c">' + valCtl + '</div>' +
        '<button class="st-kv-x" type="button" data-kv-del="' + esc(it.key) + '" data-ri="' + i +
        '" title="Smazat řádek" aria-label="Smazat řádek">×</button>' +
      '</div>';
    }).join('');

    var addLbl = it.type === 'map' ? 'přidat prefix' : 'přidat funnel';
    return '<div class="st-kv">' + head +
      (rows.length ? body : '<div class="st-kv-empty">' + esc(emptyNote(it)) + '</div>') +
      '<div class="st-kv-foot">' +
        '<button class="st-kv-add" type="button" data-kv-add="' + esc(it.key) + '">+ ' + addLbl + '</button>' +
      '</div>' +
    '</div>';
  }

  /* FUNNEL_OVERRIDES: druhá úroveň — práh → číslo. */
  function nestedHTML(it, ri, ov) {
    var keys = Object.keys(ov);
    var usedTh = {};
    keys.forEach(function (k) { usedTh[k] = 1; });
    var rows = keys.map(function (tk) {
      var opts = overrideKeys().filter(function (o) { return o === tk || !usedTh[o]; })
        .map(function (o) {
          return '<option value="' + esc(o) + '"' + (o === tk ? ' selected' : '') + '>' + esc(thLabel(o)) + '</option>';
        }).join('');
      return '<div class="st-kv-n">' +
        '<div class="st-selwrap st-kv-sel"><select class="st-sel st-kv-tk" data-k="' + esc(it.key) +
          '" data-ri="' + ri + '" data-tk="' + esc(tk) + '" data-role="tk" aria-label="Práh">' + opts + '</select></div>' +
        '<div class="st-field st-kv-num"><input class="st-input st-input-num st-kv-tv" type="text" inputmode="decimal" ' +
          'data-k="' + esc(it.key) + '" data-ri="' + ri + '" data-tk="' + esc(tk) + '" data-role="tv" ' +
          'value="' + esc(fmtNum(ov[tk])) + '" autocomplete="off" aria-label="Hodnota prahu"></div>' +
        '<button class="st-kv-x st-kv-x-sm" type="button" data-kv-tdel="' + esc(it.key) + '" data-ri="' + ri +
          '" data-tk="' + esc(tk) + '" title="Smazat práh" aria-label="Smazat práh">×</button>' +
      '</div>';
    }).join('');
    var canAdd = keys.length < overrideKeys().length;
    return '<div class="st-kv-nest">' + rows +
      (canAdd ? '<button class="st-kv-add st-kv-add-sm" type="button" data-kv-tadd="' + esc(it.key) +
                '" data-ri="' + ri + '">+ přidat práh</button>' : '') +
    '</div>';
  }

  function itemHTML(it) {
    var v = curVal(it);
    var dirty = isDirty(it);
    var err = itemErr(it);
    var hay = (it.label + ' ' + it.key + ' ' + it.desc).toLowerCase();

    var ctl;
    if (isMapType(it.type)) {
      /* M5: mapa/JSON dřív než readonly větev — jinak by i tady vypadl „[object Object]".
         Editor jen když se DÁ ukládat; ve fallbacku z ?action=config zůstává výpis. */
      ctl = (S.readonly || it.readonly) ? mapHTML(it, v) : kvHTML(it);
    } else if (it.readonly || S.readonly) {
      ctl = '<div class="st-ro">' + esc(toInput(it, v) || String(v == null ? '—' : v)) +
            (it.unit ? ' <span class="st-unit-ro">' + esc(it.unit) + '</span>' : '') + '</div>';
    } else if (it.type === 'bool') {
      ctl = '<button class="st-toggle' + (v ? ' is-on' : '') + '" type="button" role="switch" ' +
            'aria-checked="' + (v ? 'true' : 'false') + '" data-k="' + esc(it.key) + '">' +
            '<span class="st-toggle-dot"></span></button>';
    } else if (it.type === 'select' && it.options) {
      ctl = '<div class="st-selwrap"><select class="st-sel" data-k="' + esc(it.key) + '">' +
        (it.options || []).map(function (o) {
          var val = (o && o.value !== undefined) ? o.value : o;
          var lab = (o && o.label !== undefined) ? o.label : o;
          return '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(lab) + '</option>';
        }).join('') + '</select></div>';
    } else if (it.type === 'text') {
      ctl = '<div class="st-field"><input class="st-input" type="text" data-k="' + esc(it.key) + '" ' +
            'value="' + esc(v == null ? '' : v) + '" autocomplete="off" spellcheck="false"></div>';
    } else {
      /* Číslo: type=text + inputmode → „2,5" s ČÁRKOU projde (number input by ji zahodil). */
      ctl = '<div class="st-field' + (err ? ' has-err' : '') + '">' +
        '<input class="st-input st-input-num" type="text" inputmode="decimal" data-k="' + esc(it.key) + '" ' +
          'value="' + esc(toInput(it, v)) + '" autocomplete="off" spellcheck="false" ' +
          'aria-label="' + esc(it.label) + '">' +
        (it.unit ? '<span class="st-unit">' + esc(it.unit) + '</span>' : '') +
        '<span class="st-step">' +
          '<button class="st-step-b" type="button" data-step="up" data-k="' + esc(it.key) + '" tabindex="-1" aria-label="Zvýšit">▴</button>' +
          '<button class="st-step-b" type="button" data-step="down" data-k="' + esc(it.key) + '" tabindex="-1" aria-label="Snížit">▾</button>' +
        '</span>' +
      '</div>';
    }

    /* M5: mapy „vrátit default" MAJÍ (isDefault() umí od 16. 7. i objekty — viz same()). */
    var showReset = !S.readonly && !it.readonly &&
                    it.dflt !== undefined && !isDefault(it);
    var deriveTxt = it.derive ? it.derive(v, S.ctx) : '';

    /* M5: mapy se do 210px sloupce ovládání nevejdou (select + číslo + koš) → celá
       položka se přepne na sloupcový layout a editor jede přes celou šířku karty. */
    var kvCls = (isMapType(it.type) && !S.readonly && !it.readonly) ? ' st-item--kv' : '';

    return '<div class="st-item' + (dirty ? ' is-dirty' : '') + (err ? ' has-err' : '') + kvCls +
      '" data-key="' + esc(it.key) + '" data-hay="' + esc(hay) + '">' +
      '<div class="st-item-main">' +
        '<div class="st-item-top">' +
          '<span class="st-label">' + esc(it.label) + '</span>' +
          '<code class="st-const" title="Název konstanty v configu">' + esc(it.key) + '</code>' +
          impactPill(it) +
          /* server: overridden = hodnota je z DB, ne z configu → ať je vidět, že do
             toho někdo sáhl (a kdo). Bez toho se nepozná ručně nastavený práh. */
          (it.overridden && !dirty
            ? '<span class="st-pill st-pill-over" title="' +
              esc('Uloženo v DB (přebíjí config.php)' + (it.who ? ' · ' + it.who : '') +
                  (it.updated_at ? ' · ' + fmtWhen(it.updated_at) : '')) + '">upraveno</span>'
            : '') +
          (dirty ? '<span class="st-pill st-pill-dirty">neuloženo</span>' : '') +
        '</div>' +
        (it.desc ? '<p class="st-desc">' + esc(it.desc) + '</p>' : '') +
        '<p class="st-derive"' + (deriveTxt ? '' : ' hidden') + '>' + esc(deriveTxt) + '</p>' +
        '<p class="st-err"' + (err ? '' : ' hidden') + '>' + esc(err) + '</p>' +
      '</div>' +
      '<div class="st-item-ctl">' +
        ctl +
        '<div class="st-dflt">' +
          /* U map/JSON „výchozí" NEPÍŠEME: String({}) = „[object Object]" a Filip by četl
             „výchozí [object Object] × ROAS". Prázdnou mapu už popisuje sama karta. */
          (it.dflt !== undefined && !isMapType(it.type)
            ? '<span class="st-dflt-txt">výchozí ' + esc(toInput(it, it.dflt) || String(it.dflt)) +
              (it.unit ? ' ' + esc(it.unit) : '') + '</span>'
            : '') +
          (showReset ? '<button class="st-reset" type="button" data-reset="' + esc(it.key) + '">' +
            '<span aria-hidden="true">↺</span> vrátit default</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function saveBarHTML(dirty) {
    if (S.readonly || !dirty.length) return '';
    var errs = dirty.filter(function (k) { return itemErr(S.byKey[k]); }).length;
    var cross = crossErrors();
    var blocked = errs > 0 || cross.length > 0;
    var names = dirty.slice(0, 3).map(function (k) { return S.byKey[k].label; }).join(', ') +
                (dirty.length > 3 ? ' + ' + (dirty.length - 3) + ' další' : '');
    return '<div class="st-savebar' + (blocked ? ' is-blocked' : '') + '">' +
      '<div class="st-savebar-in">' +
        '<span class="st-savebar-dot" aria-hidden="true"></span>' +
        '<div class="st-savebar-txt">' +
          '<b>' + dirty.length + ' ' + plural(dirty.length, 'neuložená změna', 'neuložené změny', 'neuložených změn') + '</b>' +
          '<span class="st-savebar-names">' + esc(names) + '</span>' +
        '</div>' +
        (cross.length ? '<span class="st-savebar-err">' + esc(cross[0].msg) + '</span>' :
          (errs ? '<span class="st-savebar-err">Oprav ' + errs + ' chybnou hodnotu.</span>' : '')) +
        '<button id="st-discard" class="st-btn st-btn-ghost" type="button">Zahodit</button>' +
        '<button id="st-save" class="st-btn st-btn-primary"' + (blocked || S.saving ? ' disabled' : '') + ' type="button">' +
          (S.saving ? 'Ukládám…' : 'Uložit změny') + '</button>' +
      '</div>' +
    '</div>';
  }
  function plural(n, a, b, c) { return n === 1 ? a : (n >= 2 && n <= 4 ? b : c); }

  function impactHTML() {
    var im = S.lastImpact;
    if (!im) return '';
    var rows = im.rows.map(function (r) {
      var d = r.after - r.before;
      var cls = d === 0 ? '' : (r.good === 'up' ? (d > 0 ? 'up' : 'down') : (d > 0 ? 'down' : 'up'));
      return '<div class="st-imp-row">' +
        '<span class="st-imp-l">' + esc(r.label) + '</span>' +
        '<span class="st-imp-v">' + r.before + '</span>' +
        '<span class="st-imp-a" aria-hidden="true">→</span>' +
        '<span class="st-imp-v is-new ' + cls + '">' + r.after + '</span>' +
        (d !== 0 ? '<span class="st-imp-d ' + cls + '">' + (d > 0 ? '+' : '') + d + '</span>'
                 : '<span class="st-imp-d">beze změny</span>') +
      '</div>';
    }).join('');
    return '<div class="st-impact">' +
      '<div class="st-impact-h">' +
        '<span class="st-impact-ico" aria-hidden="true">📐</span>' +
        '<div><b>Dopad změny</b><span class="st-impact-sub">' + esc(im.note) + '</span></div>' +
        (im.prev ? '<button id="st-undo" class="st-btn st-btn-ghost st-btn-sm" type="button">Vrátit zpět</button>' : '') +
        '<button id="st-impact-x" class="st-impact-x" type="button" aria-label="Zavřít">✕</button>' +
      '</div>' +
      '<div class="st-imp-rows">' + rows + '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Interakce
   * ------------------------------------------------------------------ */
  function setVal(key, v) {
    var it = S.byKey[key];
    if (!it) return;
    S.edits[key] = v;
    if (same(v, it.value)) delete S.edits[key];
    renderSoft(key);
  }

  /* Překreslí jen tuhle položku + save bar → input neztratí fokus ani kurzor.
   *
   * M5: kv editor má polí VÍC (klíč, hodnota, prahy), takže „vezmi první .st-input"
   * nestačí — po překreslení by fokus skočil na první řádek mapy. Aktivní pole se
   * proto najde podle data-ri/data-role/data-tk (index řádku, ne klíče → přejmenování
   * funnelu fokus neshodí). */
  function focusSig(el) {
    if (!el || !el.getAttribute) return null;
    return { ri: el.getAttribute('data-ri'), role: el.getAttribute('data-role'),
             tk: el.getAttribute('data-tk'), cls: el.className };
  }
  function findBySig(scope, sig) {
    if (!sig) return scope.querySelector('.st-input');
    var sel = '[data-ri="' + cssEsc(sig.ri) + '"]';
    if (sig.role) sel += '[data-role="' + cssEsc(sig.role) + '"]';
    if (sig.tk) sel += '[data-tk="' + cssEsc(sig.tk) + '"]';
    return scope.querySelector(sel);
  }
  /* S4 — překresli pruh škály. Volá se při KAŽDÉ změně zlomu (z pole i z tažení),
   * jinak by pruh a čísla pod ním ukazovaly každý něco jiného. Vlastní funkce (ne
   * součást renderSoft) proto, že pruh žije MIMO .st-item — je nad celou sekcí. */
  function redrawRoasScale() {
    var root = mount();
    if (!root) return;
    var w = root.querySelector('[data-rs="1"]');
    if (!w) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = roasScaleHTML();
    w.parentNode.replaceChild(tmp.firstChild, w);
    wireRoasScale(root);           // nový element = nové posluchače
  }

  function renderSoft(key) {
    var root = mount();
    if (!root) return;
    // Zlom škály se změnil → pruh musí jít s ním.
    for (var z = 0; z < ROAS_STOPS.length; z++) {
      if (ROAS_STOPS[z].key === key) { redrawRoasScale(); break; }
    }
    var it = S.byKey[key];
    var node = root.querySelector('.st-item[data-key="' + cssEsc(key) + '"]');
    if (it && node) {
      var act = document.activeElement;
      var focused = act && node.contains(act) && /st-input|st-sel/.test(act.className || '');
      var sig = focused ? focusSig(act) : null;
      var caret = (focused && act.selectionStart != null) ? act.selectionStart : null;
      var raw = focused ? act.value : null;
      var isSel = focused && act.tagName === 'SELECT';

      var tmp = document.createElement('div');
      tmp.innerHTML = itemHTML(it);
      var fresh = tmp.firstChild;
      node.parentNode.replaceChild(fresh, node);

      if (focused) {
        var ni = (sig && sig.ri != null) ? findBySig(fresh, sig) : fresh.querySelector('.st-input');
        if (ni) {
          /* Neber uživateli rozepsanou hodnotu („2," během psaní). U <select> se
             value nepřepisuje — tam je pravda v modelu, ne v rozepsaném textu. */
          if (raw != null && !isSel && ni.value !== raw) ni.value = raw;
          ni.focus();
          if (caret != null) { try { ni.setSelectionRange(caret, caret); } catch (_) {} }
        }
      }
    }
    /* Cross-check chyby se týkají i jiných položek → přemaluj jejich stav */
    paintCross(root);
    /* Save bar */
    var old = root.parentNode ? root.parentNode.querySelector('.st-savebar') : null;
    var bar = root.querySelector('.st-savebar') || old;
    var html = saveBarHTML(dirtyKeys());
    if (bar) bar.outerHTML = html || '';
    else if (html) root.insertAdjacentHTML('beforeend', html);
    wireSaveBar(root);
  }
  function cssEsc(s) { return String(s).replace(/"/g, '\\"'); }

  function paintCross(root) {
    var errs = crossErrors();
    var flagged = {};
    errs.forEach(function (e) { e.keys.forEach(function (k) { flagged[k] = e.msg; }); });
    [].forEach.call(root.querySelectorAll('.st-item'), function (n) {
      var k = n.getAttribute('data-key');
      var p = n.querySelector('.st-err');
      var own = S.byKey[k] ? itemErr(S.byKey[k]) : '';
      var msg = own || (flagged[k] && isTouched(k, flagged) ? flagged[k] : '');
      if (!p) return;
      if (msg) { p.textContent = msg; p.hidden = false; n.classList.add('has-err'); }
      else { p.hidden = true; n.classList.remove('has-err'); }
    });
  }
  /* Cross chybu ukaž jen tam, kde se opravdu něco mění (ať nesvítí celá sekce po loadu) */
  function isTouched(k, flagged) {
    var d = dirtyKeys();
    if (d.indexOf(k) > -1) return true;
    for (var i = 0; i < d.length; i++) if (flagged[d[i]] !== undefined) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * M5 — mutace kv editoru
   * ------------------------------------------------------------------ */
  /* Nový řádek se rovnou předvyplní PLATNOU hodnotou (první nepoužitý funnel +
     rozumný default). Prázdný řádek by hned svítil chybou „vyplň funnel" — Filip klikl
     na „přidat" a dostal by červenou. */
  function firstFreeFunnel(rows) {
    var used = {};
    rows.forEach(function (r) { used[String(r[0])] = 1; });
    for (var i = 0; i < S.funnels.length; i++) if (!used[S.funnels[i]]) return S.funnels[i];
    return '';
  }
  function kvAddRow(it) {
    if (!it) return;
    var rows = rowsOf(it);
    if (it.type === 'map') {
      rows.push(['', S.funnels[0] || '']);
    } else if (it.type === 'map_number') {
      var d = S.byKey.FUNNEL_BREAKEVEN_DEFAULT;
      var dv = d ? num(curVal(d), 2) : 2;
      var f = firstFreeFunnel(rows);
      if (!f) { toast('Všechny funnely už výjimku mají.', 'info'); return; }
      rows.push([f, dv]);
    } else {
      var fn = firstFreeFunnel(rows);
      if (!fn) { toast('Všechny funnely už nuanci mají.', 'info'); return; }
      var tk = overrideKeys()[0];
      var glob = S.byKey[tk] || S.byKey[tk + '_DEFAULT'];
      var one = {};
      one[tk] = glob ? num(curVal(glob), 0) : 0;
      rows.push([fn, one]);
    }
    commitRows(it);
    renderSoft(it.key);
  }
  function kvDelRow(it, ri) {
    if (!it) return;
    var rows = rowsOf(it);
    if (ri < 0 || ri >= rows.length) return;
    rows.splice(ri, 1);
    commitRows(it);
    renderSoft(it.key);
  }
  function kvAddTh(it, ri) {
    if (!it) return;
    var rows = rowsOf(it);
    if (!rows[ri]) return;
    var ov = asMap(rows[ri][1]);
    var free = overrideKeys().filter(function (k) { return !(k in ov); })[0];
    if (!free) return;
    var glob = S.byKey[free] || S.byKey[free + '_DEFAULT'];
    ov[free] = glob ? num(curVal(glob), 0) : 0;
    rows[ri][1] = ov;
    commitRows(it);
    renderSoft(it.key);
  }
  function kvDelTh(it, ri, tk) {
    if (!it) return;
    var rows = rowsOf(it);
    if (!rows[ri]) return;
    var ov = asMap(rows[ri][1]);
    delete ov[tk];
    rows[ri][1] = ov;
    commitRows(it);
    renderSoft(it.key);
  }
  /* Změna políčka v kv editoru. `data-role`: k = klíč · v = hodnota ·
     tk = který práh (nested) · tv = hodnota prahu (nested). */
  function kvInput(it, t) {
    var rows = rowsOf(it);
    var ri = +t.getAttribute('data-ri');
    var role = t.getAttribute('data-role');
    if (!rows[ri]) return;

    if (role === 'k') {
      rows[ri][0] = t.value;
    } else if (role === 'v') {
      /* map_number drží ROZEPSANÝ text (např. „2," uprostřed psaní). Parsuje se až
         ve validaci/serializaci — jinak by „2," spadlo na NaN a přepsalo input. */
      rows[ri][1] = (it.type === 'map_number') ? parseNum(t.value) : t.value;
    } else if (role === 'tk') {
      var old = t.getAttribute('data-tk');
      var ov = asMap(rows[ri][1]);
      if (t.value !== old) {
        var nv = {};   // zachovej pořadí prahů → nepřeskakuje fokus
        Object.keys(ov).forEach(function (k) {
          if (k === old) nv[t.value] = ov[old]; else nv[k] = ov[k];
        });
        rows[ri][1] = nv;
      }
    } else if (role === 'tv') {
      var o2 = asMap(rows[ri][1]);
      o2[t.getAttribute('data-tk')] = parseNum(t.value);
      rows[ri][1] = o2;
    }
    commitRows(it);
    renderSoft(it.key);
  }

  function stepItem(key, dir) {
    var it = S.byKey[key];
    if (!it) return;
    var v = curVal(it);
    var stepU = num(it.step, 1);
    var cur = inUnit(it, (v === null || isNaN(v)) ? num(it.dflt, 0) : v);
    var next = Math.round((cur + dir * stepU) * 1000) / 1000;
    if (it.min != null) next = Math.max(it.min, next);
    if (it.max != null) next = Math.min(it.max, next);
    setVal(key, it.type === 'pct' ? Math.round(next * 10) / 1000 : next);
  }

  /* S4 — tažení úchytů škály. Mění TÁTEŽ pole jako číselné vstupy pod pruhem
   * (přes setVal), takže tu nevzniká druhý zdroj pravdy — jen jiný způsob zadání.
   *
   * Zlomy MUSÍ zůstat vzestupné (oranžová ≤ žlutá ≤ sv.zelená ≤ zelená): server to
   * stejně validuje (settings_cross_check) a odmítl by uložení, takže je čistší
   * nepustit uživatele do nemožného stavu, než mu pak hodit chybu.
   */
  function wireRoasScale(root) {
    var bar = root.querySelector('.rs-bar');
    if (!bar) return;
    var drag = null;

    var valueAt = function (clientX) {
      var r = bar.getBoundingClientRect();
      var p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      // krok 0,1 — stejný jako `step` u číselných polí, ať se to nerozejde
      return Math.round(p * ROAS_SCALE_MAX * 10) / 10;
    };

    bar.addEventListener('mousedown', function (e) {
      var h = e.target.closest && e.target.closest('.rs-h');
      if (!h) return;
      drag = { i: parseInt(h.dataset.stop, 10) };
      document.body.classList.add('rs-dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var vals = roasStopVals();
      var v = valueAt(e.clientX);
      // mantinely: mezi sousedy (0,1 rezerva), ať pořadí drží
      var lo = drag.i > 0 ? vals[drag.i - 1] + 0.1 : 0;
      var hi = drag.i < ROAS_STOPS.length - 1 ? vals[drag.i + 1] - 0.1 : ROAS_SCALE_MAX;
      v = Math.max(lo, Math.min(hi, v));
      setVal(ROAS_STOPS[drag.i].key, v);       // → renderSoft překreslí i pruh
    });

    window.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('rs-dragging');
    });
  }

  function wire(root) {
    wireRoasScale(root);

    // S3 — přepnutí záložky. Nepřekresluje celou stránku (ztratil by se rozepsaný input),
    // jen přepne stav a nechá applyFilter() poschovávat sekce.
    var tabs = root.querySelector('.st-tabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-st-tab]');
      if (!b || b.dataset.stTab === S.tab) return;
      S.tab = b.dataset.stTab;
      try { localStorage.setItem('ads.settings.tab', S.tab); } catch (_) {}
      [].forEach.call(tabs.querySelectorAll('.st-tab'), function (x) {
        var on = x.dataset.stTab === S.tab;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      applyFilter(root);
    });
    var s = root.querySelector('#st-search');
    if (s) {
      s.addEventListener('input', function () { S.q = s.value || ''; applyFilter(root); });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { s.value = ''; S.q = ''; applyFilter(root); }
      });
    }
    var r = root.querySelector('#st-reload');
    if (r) r.addEventListener('click', function () {
      if (dirtyKeys().length && !confirm('Máš neuložené změny. Načíst znovu a zahodit je?')) return;
      S.loaded = false; S.edits = {}; load();
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('st-input')) return;
      var k = t.getAttribute('data-k');
      var it = S.byKey[k];
      if (!it) return;
      if (isMapType(it.type)) { kvInput(it, t); return; }   // M5
      setVal(k, fromInput(it, t.value));
    });
    root.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('st-input-num')) return;
      var k = t.getAttribute('data-k');
      if (e.key === 'ArrowUp') { e.preventDefault(); stepItem(k, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepItem(k, -1); }
    });
    root.addEventListener('click', function (e) {
      var q = function (sel) { return e.target.closest ? e.target.closest(sel) : null; };

      /* ---- M5: kv editor ---- */
      var add = q('[data-kv-add]');
      if (add) { kvAddRow(S.byKey[add.getAttribute('data-kv-add')]); return; }
      var del = q('[data-kv-del]');
      if (del) { kvDelRow(S.byKey[del.getAttribute('data-kv-del')], +del.getAttribute('data-ri')); return; }
      var tadd = q('[data-kv-tadd]');
      if (tadd) { kvAddTh(S.byKey[tadd.getAttribute('data-kv-tadd')], +tadd.getAttribute('data-ri')); return; }
      var tdel = q('[data-kv-tdel]');
      if (tdel) {
        kvDelTh(S.byKey[tdel.getAttribute('data-kv-tdel')], +tdel.getAttribute('data-ri'),
                tdel.getAttribute('data-tk'));
        return;
      }

      var b = q('[data-step]');
      if (b) { stepItem(b.getAttribute('data-k'), b.getAttribute('data-step') === 'up' ? 1 : -1); return; }

      var rs = q('[data-reset]');
      if (rs) {
        var key = rs.getAttribute('data-reset');
        var it = S.byKey[key];
        if (it) {
          /* M5: u mapy musí padnout i řádkový model, jinak by se editor překreslil
             ze starých řádků a „vrátit default" by vypadalo, že nic neudělalo. */
          if (isMapType(it.type)) delete S.mapRows[key];
          setVal(key, it.dflt);
          toast('„' + it.label + '" vráceno na výchozí hodnotu (neuloženo)', 'info');
        }
        return;
      }
      var tg = e.target.closest ? e.target.closest('.st-toggle') : null;
      if (tg) { var tk = tg.getAttribute('data-k'); setVal(tk, !curVal(S.byKey[tk])); return; }

      var ix = e.target.closest ? e.target.closest('#st-impact-x') : null;
      if (ix) { S.lastImpact = null; render(); return; }
      var un = e.target.closest ? e.target.closest('#st-undo') : null;
      if (un) { undoImpact(); return; }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('st-sel')) return;
      var it = S.byKey[t.getAttribute('data-k')];
      if (!it) return;
      if (isMapType(it.type)) { kvInput(it, t); return; }   // M5
      setVal(it.key, t.value);
    });
    wireSaveBar(root);
  }

  function wireSaveBar(root) {
    var sv = root.querySelector('#st-save');
    if (sv) sv.addEventListener('click', save);
    var ds = root.querySelector('#st-discard');
    if (ds) ds.addEventListener('click', function () { S.edits = {}; render(); toast('Změny zahozeny', 'info'); });
  }

  function applyFilter(root) {
    var q = (S.q || '').trim().toLowerCase();
    var anyVisible = false;
    [].forEach.call(root.querySelectorAll('.st-card[data-sec]'), function (card) {
      /* S3: sekce z NEAKTIVNÍ záložky se schová úplně. ⚠️ Když se ale hledá, záložky se
         IGNORUJÍ — Filip napíše „winner" a čeká výsledek, ne otázku, ve které je záložce.
         Tichý filtr přes hledání = „to tam není" a on by to nahlásil jako bug. */
      if (!q && card.getAttribute('data-tab') && card.getAttribute('data-tab') !== S.tab) {
        card.hidden = true;
        return;
      }
      var shown = 0;
      [].forEach.call(card.querySelectorAll('.st-item'), function (n) {
        var hit = !q || (n.getAttribute('data-hay') || '').indexOf(q) > -1;
        n.hidden = !hit;
        if (hit) shown++;
      });
      card.hidden = !shown;
      if (shown) anyVisible = true;
      /* Badge s počtem. ⚠️ `textContent = shown` by SMAZALO slovo „nastavení" (vnořený span)
       * a zbylo by holé číslo — přesně to, co Filip 16. 7. přečetl jako hodnotu:
       * „u tý ziskovosti hranice zisku tam je pět a nejde to upravovat". Ta „pětka" byl
       * tenhle badge (Ziskovost má 5 položek), ne nastavení. Proto se přepisuje JEN číslo. */
      var n = card.querySelector('.st-card-n');
      if (n) {
        var nu = n.querySelector('.st-card-n-u');
        n.textContent = shown;
        if (nu) n.appendChild(nu);
      }
    });
    var none = root.querySelector('#st-nores');
    if (!anyVisible && q) {
      if (!none) {
        var d = document.createElement('div');
        d.id = 'st-nores';
        d.className = 'st-card st-empty';
        d.innerHTML = '<div class="st-empty-ico">⌕</div><h2 class="st-empty-h">Nic takového tu není</h2>' +
          '<p class="st-empty-p">Zkus jiné slovo — hledá se v názvu, popisu i v názvu konstanty.</p>';
        var secs = root.querySelector('.st-sections');
        if (secs) secs.appendChild(d);
      }
    } else if (none) {
      none.parentNode.removeChild(none);
    }
  }

  /* ------------------------------------------------------------------ *
   * ULOŽENÍ + DOPAD
   * ------------------------------------------------------------------ */
  function overviewSnapshot() {
    var st = (A().state) || {};
    return A().api('overview', { from: st.from, to: st.to, tab: st.tab || 'rings' })
      .then(function (ov) {
        var t = (ov && ov.totals) || {};
        return { kill: num(t.kill_count, 0), winners: num(t.winner_count, 0) };
      }).catch(function () { return null; });
  }

  function save() {
    if (S.saving) return;
    var keys = dirtyKeys();
    if (!keys.length) return;

    /* 1) Tvrdé chyby */
    var bad = keys.filter(function (k) { return itemErr(S.byKey[k]); });
    var cross = crossErrors();
    if (bad.length || cross.length) {
      toast(cross.length ? cross[0].msg : 'Oprav chybné hodnoty.', 'error');
      return;
    }

    /* 2) Nebezpečné hodnoty → potvrzení (Filip musí vidět, co si rozbije) */
    var dg = dangers();
    var proceed = dg.length
      ? confirmDanger(dg)
      : Promise.resolve(true);

    proceed.then(function (ok) {
      if (!ok) return;
      doSave(keys);
    });
  }

  function confirmDanger(dg) {
    return new Promise(function (resolve) {
      var html = '<div class="st-cfm">' +
        '<p class="st-cfm-lead">Tohle nastavení mění chování dashboardu způsobem, který se snadno přehlédne:</p>' +
        '<ul class="st-cfm-list">' + dg.map(function (d) {
          return '<li><b>' + esc(d.label) + '</b><br><span>' + esc(d.msg) + '</span></li>';
        }).join('') + '</ul>' +
        '<p class="st-cfm-foot">Uložit i tak?</p>' +
      '</div>';
      var foot = document.createElement('div');
      foot.className = 'st-cfm-foot-btns';
      foot.innerHTML = '<button class="st-btn st-btn-ghost" data-a="no">Zpět</button>' +
                       '<button class="st-btn st-btn-danger" data-a="yes">Uložit i tak</button>';
      var close = A()._modal(html, { title: '⚠️ Opatrně', size: 'sm', foot: foot });
      foot.addEventListener('click', function (e) {
        var b = e.target.closest('[data-a]');
        if (!b) return;
        var yes = b.getAttribute('data-a') === 'yes';
        if (close) close(); else A()._closeModal();
        resolve(yes);
      });
    });
  }

  function doSave(keys) {
    var values = {};
    var prev = {};
    keys.forEach(function (k) { values[k] = S.edits[k]; prev[k] = S.byKey[k].value; });

    var needImpact = keys.some(function (k) {
      var im = S.byKey[k].impact;
      return im === 'kill' || im === 'winners' || im === 'both';
    });

    S.saving = true;
    renderSoft(keys[0]);

    /* ⚠️ KONTRAKT (api.php): settings_save bere JEDEN klíč — {key, value}, ne dávku.
       Hodnota rovná defaultu → settings_reset, který override řádek SMAŽE
       (jinak by v ads_settings zůstal řádek „override = default" a tvářil se
       jako ručně nastavený). Ukládáme sekvenčně, ať serverový cross-check vidí
       už uložené sousedy a nespadne na půl cesty. */
    var saveOne = function (k) {
      var it = S.byKey[k];
      var val = values[k];
      var backToDefault = (it.dflt !== undefined && same(val, it.dflt));
      return backToDefault
        ? A().api('settings_reset', { key: k }, { method: 'POST' })
        : A().api('settings_save', { key: k, value: val }, { method: 'POST' });
    };
    /* ⚠️ Řetěz se staví AŽ TEĎ, uvnitř .then(). Když se `reduce` nad Promise.resolve()
       zavolal dřív, první save odstartoval hned a PŘEDBĚHL „before" snapshot → baseline
       už obsahoval novou hodnotu a dopad hlásil „36 → 36 beze změny". Měřit dopad musí
       jít v pořadí: 1) změř PŘED, 2) ulož, 3) změř PO. */
    var runSaves = function () {
      return keys.reduce(function (p, k) {
        return p.then(function () { return saveOne(k); });
      }, Promise.resolve());
    };

    var pre = needImpact ? overviewSnapshot() : Promise.resolve(null);
    pre.then(function (before) {
      return runSaves()
        .then(function () {
          /* Lokálně potvrď nové hodnoty + prahy v ADS.TH (semafor si je čte odtamtud) */
          keys.forEach(function (k) {
            var it = S.byKey[k];
            it.value = values[k];
            /* overridden = v DB je řádek navíc; při návratu na default ho server maže */
            it.overridden = !(it.dflt !== undefined && same(values[k], it.dflt));
            if (it.overridden) {
              it.who = (A().state && A().state.user) || it.who;
              it.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
            } else { it.who = ''; it.updated_at = null; }
            try { if (A().TH) A().TH[k] = values[k]; } catch (_) {}
          });
          S.edits = {};
          S.saving = false;
          toast(keys.length + ' ' + plural(keys.length, 'změna uložena', 'změny uloženy', 'změn uloženo'), 'success');

          /* Ať se překreslí zbytek dashboardu s novými prahy. */
          try { A()._emit && A()._emit('settingschange', { keys: keys }); } catch (_) {}

          if (!needImpact || !before) { S.lastImpact = null; render(); return; }
          return overviewSnapshot().then(function (after) {
            if (!after) { render(); return; }
            S.lastImpact = {
              note: 'Za aktuální období (' + fmtPeriod() + ') po uložení: ' +
                    keys.map(function (k) { return S.byKey[k].label; }).join(', '),
              prev: prev,
              rows: [
                { label: 'Kill kandidáti', before: before.kill, after: after.kill, good: 'down' },
                { label: 'Winners', before: before.winners, after: after.winners, good: 'up' }
              ]
            };
            render();
            var d = after.kill - before.kill;
            if (d !== 0) toast('Kill kandidáti: ' + before.kill + ' → ' + after.kill + ' (' + (d > 0 ? '+' : '') + d + ')', 'warn');
          });
        });
    }).catch(function (e) {
      S.saving = false;
      var msg = (e && e.body && (e.body.error || e.body.message)) || (e && e.message) || 'neznámá chyba';
      /* Ukládá se po jednom klíči → při chybě uprostřed může být část už zapsaná.
         Radši si stáhneme pravdu ze serveru, než abychom Filipovi ukazovali stav,
         který v DB není. Server validuje stejná pravidla jako my → tohle je vzácné. */
      toast('Uložení selhalo: ' + msg + ' — načítám aktuální stav ze serveru', 'error');
      S.loaded = false; S.edits = {};
      load();
    });
  }

  function fmtPeriod() {
    var st = A().state || {};
    var f = A().fmt;
    if (!st.from || !st.to) return 'aktuální období';
    return (f ? f.date(st.from) + ' – ' + f.date(st.to) : st.from + ' – ' + st.to);
  }

  function undoImpact() {
    var im = S.lastImpact;
    if (!im || !im.prev) return;
    var keys = Object.keys(im.prev);
    keys.forEach(function (k) { if (S.byKey[k]) S.edits[k] = im.prev[k]; });
    S.lastImpact = null;
    render();
    toast('Původní hodnoty vráceny do formuláře — ulož je tlačítkem dole.', 'info');
  }

  /* ------------------------------------------------------------------ *
   * ROUTING (shell: ADS.route + event 'routechange')
   * ------------------------------------------------------------------ */
  function routeOf(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'function') { try { return routeOf(x()); } catch (_) { return ''; } }
    if (typeof x === 'object') return String(x.route || x.name || x.current || x.id || x.view || '');
    return String(x);
  }
  function currentRoute() { return routeOf(A().route); }
  /* Klíče rout, které patří MÉMU mountu — čteno z registru shellu (ADS.ROUTES). */
  function myRoutes() {
    var out = [];
    var rs = A().ROUTES;
    if (Array.isArray(rs)) {
      rs.forEach(function (r) {
        if (r && String(r.mount || ('view-' + r.key)) === MOUNT_ID) out.push(String(r.key));
      });
    }
    return out.length ? out : ROUTE_FALLBACK;
  }
  function isMine(r) { return !!r && myRoutes().indexOf(r) > -1; }
  function isVisible() {
    var m = mount();
    if (!m) return false;
    if (m.hidden) return false;
    return !!(m.offsetParent || m.getClientRects().length);
  }
  function maybeRender() {
    var m = mount();
    if (!m) return;
    var r = currentRoute();
    var wanted = r ? isMine(r) : isVisible();
    if (!wanted) return;
    if (!S.loaded && !S.loading) load();
    else render();
  }

  function onRouteEvt(e) {
    var r = routeOf(e && e.detail) || currentRoute();
    if (r && !isMine(r)) return;
    setTimeout(maybeRender, 0);      // ať shell stihne odkrýt mount
  }

  /* Zabrat mount → shell do něj nekreslí placeholder „sekce se dodělává"
     (app.js routePlaceholder(): `data-owned="1"` = modul si obsah řídí sám). */
  function claimMount() {
    var m = mount();
    if (m) { m.setAttribute('data-owned', '1'); return true; }
    return false;
  }

  function boot() {
    if (!claimMount()) {
      var t0 = 0;
      var iv0 = setInterval(function () { if (claimMount() || ++t0 > 40) clearInterval(iv0); }, 250);
    }
    ['routechange', 'route', 'viewchange'].forEach(function (ev) {
      try { window.addEventListener(ev, onRouteEvt); } catch (_) {}
      try { A().bus && A().bus.addEventListener(ev, onRouteEvt); } catch (_) {}
    });
    try { A().onReady && A().onReady(function () { setTimeout(maybeRender, 0); }); } catch (_) {}

    /* Pojistka: kdyby shell žádnou událost neposlal, chytneme odkrytí mountu. */
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { if (isVisible()) maybeRender(); });
      var start = function () {
        var m = mount();
        if (!m) return false;
        mo.observe(m, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
        if (m.parentNode) mo.observe(m.parentNode, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
        return true;
      };
      if (!start()) {
        var tries = 0;
        var iv = setInterval(function () { if (start() || ++tries > 40) clearInterval(iv); }, 250);
      }
    }
    setTimeout(maybeRender, 0);
  }

  /* Veřejné handle pro shell (kdyby chtěl volat napřímo) */
  window.ADSSettings = {
    render: maybeRender,
    reload: function () { S.loaded = false; S.edits = {}; return load(); },
    isDirty: function () { return dirtyKeys().length > 0; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Ochrana proti ztrátě rozdělané práce */
  window.addEventListener('beforeunload', function (e) {
    if (!dirtyKeys().length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ------------------------------------------------------------------ *
   * STYLY (scoped .st-, proměnné ze styles.css s fallbackem)
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById('st-styles')) return;
    var css = `
.st-wrap{max-width:1080px;margin:0 auto;padding:var(--s-5,20px) 0 120px;}
.st-head{display:flex;align-items:flex-end;gap:var(--s-5,20px);flex-wrap:wrap;margin-bottom:var(--s-5,20px);}
.st-head-txt{flex:1;min-width:280px;}
.st-h1{font-size:24px;font-weight:740;letter-spacing:-.02em;margin:0 0 6px;color:var(--text,#23262e);}
.st-lead{margin:0;font-size:13.5px;line-height:1.55;color:var(--text-2,#5c6070);max-width:70ch;}
.st-head-act{display:flex;align-items:center;gap:var(--s-2,8px);}
.st-search-wrap{position:relative;}
.st-search-ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-3,#8b8f9e);font-size:14px;pointer-events:none;}
.st-search{height:34px;padding:0 12px 0 28px;width:220px;border:1px solid var(--border,#e7e4dc);border-radius:var(--r-pill,999px);
  background:var(--surface,#fff);font:inherit;font-size:13px;color:var(--text,#23262e);outline:none;transition:border-color .14s,box-shadow .14s;}
.st-search:focus{border-color:var(--border-focus,#b9bff0);box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.st-search::-webkit-search-cancel-button{cursor:pointer;}

/* --- tlačítka: měkká, ne Windows 2000 --- */
.st-btn{height:34px;padding:0 14px;border-radius:var(--r-sm,9px);border:1px solid var(--border,#e7e4dc);
  background:var(--surface,#fff);color:var(--text,#23262e);font:inherit;font-size:13px;font-weight:600;
  cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .14s,border-color .14s,box-shadow .14s,transform .06s;}
.st-btn:hover{background:var(--surface-2,#faf9f6);border-color:var(--border-strong,#d7d3c8);}
.st-btn:active{transform:translateY(1px);}
.st-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);border-color:var(--border-focus,#b9bff0);}
.st-btn:disabled{opacity:.5;cursor:not-allowed;}
.st-btn-primary{background:var(--accent,#4b58c9);border-color:var(--accent,#4b58c9);color:#fff;}
.st-btn-primary:hover:not(:disabled){background:var(--accent-600,#3f4bb4);border-color:var(--accent-600,#3f4bb4);box-shadow:var(--shadow-sm,0 1px 3px rgba(0,0,0,.07));}
.st-btn-ghost{background:transparent;border-color:transparent;color:var(--text-2,#5c6070);}
.st-btn-ghost:hover{background:var(--surface-3,#f2f0ea);border-color:transparent;}
.st-btn-danger{background:var(--red,#d3453f);border-color:var(--red,#d3453f);color:#fff;}
.st-btn-danger:hover{background:#c23a34;border-color:#c23a34;}
.st-btn-sm{height:28px;padding:0 10px;font-size:12px;}

/* --- karty sekcí --- */
.st-card{background:var(--surface,#fff);border:1px solid var(--border,#e7e4dc);border-radius:var(--r-md,13px);
  box-shadow:var(--shadow-xs,0 1px 2px rgba(30,28,24,.05));margin-bottom:var(--s-4,16px);overflow:hidden;}
.st-card-h{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border,#e7e4dc);
  background:linear-gradient(to bottom,var(--surface-2,#faf9f6),var(--surface,#fff));}
.st-card-ico{font-size:17px;line-height:1.3;flex:none;}
.st-card-hx{flex:1;min-width:0;}
.st-card-t{margin:0;font-size:15px;font-weight:700;color:var(--text,#23262e);letter-spacing:-.01em;}
.st-card-d{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--text-2,#5c6070);max-width:78ch;}
.st-card-n{flex:none;min-width:22px;height:22px;padding:0 7px;border-radius:var(--r-pill,999px);background:var(--surface-3,#f2f0ea);
  color:var(--text-3,#8b8f9e);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;}

/* --- položky --- */
.st-items{display:block;}
.st-item{display:flex;align-items:flex-start;gap:var(--s-5,20px);padding:14px 18px;border-bottom:1px solid var(--border,#e7e4dc);
  position:relative;transition:background .14s;}
.st-item:last-child{border-bottom:0;}
.st-item:hover{background:var(--surface-2,#faf9f6);}
.st-item.is-dirty{background:var(--accent-weak,#eceefb);}
.st-item.is-dirty::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent,#4b58c9);}
.st-item.has-err{background:var(--red-bg,#fbe6e4);}
.st-item.has-err::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red,#d3453f);}
.st-item-main{flex:1;min-width:0;}
.st-item-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.st-label{font-size:13.5px;font-weight:650;color:var(--text,#23262e);}
.st-const{font-family:var(--mono,monospace);font-size:10.5px;color:var(--text-3,#8b8f9e);background:var(--surface-3,#f2f0ea);
  padding:1.5px 5px;border-radius:4px;letter-spacing:0;}
.st-desc{margin:5px 0 0;font-size:12.5px;line-height:1.55;color:var(--text-2,#5c6070);max-width:74ch;}
.st-derive{margin:6px 0 0;font-size:12px;font-weight:600;color:var(--accent-700,#3a45a0);background:var(--accent-weak,#eceefb);
  display:inline-block;padding:3px 8px;border-radius:var(--r-xs,6px);}
.st-err{margin:6px 0 0;font-size:12px;font-weight:600;color:var(--red,#d3453f);}

.st-pill{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:var(--r-pill,999px);border:1px solid transparent;white-space:nowrap;}
.st-pill-impact{background:var(--yellow-bg,#fbf3dd);color:#8a6816;border-color:var(--yellow-bd,#eeddab);cursor:help;}
.st-pill-soft{background:var(--surface-3,#f2f0ea);color:var(--text-3,#8b8f9e);border-color:var(--border,#e7e4dc);cursor:help;}
.st-pill-dirty{background:var(--accent,#4b58c9);color:#fff;}
.st-pill-over{background:var(--info-bg,#e7f0fb);color:#245a97;border-color:var(--info-bd,#c3ddf4);cursor:help;}

/* mapy / JSON — jen ke čtení, ale čitelně */
.st-map{width:100%;border:1px solid var(--border,#e7e4dc);border-radius:var(--r-sm,9px);background:var(--surface-2,#faf9f6);overflow:hidden;}
.st-map-h{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;background:var(--surface-3,#f2f0ea);
  font-size:10px;font-weight:700;color:var(--text-3,#8b8f9e);text-transform:uppercase;letter-spacing:.03em;}
.st-map-r{display:flex;align-items:baseline;gap:7px;padding:5px 9px;border-top:1px solid var(--border,#e7e4dc);font-size:12px;}
.st-map-r:first-child{border-top:0;}
.st-map-k{font-family:var(--mono,monospace);font-size:11px;color:var(--text,#23262e);background:var(--surface,#fff);
  border:1px solid var(--border,#e7e4dc);border-radius:4px;padding:0 4px;flex:none;}
.st-map-a{color:var(--text-3,#8b8f9e);flex:none;}
.st-map-v{color:var(--text-2,#5c6070);word-break:break-word;text-align:right;flex:1;}
.st-map-empty{padding:8px 9px;font-size:11.5px;color:var(--text-3,#8b8f9e);font-style:italic;}
.st-map-note{padding:4px 9px;background:var(--surface-3,#f2f0ea);font-size:10px;color:var(--text-3,#8b8f9e);text-align:right;}

/* ===== M5 — KV EDITOR (mapa klíč → hodnota) =========================== *
   Mapa se do 210px sloupce ovládání nevejde → položka se přepne na sloupec
   a editor dostane celou šířku karty. Vzhled si bere stejné tokeny jako
   zbytek nastavení (žádná vlastní tlačítka „z Windows 2000"). */
.st-item--kv{flex-direction:column;align-items:stretch;gap:10px;}
.st-item--kv .st-item-ctl{width:100%;align-items:stretch;}
.st-kv{width:100%;border:1px solid var(--border,#e7e4dc);border-radius:var(--r-sm,9px);
  background:var(--surface-2,#faf9f6);overflow:hidden;}
.st-kv-h{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) 34px;gap:8px;padding:6px 10px;
  background:var(--surface-3,#f2f0ea);font-size:10px;font-weight:700;color:var(--text-3,#8b8f9e);
  text-transform:uppercase;letter-spacing:.03em;}
.st-kv-r{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) 34px;gap:8px;align-items:center;
  padding:7px 10px;border-top:1px solid var(--border,#e7e4dc);}
.st-kv-r.is-nested{align-items:start;}
.st-kv-c{min-width:0;}
.st-kv-num{width:100%;}
.st-kv-sel{width:100%;}
.st-kv-empty{padding:9px 10px;font-size:11.5px;color:var(--text-3,#8b8f9e);font-style:italic;
  border-top:1px solid var(--border,#e7e4dc);}
.st-kv-foot{padding:7px 10px;border-top:1px solid var(--border,#e7e4dc);background:var(--surface-3,#f2f0ea);}
.st-kv-add{border:1px dashed var(--border-strong,#d7d3c8);background:var(--surface,#fff);color:var(--accent,#4b58c9);
  font:inherit;font-size:12px;font-weight:650;cursor:pointer;padding:5px 11px;border-radius:var(--r-pill,999px);
  transition:background .12s,border-color .12s;}
.st-kv-add:hover{background:var(--accent-weak,#eceefb);border-color:var(--accent,#4b58c9);}
.st-kv-add:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.st-kv-add-sm{font-size:11px;padding:3px 9px;margin-top:2px;}
.st-kv-x{width:28px;height:28px;border:1px solid transparent;background:transparent;color:var(--text-3,#8b8f9e);
  border-radius:var(--r-sm,9px);cursor:pointer;font-size:17px;line-height:1;justify-self:end;
  transition:background .12s,color .12s,border-color .12s;}
.st-kv-x:hover{background:var(--red-bg,#fbe6e4);color:var(--red,#d3453f);border-color:var(--red-bd,#f2c1bd);}
.st-kv-x:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.st-kv-x-sm{width:24px;height:24px;font-size:14px;}
/* druhá úroveň (FUNNEL_OVERRIDES: funnel → { práh: číslo }) */
.st-kv-nest{display:flex;flex-direction:column;gap:6px;}
.st-kv-n{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,90px) 24px;gap:6px;align-items:center;}
.st-kv-n .st-sel{height:32px;font-size:12.5px;}
.st-kv-n .st-input{height:32px;font-size:13px;}

/* --- ovládání --- */
.st-item-ctl{flex:none;width:210px;display:flex;flex-direction:column;align-items:flex-end;gap:5px;}
.st-field{position:relative;display:flex;align-items:center;width:100%;background:var(--surface-2,#faf9f6);
  border:1px solid var(--border,#e7e4dc);border-radius:var(--r-sm,9px);transition:border-color .14s,box-shadow .14s,background .14s;}
.st-field:focus-within{background:var(--surface,#fff);border-color:var(--border-focus,#b9bff0);box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.st-field.has-err{border-color:var(--red-bd,#f2c1bd);}
.st-input{flex:1;min-width:0;height:36px;padding:0 6px 0 12px;border:0;background:transparent;outline:none;
  font:inherit;font-size:14px;font-weight:640;color:var(--text,#23262e);font-variant-numeric:tabular-nums;}
.st-input-num{text-align:right;}
.st-unit{flex:none;font-size:12px;font-weight:650;color:var(--text-3,#8b8f9e);padding-right:6px;}
.st-unit-ro{font-size:12px;color:var(--text-3,#8b8f9e);}
.st-step{flex:none;display:flex;flex-direction:column;border-left:1px solid var(--border,#e7e4dc);}
.st-step-b{width:26px;height:18px;border:0;background:transparent;color:var(--text-3,#8b8f9e);cursor:pointer;
  font-size:9px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s;}
.st-step-b:first-child{border-radius:0 var(--r-sm,9px) 0 0;}
.st-step-b:last-child{border-radius:0 0 var(--r-sm,9px) 0;border-top:1px solid var(--border,#e7e4dc);}
.st-step-b:hover{background:var(--surface-3,#f2f0ea);color:var(--text,#23262e);}
.st-ro{width:100%;text-align:right;font-size:14px;font-weight:650;color:var(--text-2,#5c6070);padding:8px 0;font-variant-numeric:tabular-nums;}
.st-json{margin:0;width:100%;max-height:120px;overflow:auto;background:var(--surface-3,#f2f0ea);border-radius:var(--r-xs,6px);
  padding:8px;font-family:var(--mono,monospace);font-size:11px;color:var(--text-2,#5c6070);}
.st-selwrap{width:100%;}
.st-sel{width:100%;height:36px;padding:0 10px;border:1px solid var(--border,#e7e4dc);border-radius:var(--r-sm,9px);
  background:var(--surface-2,#faf9f6);font:inherit;font-size:13.5px;color:var(--text,#23262e);cursor:pointer;}
.st-toggle{width:44px;height:26px;border-radius:var(--r-pill,999px);border:1px solid var(--border-strong,#d7d3c8);
  background:var(--surface-3,#f2f0ea);position:relative;cursor:pointer;transition:background .16s,border-color .16s;padding:0;}
.st-toggle-dot{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;
  box-shadow:var(--shadow-sm,0 1px 3px rgba(0,0,0,.12));transition:transform .16s;}
.st-toggle.is-on{background:var(--accent,#4b58c9);border-color:var(--accent,#4b58c9);}
.st-toggle.is-on .st-toggle-dot{transform:translateX(18px);}
.st-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}

.st-dflt{display:flex;align-items:center;gap:8px;justify-content:flex-end;min-height:18px;flex-wrap:wrap;}
.st-dflt-txt{font-size:11px;color:var(--text-3,#8b8f9e);font-variant-numeric:tabular-nums;}
.st-reset{border:0;background:transparent;color:var(--accent,#4b58c9);font:inherit;font-size:11px;font-weight:650;
  cursor:pointer;padding:2px 4px;border-radius:4px;transition:background .12s;}
.st-reset:hover{background:var(--accent-weak,#eceefb);text-decoration:underline;}
.st-reset:focus-visible{outline:none;box-shadow:0 0 0 2px var(--accent-weak-2,#d7dbf7);}

/* --- bannery / prázdno --- */
.st-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border-radius:var(--r-sm,9px);
  font-size:12.5px;line-height:1.5;margin-bottom:var(--s-4,16px);}
.st-banner-warn{background:var(--yellow-bg,#fbf3dd);border:1px solid var(--yellow-bd,#eeddab);color:#75570f;}
.st-banner-ico{flex:none;}
.st-empty{padding:44px 24px;text-align:center;}
.st-empty-ico{font-size:30px;opacity:.6;}
.st-empty-h{margin:10px 0 6px;font-size:16px;font-weight:700;color:var(--text,#23262e);}
.st-empty-p{margin:0 auto 14px;font-size:13px;line-height:1.6;color:var(--text-2,#5c6070);max-width:52ch;}
.st-hiddennote{margin:4px 2px 0;font-size:11.5px;line-height:1.5;color:var(--text-3,#8b8f9e);}
.st-hiddennote code{font-family:var(--mono,monospace);font-size:10.5px;background:var(--surface-3,#f2f0ea);padding:1px 4px;border-radius:3px;}

/* --- skeleton --- */
@keyframes st-pulse{0%,100%{opacity:.55}50%{opacity:.28}}
.st-sk{padding:18px;}
.st-sk-h{height:16px;width:180px;background:var(--surface-3,#f2f0ea);border-radius:6px;animation:st-pulse 1.3s ease-in-out infinite;}
.st-sk-r{height:38px;margin-top:12px;background:var(--surface-3,#f2f0ea);border-radius:8px;animation:st-pulse 1.3s ease-in-out infinite;}

/* --- dopad --- */
.st-impact{background:var(--surface,#fff);border:1px solid var(--accent-weak-2,#d7dbf7);border-left:3px solid var(--accent,#4b58c9);
  border-radius:var(--r-md,13px);padding:14px 16px;margin-bottom:var(--s-4,16px);box-shadow:var(--shadow-sm,0 1px 3px rgba(30,28,24,.07));
  animation:st-slide .22s ease;}
@keyframes st-slide{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
.st-impact-h{display:flex;align-items:center;gap:10px;}
.st-impact-h > div{flex:1;min-width:0;font-size:13.5px;color:var(--text,#23262e);}
.st-impact-ico{font-size:16px;}
.st-impact-sub{display:block;font-size:11.5px;color:var(--text-3,#8b8f9e);font-weight:400;margin-top:2px;}
.st-impact-x{border:0;background:transparent;color:var(--text-3,#8b8f9e);cursor:pointer;font-size:13px;padding:4px 6px;border-radius:5px;}
.st-impact-x:hover{background:var(--surface-3,#f2f0ea);color:var(--text,#23262e);}
.st-imp-rows{display:flex;gap:22px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border,#e7e4dc);}
.st-imp-row{display:flex;align-items:center;gap:7px;font-size:13px;}
.st-imp-l{color:var(--text-2,#5c6070);font-weight:600;}
.st-imp-v{font-weight:720;font-size:16px;color:var(--text-3,#8b8f9e);font-variant-numeric:tabular-nums;}
.st-imp-v.is-new{color:var(--text,#23262e);}
.st-imp-v.is-new.up{color:var(--green,#1f9d63);}
.st-imp-v.is-new.down{color:var(--red,#d3453f);}
.st-imp-a{color:var(--text-3,#8b8f9e);}
.st-imp-d{font-size:11.5px;font-weight:700;padding:2px 6px;border-radius:var(--r-pill,999px);background:var(--surface-3,#f2f0ea);color:var(--text-3,#8b8f9e);}
.st-imp-d.up{background:var(--green-bg,#e4f5ec);color:#1c6b47;}
.st-imp-d.down{background:var(--red-bg,#fbe6e4);color:#a8322c;}

/* --- save bar --- */
.st-savebar{position:fixed;left:0;right:0;bottom:0;z-index:900;padding:12px var(--s-6,24px) 16px;
  background:linear-gradient(to top,var(--bg,#f6f5f1) 62%,rgba(246,245,241,0));pointer-events:none;animation:st-up .2s ease;}
@keyframes st-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.st-savebar-in{pointer-events:auto;max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:12px;
  background:var(--surface,#fff);border:1px solid var(--border-strong,#d7d3c8);border-radius:var(--r-md,13px);
  padding:10px 12px 10px 16px;box-shadow:var(--shadow-md,0 4px 14px rgba(30,28,24,.09));}
.st-savebar-dot{width:8px;height:8px;border-radius:50%;background:var(--accent,#4b58c9);flex:none;
  box-shadow:0 0 0 4px var(--accent-weak,#eceefb);}
.st-savebar.is-blocked .st-savebar-dot{background:var(--red,#d3453f);box-shadow:0 0 0 4px var(--red-bg,#fbe6e4);}
.st-savebar-txt{flex:none;display:flex;flex-direction:column;gap:1px;}
.st-savebar-txt b{font-size:13px;color:var(--text,#23262e);}
.st-savebar-names{font-size:11.5px;color:var(--text-3,#8b8f9e);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.st-savebar-err{flex:1;font-size:12px;font-weight:600;color:var(--red,#d3453f);text-align:right;}
.st-savebar-in > .st-btn:last-child{margin-left:auto;}
.st-savebar-err ~ .st-btn:last-child{margin-left:0;}

/* --- confirm modal obsah --- */
.st-cfm-lead{margin:0 0 10px;font-size:13.5px;color:var(--text,#23262e);}
.st-cfm-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;}
.st-cfm-list li{font-size:13px;line-height:1.5;color:var(--text-2,#5c6070);}
.st-cfm-list li b{color:var(--text,#23262e);}
.st-cfm-foot{margin:12px 0 0;font-size:13.5px;font-weight:650;color:var(--text,#23262e);}
.st-cfm-foot-btns{display:flex;gap:8px;justify-content:flex-end;width:100%;}

@media (max-width:820px){
  .st-item{flex-direction:column;align-items:stretch;gap:10px;}
  .st-item-ctl{width:100%;align-items:stretch;}
  .st-dflt{justify-content:space-between;}
  .st-savebar-names,.st-savebar-err{display:none;}
}
`;
    var st = document.createElement('style');
    st.id = 'st-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }
})();
