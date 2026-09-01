/* =====================================================================
 * NK Ads Dashboard — views.js
 * VIEW ENGINE pro konsolidovanou tabulku (KONSOLIDACE.md, schváleno Filipem 16. 7.).
 *
 * Filip: „jestli tolik těch tabulek není overkill, jestli nejsou stejný… spíš bych to
 * měl jako záložky, které mění views, než mít deset různých."
 *
 * Tenhle modul VLASTNÍ:
 *   • definici views (vestavěné + uživatelské)
 *   • jejich ukládání (prefs scope='all' → sdílené pro všechny; + localStorage cache)
 *   • řádek záložek s POČTY  (Filip: „bez toho do toho nejdeme")
 *   • pořadí záložek (drag & drop), emoji, poznámku a stránkování per view
 *   • dialogy: + Nové view · přejmenovat · duplikovat · smazat / vrátit na výchozí
 *
 * Tenhle modul NEVÍ NIC o Tabulatoru ani o sloupcích — jen drží jejich `key` seznam.
 * Renderování tabulky/dlaždic dělá tables.js přes ADS.views.onChange().
 *
 * Kontrakt (window.ADS.views):
 *   ready                      → Promise (doběhne, až dorazí serverové views)
 *   list(tab)                  → [view]         (vestavěné + uživatelské, v pořadí)
 *   active(tab)                → view           (živý objekt; needituj mimo patch())
 *   setActive(tab, id)
 *   patch(tab, patch)          → zapiš změnu do aktivního view (+ LS draft + 'change')
 *   isDirty(tab)               → bool           (má neuložené změny?)
 *   save(tab)                  → Promise        (push na server, scope='all')
 *   discard(tab)               → zahoď draft
 *   setCounts(tab, {seg: n})   → počty do záložek (zdroj = API, NE dopočet na FE)
 *   renderBar(el, tab)         → vykresli řádek záložek do elementu
 *   onChange(cb)               → cb({tab, reason})
 *   setColumnsProvider(fn)     → fn(view) → [colKey] (default sloupce; view.columns===null)
 *   pageSizeOf(view)           → 10|20|50|100 | true (= vše)  ← přímo do Tabulator.setPageSize()
 *
 * ⚠️ VIEW = { id, name, ico, note, order, builtin, tab, segment, filters, sort,
 *             period, mode, paginate, pageSize, columns }
 *    `segment` = SERVEROVÝ filtr (kill|winners|new|all|alltime). FE ho NIKDY nepočítá sám
 *    (16. 7.: dlaždice ukazovaly 13 winnerů, tabulka 15 — každá měla vlastní podmínku).
 *    `filters` = uživatelské DOPLŇKOVÉ filtry nad serverovým segmentem (funnel/ROAS/spend).
 *
 * 🆕 FEEDBACK-6 (T2/T3/T4/T5) — tři nová pole, žádná změna API:
 *    `order`    (int|null) — pořadí záložky. Filip: „chci, abych mohl drag and dropovat ty
 *               jednotlivý views, abych mohl měnit jejich pořadí." Ukládá se OKAMŽITĚ
 *               (je to sdílená vlastnost seznamu, ne rozpracovaná úprava) a NENÍ součástí
 *               fingerprintu → přeskládání nerozsvítí „neuloženo".
 *    `note`     (string)   — poznámka do tooltipu na názvu záložky (T4).
 *    `pageSize` (10|20|50|100|null) — null = VŠE (T5). `paginate` zůstává jako ODVOZENÝ
 *               bool (= pageSize != null) kvůli zpětné kompatibilitě s tables.js.
 * ===================================================================== */
(function boot(tries) {
  if (window.ADS && typeof window.ADS.onReady === 'function') { main(window.ADS); }
  else if (tries < 60) { setTimeout(function () { boot(tries + 1); }, 100); }
  else { console.error('[views] window.ADS není dostupné — views se nenastartují.'); }
})(0);

function main(ADS) {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Utility
   * ------------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function errMsg(e) { return (e && (e.message || e.error || e.msg)) || String(e || 'neznámá chyba'); }

  /* ⚠️ SLUG MUSÍ PROJÍT SERVEROVOU VALIDACÍ pref_key.
   * api.php: preg_match('/^[A-Za-z0-9:_\-]{1,64}$/', $key) na CELÝ klíč včetně 'view:' prefixu.
   * → povolené znaky jen ASCII alnum + _ - , a slug max 59 znaků („view:" = 5).
   * Čeština se proto FOLDUJE na ASCII (Zásnubní → zasnubni); zobrazované jméno zůstává
   * v `name` uvnitř JSON hodnoty, takže Filip diakritiku nikde neztratí.
   * Kolizi jmen řeší přípona -2, -3… (viz uniqueId).
   */
  function slugify(s) {
    var out = String(s || '').toLowerCase();
    // NFD rozlozí „á" na „a" + kombinující čárku → druhý replace diakritiku zahodí.
    // (Kdyby normalize() nebyl k dispozici, slug by zůstal bez diakritických písmen — pořád
    //  platný klíč, kolize řeší uniqueId.)
    try { out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { }
    out = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!out) out = 'view';
    return out.slice(0, 40);
  }
  function uniqueId(tab, base) {
    var all = {};
    (state[tab] || []).forEach(function (v) { all[v.id] = 1; });
    var id = base, i = 2;
    while (all[id]) { id = base + '-' + (i++); }
    return id;
  }

  /* ================================================================== *
   *  VESTAVĚNÉ VIEWS  (KONSOLIDACE.md — tabulka „dnešní sekce")
   * ================================================================== *
   * Vestavěné views se do DB NEUKLÁDAJÍ — žijí v kódu. Uživatel je může přepsat
   * (uloží view stejného `id`) a kdykoli vrátit na výchozí (⋮ → Vrátit na výchozí).
   *
   * `sort`: POZOR na pořadí — Tabulator řadí stabilním sortem postupně, takže
   * PRIMÁRNÍ je POSLEDNÍ sorter. Držíme stejnou konvenci jako dosud (ověřeno živě).
   * `period`: null = globální picker · 'alltime' = maximum historie (vlastní fetch).
   */
  function builtins(tab) {
    if (tab === 'earrings') {
      return [
        {
          id: 'kill', name: 'Na kill', ico: '🔴', note: '', order: null, builtin: true, tab: 'earrings',
          segment: 'kill', filters: {}, sort: [{ col: '_burned', dir: 'desc' }],
          period: null, mode: 'table', paginate: false, pageSize: null, columns: null,
          sub: 'spálené peníze nejdřív (na zaplaceno)'
        },
        {
          id: 'winners', name: 'Winners', ico: '🟢', note: '', order: null, builtin: true, tab: 'earrings',
          segment: 'winners', filters: {}, sort: [{ col: 'spend', dir: 'desc' }, { col: '_roasPaid', dir: 'desc' }],
          period: null, mode: 'table', paginate: true, pageSize: 20, columns: null,   // Filip: výchozí 20
          sub: 'nejvyšší ROAS zaplaceno'
        },
        {
          id: 'all', name: 'Všechny', ico: '💎', note: '', order: null, builtin: true, tab: 'earrings',
          segment: 'all', filters: {}, sort: [{ col: 'spend', dir: 'desc' }],
          period: null, mode: 'table', paginate: true, pageSize: 20, columns: null,    // Filip: výchozí 20
          sub: 'kreativa × období (na zaplaceno)'
        }
      ];
    }
    return [
      {
        id: 'kill', name: 'Na kill', ico: '🔴', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'kill', filters: {}, sort: [{ col: '_burned', dir: 'desc' }],
        // ⚠️ pageSize:null (= VŠE) ZÁMĚRNĚ (SPEC G2) — všechny kill kandidáty musí jít
        // proklikat a killnout naráz, bez lovení po stránkách.
        period: null, mode: 'table', paginate: false, pageSize: null, columns: null,
        sub: 'spálené peníze nejdřív'
      },
      {
        /* K POVÝŠENÍ (Filip 14. 8. 2026) — kreativy s hotovým verdiktem, které pořád běží
         * jen v EXPERIMENTU. Vlastní záložka, protože se ztrácejí mezi Winners: 504 193 Kč
         * (18 % spendu) sedělo v testovací lane, vč. L-220-001 s ROASm 10,73. */
        id: 'promote', name: 'K povýšení', ico: '⬆️', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'promote', filters: {}, sort: [{ col: 'spend', dir: 'desc' }],
        period: null, mode: 'table', paginate: false, pageSize: null, columns: null,
        sub: 'verdikt hotov, ale visí v EXPERIMENTU → post-ID do SCALE'
      },
      {
        id: 'winners', name: 'Winners', ico: '🟢', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'winners', filters: {}, sort: [{ col: 'spend', dir: 'desc' }, { col: 'roas_model', dir: 'desc' }],
        period: null, mode: 'table', paginate: true, pageSize: 20, columns: null,
        sub: 'nejvyšší ROAS model'
      },
      {
        id: 'decaying', name: 'Zhoršují se', ico: '📉', builtin: true, tab: 'rings',
        note: 'Kreativy, kterým vylétla CPA proti VLASTNÍMU startu = signál umírání (ověřeno na celém vzorku, 97% precision). Chyť je dřív, než smažou profit.',
        order: null, segment: 'all', filters: { decay: true },
        sort: [{ col: 'decay', dir: 'desc' }, { col: 'spend', dir: 'desc' }],
        period: null, mode: 'table', paginate: true, pageSize: 20, columns: null,
        sub: 'CPA roste vs vlastní start'
      },
      {
        id: 'spenders', name: 'Top spenders', ico: '💸', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'all', filters: {}, sort: [{ col: 'spend', dir: 'desc' }],
        period: null, mode: 'table', paginate: true, pageSize: 20, columns: null,
        sub: 'kam tečou peníze'
      },
      {
        id: 'newest', name: 'Nejnovější', ico: '🆕', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'new', filters: {}, sort: [{ col: '_created', dir: 'desc' }],
        // KONSOLIDACE bod 2: režim dlaždic je VLASTNOST VIEW, ne výjimka pro tuhle sekci.
        period: null, mode: 'tiles', paginate: true, pageSize: 20, columns: null,
        sub: 'čerstvé kreativy'
      },
      {
        id: 'alltime', name: 'All-time best', ico: '🏆', note: '', order: null, builtin: true, tab: 'rings',
        segment: 'alltime', filters: {}, sort: [{ col: 'revenue_real', dir: 'desc' }],
        period: 'alltime', mode: 'table', paginate: true, pageSize: 20, columns: null,
        sub: 'inspirace z historie'
      }
    ];
  }

  /* --- T5: stránkování jako vlastnost view ---------------------------------------------
   * Filip: „stránkování bych dal, že si můžu vybrat: deset, dvacet, padesát, sto, všechno."
   * `pageSize = null` = VŠE. `paginate` (starý bool) zůstává ODVOZENÝ — dokud ho tables.js
   * čte, dostane pravdu (true → stránkuje, false → vše na jedné stránce) a nic se nerozbije.
   */
  var PAGE_SIZES = [10, 20, 50, 100];
  function pageLabel(ps) { return ps == null ? 'Vše' : String(ps); }

  // Z view (i staršího, který `pageSize` vůbec nemá) udělej platnou hodnotu.
  function normPageSize(v) {
    if (!v || typeof v !== 'object') return 20;
    if (Object.prototype.hasOwnProperty.call(v, 'pageSize')) {
      if (v.pageSize === null || v.pageSize === 'all' || v.pageSize === false) return null;
      var n = num(v.pageSize);
      if (n != null && n > 0) {
        // Neznámé číslo (ruční zásah v DB) → nejbližší povolená volba, ať select
        // vždycky ukazuje to, co tabulka fakt dělá. Nikdy nepustíme dál nesmysl.
        var best = PAGE_SIZES[0], bd = Infinity;
        PAGE_SIZES.forEach(function (p) { var d = Math.abs(p - n); if (d < bd) { bd = d; best = p; } });
        return best;
      }
      return 20;
    }
    // Legacy view z DB: znal jen `paginate` → false znamenalo „vše", true „po 20".
    return (v.paginate === false) ? null : 20;
  }

  // Přímo do Tabulator.setPageSize(): `true` = všechno na jedné stránce.
  function pageSizeOf(v) { var ps = normPageSize(v); return ps == null ? true : ps; }

  var TABS = ['rings', 'earrings'];

  /* --- T3: emoji per view ---------------------------------------------------------------
   * Filip: „chtěl bych, abych si tam mohl vybrat tu emoji, která se ukazuje u toho view."
   * Paleta = to, co v tomhle nástroji fakt znamená něco (stavy, peníze, funnely dle T13),
   * ne náhodný emoji katalog. Vlastní vstup je vedle — kdyby chtěl cokoli jiného.
   *
   * ⚠️ Délka: emoji se skládají ze surrogate párů (💸 = 2 UTF-16 jednotky) a některé
   * z víc code pointů + ZWJ. Proto se OŘEZÁVÁ PO CODE POINTECH (ne .slice(0,4) po
   * jednotkách — to by 🔴 rozpůlilo na půlku páru a vyrobilo „�").
   */
  var EMOJI_PALETTE = [
    // stav / rozhodnutí
    '🔴', '🟢', '🟡', '🟠', '⚫', '⚪', '✅', '⛔', '⏸️', '▶️', '⚠️', '👀', '🧪',
    // peníze / výkon
    '💸', '💰', '📈', '📉', '📊', '🏆', '🥇', '🔥', '🚀', '🎯', '⚡', '🐢', '🧊',
    // obsah / provoz
    '🆕', '⭐', '💎', '💍', '📌', '🔍', '🎬', '🖼️', '📅', '🧭', '🔧', '🗂️',
    // funnely (T13 — stejná řeč barev jako pills)
    '🔵', '🟤', '🟣', '🩷'
  ];

  /* Ikona = JEN emoji. Filip: pole šlo vyplnit i textem a uložit → bordel („kill" → „kil").
   * Necháme jen emoji code pointy (piktogramy + jejich modifikátory/ZWJ/variation selector
   * + regionální indikátory na vlajky). Písmena/číslice/interpunkci zahodíme. */
  var _emojiRe = (function () {
    try { return new RegExp('(\\p{Extended_Pictographic}|\\p{Emoji_Presentation}|\\p{Regional_Indicator}|[\\u200d\\ufe0f\\u{1F3FB}-\\u{1F3FF}])', 'u'); }
    catch (_) { return null; }   // starý engine bez \p{} → fallback níž
  })();
  function isEmojiChar(ch) {
    if (_emojiRe) return _emojiRe.test(ch);
    var cp = ch.codePointAt(0);   // hrubý fallback: symboly/emoji bloky nad BMP a piktogramy
    return cp >= 0x1F000 || (cp >= 0x2190 && cp <= 0x2BFF) || (cp >= 0x2600 && cp <= 0x27BF);
  }
  function normIco(s) {
    if (typeof s !== 'string') return '';
    var cps;
    try { cps = Array.from(s.trim()); } catch (_) { cps = s.trim().split(''); }
    return cps.filter(isEmojiChar).slice(0, 3).join('');
  }

  // Segmenty, které umí režim dlaždic. `new` je jediný, pro který dlaždice reálně
  // existují (newest.js si tahá vlastní `segment=new`) → jinde by dlaždice ukazovaly
  // JINÁ DATA než záložka slibuje. Radši funkci nenabídnout, než lhát.
  var TILES_SEGMENTS = { 'new': true };
  function canTiles(v) { return !!(v && TILES_SEGMENTS[v.segment]); }

  var SEGMENT_LABELS = {
    kill: 'Na kill (kandidáti dle kill vrstev)',
    promote: 'K povýšení — JEDINÁ škálovací akce: winner (ROAS model ≥ 5) běžící jen v EXPERIMENTU → post-ID duplikát do SCALE',
    winners: 'Winners (ROAS model ≥ 5) — badge „Podvyživená" značí winnera bez prostoru od Facebooku',
    'new': 'Nejnovější (nové kreativy)',
    all: 'Všechny kreativy',
    alltime: 'All-time (maximum historie)'
  };

  /* ================================================================== *
   *  STAV
   * ================================================================== */
  var state = { rings: [], earrings: [] };     // tab → [view]
  var activeId = { rings: null, earrings: null };
  var counts = { rings: {}, earrings: {} };    // tab → viewId → number|null   (null = ještě nevíme)
  var baseline = {};                            // tab:id → JSON uloženého/výchozího stavu (dirty check)
  /* Snapshot view BEZ draftu (= co je fakt uložené / co je výchozí z kódu).
   * Kvůli T2: přeskládání pořadí ukládá VŠECHNY views tabu, a to nesmí kolegovi
   * vypublikovat Filipovy rozpracované (nedoklikané) změny sloupců. Proto se do
   * prefs posílá tenhle snapshot + nové `order`, ne živý objekt s draftem. */
  var savedSnap = {};                           // tab:id → clone(view) bez draftu
  var listeners = [];
  var bars = [];                                // [{el, tab}] — kam překreslovat
  // T2: stav tažení záložky. null = netáhne se.
  // Je to modulová proměnná (ne uvnitř wireDrag) schválně: drawBars() na ni kouká,
  // aby uprostřed dragu nepřepsal innerHTML a nevytrhl uživateli element z ruky.
  var dragState = null;                         // {tab, id, el} | null
  var tipEl = null;                             // T4: bublina s poznámkou (jedna pro celou app)
  var columnsProvider = null;

  var LS = 'nk-ads:';
  function lsGet(k) { try { return window.localStorage.getItem(LS + k); } catch (_) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(LS + k, v); } catch (_) { } }
  function lsDel(k) { try { window.localStorage.removeItem(LS + k); } catch (_) { } }

  /* --- Draft = neuložené změny (šířky/pořadí/skrytí/řazení/režim) -----------------------
   * Filip chce, aby změna sloupců „zůstala" i bez klikání na Uložit → padá hned do
   * localStorage. Uložení na server (scope='all') je pak VĚDOMÝ krok, protože views
   * jsou SDÍLENÉ a přepsat je kolegovi bez záměru by bylo nepříjemné překvapení. */
  function draftKey(tab, id) { return 'view-draft:' + tab + ':' + id; }
  function readDraft(tab, id) {
    var raw = lsGet(draftKey(tab, id));
    if (!raw) return null;
    try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : null; } catch (_) { return null; }
  }
  function writeDraft(tab, v) {
    lsSet(draftKey(tab, v.id), JSON.stringify({
      columns: v.columns, sort: v.sort, mode: v.mode, filters: v.filters,
      paginate: v.paginate, pageSize: v.pageSize
    }));
  }
  function dropDraft(tab, id) { lsDel(draftKey(tab, id)); }

  /* Otisk pro porovnání „je to jiné než uložené?" — jen to, co si view fakt pamatuje.
   * ⚠️ `order` tu SCHVÁLNĚ NENÍ: pořadí se ukládá hned po přetažení (je to sdílená
   * vlastnost seznamu, ne rozdělaná úprava jednoho view) → jinak by se po každém
   * přetažení rozsvítilo „neuloženo" u view, kterého se to netýká. */
  function fingerprint(v) {
    return JSON.stringify({
      columns: v.columns, sort: v.sort, mode: v.mode, filters: v.filters,
      paginate: v.paginate, pageSize: v.pageSize, name: v.name, ico: v.ico, note: v.note
    });
  }
  function bkey(tab, id) { return tab + ':' + id; }
  function isDirty(tab) {
    var v = active(tab);
    if (!v) return false;
    var b = baseline[bkey(tab, v.id)];
    return b != null && b !== fingerprint(v);
  }

  /* ================================================================== *
   *  SERVEROVÉ ULOŽENÍ (prefs, scope='all' — Filip: „Views: SDÍLENÉ pro všechny")
   * ================================================================== */
  function prefKey(id) { return 'view:' + id; }

  var prefsPromise = null;
  function serverPrefs() {
    if (prefsPromise) return prefsPromise;
    prefsPromise = Promise.resolve(ADS.api('prefs_get', {}))
      .then(function (r) { return (r && r.prefs) || {}; })
      .catch(function (err) {
        // Server bez prefs NESMÍ shodit celý dashboard → jedeme na vestavěných views.
        console.warn('[views] prefs_get selhal → jen vestavěné views:', errMsg(err));
        return {};
      });
    return prefsPromise;
  }

  // Normalizace view z DB — nikdy nevěř tomu, co v ní leží (starší verze, ruční zásah).
  function sanitize(v, fallbackTab) {
    if (!v || typeof v !== 'object') return null;
    var tab = (v.tab === 'earrings') ? 'earrings' : (v.tab === 'rings' ? 'rings' : fallbackTab);
    if (!tab) return null;
    var seg = String(v.segment || 'all');
    if (!SEGMENT_LABELS[seg]) seg = 'all';
    var out = {
      id: String(v.id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40),
      name: String(v.name || '').slice(0, 60) || 'View',
      ico: normIco(v.ico),
      // T4: poznámka do tooltipu. Strop 240 znaků — je to nápověda pod myš,
      // ne dokumentace (a `value` v prefs má tvrdý limit 64 kB pro CELÉ view).
      note: typeof v.note === 'string' ? v.note.slice(0, 240) : '',
      // T2: pořadí záložky. `null` = „ještě se netáhlo" → padá na přirozené pořadí.
      order: (function () { var n = num(v.order); return (n == null) ? null : Math.round(n); })(),
      builtin: !!v.builtin,
      tab: tab,
      segment: seg,
      filters: (v.filters && typeof v.filters === 'object') ? v.filters : {},
      sort: Array.isArray(v.sort) ? v.sort.filter(function (s) { return s && s.col; }).map(function (s) {
        return { col: String(s.col), dir: (s.dir === 'asc' ? 'asc' : 'desc') };
      }) : [],
      period: (v.period === 'alltime') ? 'alltime' : null,
      mode: (v.mode === 'tiles') ? 'tiles' : 'table',
      pageSize: normPageSize(v),
      paginate: normPageSize(v) != null,      // ODVOZENÉ — zdroj pravdy je pageSize
      columns: Array.isArray(v.columns) ? v.columns.filter(function (c) { return c && c.key; }).map(function (c) {
        var o = { key: String(c.key) };
        var w = num(c.w); if (w != null && w > 0) o.w = Math.round(w);
        o.visible = c.visible !== false;
        return o;
      }) : null,
      sub: typeof v.sub === 'string' ? v.sub : ''
    };
    if (!out.id) return null;
    // Pojistka: dlaždice mimo `new` segment by ukazovaly jiná data, než záložka slibuje.
    if (out.mode === 'tiles' && !canTiles(out)) out.mode = 'table';
    return out;
  }

  /* Sestavení seznamu views pro tab:
   *   1) vestavěné (z kódu)
   *   2) serverové: stejné `id` → PŘEPÍŠE vestavěné · nové `id` → uživatelské view
   *      · hodnota `null` = TOMBSTONE (smazáno) → uživatelské zmizí, vestavěné se vrátí na default
   *   3) lokální draft (neuložené změny) navrch
   */
  function build(tab, prefs) {
    var list = builtins(tab);
    var byId = {};
    list.forEach(function (v) { byId[v.id] = v; });

    Object.keys(prefs || {}).forEach(function (k) {
      if (k.indexOf('view:') !== 0) return;
      var id = k.slice(5);
      var p = prefs[k];
      if (!p) return;
      if (p.value === null) {                    // tombstone
        if (byId[id] && !byId[id].builtin) { delete byId[id]; }
        return;                                  // vestavěné → zůstane výchozí
      }
      var sv = sanitize(p.value, null);
      if (!sv || sv.tab !== tab) return;
      if (sv.id !== id) sv.id = id;              // klíč v DB je zdroj pravdy
      if (byId[id] && byId[id].builtin) {
        // Přepis vestavěného: `segment` zůstává Z KÓDU. Je to jediné pole, které je
        // zároveň KONTRAKT SE SERVEREM — kdyby si ho někdo v DB přepsal, záložka
        // „Na kill" by tahala winnery a nikdo by nepoznal proč. Zbytek (název, ikona,
        // sloupce, řazení, režim) si uživatel přepsat SMÍ; ⋮ → Vrátit na výchozí to zruší.
        var b = byId[id];
        b.name = sv.name || b.name;
        b.ico = sv.ico || b.ico;
        b.note = sv.note || '';
        b.order = sv.order;
        b.columns = sv.columns;
        b.sort = sv.sort.length ? sv.sort : b.sort;
        b.mode = canTiles(b) ? sv.mode : 'table';
        b.pageSize = sv.pageSize;
        b.paginate = sv.paginate; b.filters = sv.filters;
        b._saved = true;
      } else {
        sv.builtin = false;
        sv._saved = true;
        byId[id] = sv;
      }
    });

    /* PŘIROZENÉ pořadí (než do toho Filip sáhne myší): vestavěné v pořadí z kódu,
     * uživatelské za nimi abecedně. */
    var order = builtins(tab).map(function (v) { return v.id; });
    var out = [];
    order.forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
    var rest = Object.keys(byId).map(function (id) { return byId[id]; });
    rest.sort(function (a, b) { return a.name.localeCompare(b.name, 'cs'); });
    out = out.concat(rest);

    /* T2 — RUČNÍ pořadí přebíjí přirozené.
     * Klíč = uložený `order`, a kdo ho nemá (nové view od kolegy, vestavěné, kterým
     * se nikdy netáhlo), padá NA KONEC v přirozeném pořadí — proto `_nat + BIG`.
     * Tie-break `_nat` drží řazení stabilní i při shodných hodnotách (starší DB,
     * dva lidi táhli současně) → nikdy to nezačne poskakovat mezi reloady. */
    out.forEach(function (v, i) { v._nat = i; });
    var BIG = 1000;
    out.sort(function (a, b) {
      var ka = (a.order == null) ? (a._nat + BIG) : a.order;
      var kb = (b.order == null) ? (b._nat + BIG) : b.order;
      return (ka - kb) || (a._nat - b._nat);
    });

    // Baseline + snapshot = stav BEZ draftu (proti baseline se pozná „neuloženo",
    // snapshot se posílá na server při přeskládání pořadí).
    out.forEach(function (v) {
      baseline[bkey(tab, v.id)] = fingerprint(v);
      savedSnap[bkey(tab, v.id)] = clone(v);
    });

    // Draft navrch.
    out.forEach(function (v) {
      var d = readDraft(tab, v.id);
      if (!d) return;
      if (Array.isArray(d.columns)) v.columns = d.columns;
      if (Array.isArray(d.sort) && d.sort.length) v.sort = d.sort;
      if (d.mode) v.mode = canTiles(v) ? d.mode : 'table';
      if (d.filters && typeof d.filters === 'object') v.filters = d.filters;
      // Draft z doby před T5 zná jen `paginate` → normPageSize si z něj odvodí pageSize.
      if (Object.prototype.hasOwnProperty.call(d, 'pageSize') || typeof d.paginate === 'boolean') {
        v.pageSize = normPageSize(d);
        v.paginate = v.pageSize != null;
      }
    });

    return out;
  }

  /* ================================================================== *
   *  VEŘEJNÉ API
   * ================================================================== */
  function list(tab) { return state[tab] || []; }
  function byId(tab, id) {
    var l = list(tab);
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function active(tab) {
    return byId(tab, activeId[tab]) || list(tab)[0] || null;
  }
  function setActive(tab, id, silent) {
    if (!byId(tab, id)) return;
    activeId[tab] = id;
    lsSet('view-active:' + tab, id);
    drawBars();
    if (!silent) emit(tab, 'active');
  }
  function patch(tab, p) {
    var v = active(tab);
    if (!v) return;
    var p2 = p || {};
    Object.keys(p2).forEach(function (k) { v[k] = p2[k]; });
    if (v.mode === 'tiles' && !canTiles(v)) v.mode = 'table';
    /* pageSize je zdroj pravdy, paginate jeho odvozenina — držet je v sync i když
     * volající pošle jen jedno z nich. Rozejít se nesmí NIKDY: podle `paginate` se
     * schovává patička tabulky, podle `pageSize` se plní stránka.
     * Když někdo (starší kód) pošle JEN `paginate`, bereme ho jako povel:
     * false → vše, true → default 20. Jinak vede pageSize. */
    if (Object.prototype.hasOwnProperty.call(p2, 'paginate') &&
      !Object.prototype.hasOwnProperty.call(p2, 'pageSize')) {
      v.pageSize = p2.paginate ? (normPageSize(v) == null ? 20 : v.pageSize) : null;
    } else {
      v.pageSize = normPageSize(v);
    }
    v.paginate = v.pageSize != null;
    writeDraft(tab, v);
    drawBars();
    emit(tab, 'patch');
  }
  function setCounts(tab, obj) {
    Object.keys(obj || {}).forEach(function (k) { counts[tab][k] = obj[k]; });
    drawBars();
  }
  function onChange(cb) { if (typeof cb === 'function') listeners.push(cb); }
  function emit(tab, reason) {
    listeners.forEach(function (cb) {
      try { cb({ tab: tab, reason: reason, view: active(tab) }); }
      catch (e) { console.error('[views] onChange cb selhal:', e); }
    });
  }
  function setColumnsProvider(fn) { if (typeof fn === 'function') columnsProvider = fn; }
  function defaultColumns(v) {
    if (!columnsProvider || !v) return null;
    try { return columnsProvider(v); } catch (e) { console.error('[views] columnsProvider selhal:', e); return null; }
  }

  /* --- uložení / zahození / smazání ---------------------------------------------------- */
  // Jediné místo, kde se rozhoduje, CO z view jde do DB. Přidáváš pole? Sem.
  function payloadOf(tab, v, orderOverride) {
    return {
      id: v.id, name: v.name, ico: v.ico, note: v.note || '',
      order: (orderOverride === undefined) ? (v.order == null ? null : v.order) : orderOverride,
      builtin: !!v.builtin, tab: tab,
      segment: v.segment, filters: v.filters, sort: v.sort, period: v.period,
      mode: v.mode, paginate: v.paginate, pageSize: v.pageSize, columns: v.columns, sub: v.sub
    };
  }

  async function save(tab) {
    var v = active(tab);
    if (!v) return;
    await ADS.api('prefs_save', { scope: 'all', key: prefKey(v.id), value: payloadOf(tab, v) }, { method: 'POST' });
    v._saved = true;
    baseline[bkey(tab, v.id)] = fingerprint(v);
    savedSnap[bkey(tab, v.id)] = clone(v);
    dropDraft(tab, v.id);
    drawBars();
    emit(tab, 'saved');
  }

  /* T2 — uložení POŘADÍ všech views tabu.
   * Filip: „chci, abych mohl drag and dropovat ty jednotlivý views, abych mohl měnit
   * jejich pořadí." Pořadí je vlastnost SEZNAMU, ale skladujeme ho jako pole `order`
   * v každém view (žádná změna API) → jedno přetažení = zápis všech záložek tabu.
   *
   * ⚠️ Posílá se SNAPSHOT (uložený stav), NE živý objekt: kdyby měl Filip rozdělané
   * neuložené sloupce a jen si přeskládal záložky, publikovalo by mu to rozpracovanou
   * práci celému týmu (views jsou sdílené). Přetažení mění POŘADÍ a nic jiného.
   * Vestavěné views tím dostanou v DB záznam s výchozím obsahem + pořadím; ⋮ → Vrátit
   * na výchozí ho smaže (a vrátí i pořadí z kódu — je to v textu dialogu).
   */
  async function saveOrder(tab) {
    var l = list(tab);
    l.forEach(function (v, i) { v.order = i; });
    drawBars();
    await Promise.all(l.map(function (v, i) {
      var snap = savedSnap[bkey(tab, v.id)] || v;
      return ADS.api('prefs_save', { scope: 'all', key: prefKey(v.id), value: payloadOf(tab, snap, i) }, { method: 'POST' });
    }));
    l.forEach(function (v, i) {
      v._saved = true;
      var s = savedSnap[bkey(tab, v.id)];
      if (s) s.order = i;
    });
  }

  function discard(tab) {
    var v = active(tab);
    if (!v) return;
    dropDraft(tab, v.id);
    reload(tab).then(function () { emit(tab, 'discard'); });
  }

  /* Smazání view / vrácení vestavěného na výchozí.
   * Preferujeme `prefs_delete` (KONSOLIDACE: „přidat jen prefs_delete"). Kdyby ho api.php
   * ještě neuměla (404 = neznámá akce), spadneme na TOMBSTONE = prefs_save s value:null.
   * api.php ho uloží jako literál 'null' a prefs_get ho vrátí jako {value:null} (ověřeno
   * ve zdrojáku: json_decode('null') === null projde podmínkou trim(...) === 'null')
   * → build() ho čte jako „smazáno". Funguje tedy v obou verzích backendu. */
  async function removeStored(id) {
    try {
      await ADS.api('prefs_delete', { scope: 'all', key: prefKey(id) }, { method: 'POST' });
    } catch (err) {
      if (!err || (err.status !== 404 && err.status !== 400)) throw err;
      await ADS.api('prefs_save', { scope: 'all', key: prefKey(id), value: null }, { method: 'POST' });
    }
  }

  async function remove(tab, id) {
    var v = byId(tab, id);
    if (!v) return;
    if (v._saved) await removeStored(id);
    dropDraft(tab, id);
    if (activeId[tab] === id) activeId[tab] = null;
    await reload(tab);
    emit(tab, 'removed');
  }

  /* --- reload (po uložení/smazání) ------------------------------------------------------ */
  function reload(tab) {
    prefsPromise = null;                     // znovu ze serveru (mohl přidat kolega)
    return serverPrefs().then(function (prefs) {
      state[tab] = build(tab, prefs);
      if (!byId(tab, activeId[tab])) activeId[tab] = (state[tab][0] || {}).id || null;
      drawBars();
    });
  }

  /* ================================================================== *
   *  ŘÁDEK ZÁLOŽEK
   * ================================================================== *
   * ⚠️ POČTY V NÁZVECH JSOU PODMÍNKA (Filip): „Na kill (4)" · „Winners (14)".
   *    Bez nich se ztratí dnešní hodnota „vidím všechno naráz při scrollu".
   *    Počet je z API (počet řádků serverového segmentu), NE dopočet na FE.
   *    Dokud nedorazí, svítí „…" — nikdy nepodstrkujeme 0 (to by se četlo jako fakt).
   */
  function registerBar(el, tab) {
    for (var i = 0; i < bars.length; i++) if (bars[i].el === el) { bars[i].tab = tab; drawBars(); return; }
    bars.push({ el: el, tab: tab });
    el.addEventListener('click', onBarClick);
    el.addEventListener('change', onBarChange);          // T5: select stránkování
    wireDrag(el);                                        // T2: přeskládání záložek
    wireTips(el);                                        // T4: tooltip s poznámkou
    drawBars();
  }
  /* ── T2: přeskládání záložek tažením ─────────────────────────────────────────
   * Filip: „chci, abych mohl drag and dropovat ty jednotlivý views, abych mohl
   * měnit jejich pořadí."
   *
   * Pořadí se ukládá do `order` každého view (a tím do prefs, scope=all → sdílené).
   * Přesouvat jde i VESTAVĚNÉ views — `order` je jen další pole view, takže se uloží
   * stejnou cestou jako emoji/poznámka a vestavěné se tím nijak nerozbije.
   *
   * Používá nativní HTML5 drag (atribut draggable="true" je v barHTML) — žádná knihovna.
   */
  function wireDrag(el) {
    el.addEventListener('dragstart', function (e) {
      var t = e.target.closest && e.target.closest('.vtab[data-view]');
      if (!t || t.classList.contains('vt-new')) return;
      var tab = tabOfBar(el);
      dragState = { tab: tab, id: t.dataset.view, el: t };
      t.classList.add('is-drag');
      if (t.parentNode) t.parentNode.classList.add('is-dragging');   // T2: aktivuje .vb-tabs.is-dragging CSS
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.dataset.view); } catch (_) {}
    });

    el.addEventListener('dragover', function (e) {
      if (!dragState) return;
      var over = e.target.closest && e.target.closest('.vtab[data-view]');
      if (!over || over === dragState.el || over.classList.contains('vt-new')) return;
      e.preventDefault();                       // bez toho prohlížeč drop nepovolí
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      // Vlož DOM element před/za podle toho, kde je kurzor vůči středu cílové záložky.
      var r = over.getBoundingClientRect();
      var after = (e.clientX - r.left) > r.width / 2;
      over.parentNode.insertBefore(dragState.el, after ? over.nextSibling : over);
    });

    el.addEventListener('drop', function (e) { if (dragState) e.preventDefault(); });

    el.addEventListener('dragend', function () {
      if (!dragState) return;
      var tab = dragState.tab;
      var host = dragState.el.parentNode;
      dragState.el.classList.remove('is-drag');
      if (host) host.classList.remove('is-dragging');
      dragState = null;                         // MUSÍ padnout PŘED drawBars, jinak se nepřekreslí
      if (!host) { drawBars(); return; }

      // Pořadí přečti z DOMu (uživatel ho tam právě naskládal) a přeskládej podle něj
      // `state[tab]`. saveOrder() si pak sama dopočítá `order = index` a uloží celý tab.
      // ⚠️ NE přes patch(): patch(tab, p) píše VŽDY do AKTIVNÍHO view (bere jen 2 parametry)
      //    → zapsalo by to pořadí všech záložek do jedné. Ověřeno v kódu, ne odhadem.
      var ids = [].slice.call(host.querySelectorAll('.vtab[data-view]'))
        .map(function (n) { return n.dataset.view; })
        .filter(Boolean);
      var cur = state[tab] || [];
      var reordered = [];
      ids.forEach(function (id) {
        for (var i = 0; i < cur.length; i++) if (cur[i].id === id) { reordered.push(cur[i]); return; }
      });
      // Pojistka: co v DOMu nebylo (jiný filtr, race), nesmí ze seznamu zmizet.
      cur.forEach(function (v) { if (reordered.indexOf(v) === -1) reordered.push(v); });
      state[tab] = reordered;

      saveOrder(tab).catch(function (e) {
        console.error('[views] pořadí se nepodařilo uložit:', e);
        if (ADS.toast) ADS.toast('Pořadí záložek se nepodařilo uložit', 'error');
      });
    });
  }

  /* ── T4: bublina s poznámkou při najetí na název view ────────────────────────
   * Filip: „aby měl i poznámku, která se ukáže, když najedu na název toho view."
   * Vlastní bublina (ne nativní `title`): title má ~1,5 s prodlevu, nejde stylovat
   * a u záložky s ⋮ menu vyskakoval přes něj. Proto v barHTML `title` schválně není.
   */
  function wireTips(el) {
    el.addEventListener('mouseover', function (e) {
      var t = e.target.closest && e.target.closest('.vtab.has-note[data-view]');
      if (!t) return;
      var v = byId(tabOfBar(el), t.dataset.view);
      if (!v || !v.note) return;
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'vtip';                 // CSS zná jen .vtip (ne .vb-tip)
        tipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tipEl);
      }
      tipEl.textContent = v.note;
      var r = t.getBoundingClientRect();
      tipEl.style.display = 'block';              // pro měření šířky (opacity řeší .is-on)
      // Nad záložku a vycentrovat; u kraje obrazovky přisadit dovnitř, ať to nevyteče.
      var w = tipEl.offsetWidth;
      var x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      tipEl.style.left = Math.round(x) + 'px';
      tipEl.style.top  = Math.round(r.top - tipEl.offsetHeight - 8) + 'px';
      tipEl.classList.add('is-on');               // viditelnost dělá .vtip.is-on, ne display
    });
    el.addEventListener('mouseout', hideTip);
    el.addEventListener('mousedown', hideTip);
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('is-on'); }

  /** Ke kterému tabu patří tenhle bar element? (bars[] je registr mountů) */
  function tabOfBar(el) {
    for (var i = 0; i < bars.length; i++) if (bars[i].el === el) return bars[i].tab;
    return TABS[0];
  }

  function drawBars() {
    // ⚠️ Během tažení se řádek NEPŘEKRESLUJE — innerHTML by zahodil element, který
    // uživatel drží v ruce, a drag by umřel uprostřed. Po dragend se překreslí.
    if (dragState) return;
    bars.forEach(function (b) {
      if (!b.el || !b.el.isConnected) return;
      b.el.innerHTML = barHTML(b.tab);
    });
  }
  function countTxt(tab, v) {
    var c = counts[tab] ? counts[tab][v.id] : undefined;
    if (c === undefined || c === null) return '<b class="vt-n vt-wait">…</b>';
    return '<b class="vt-n">' + c + '</b>';
  }

  function barHTML(tab) {
    var v = active(tab);
    var dirty = isDirty(tab);
    var html = '<div class="vb-rail">';
    html += '<div class="vb-tabs" role="tablist" aria-label="Pohledy na kreativy">';
    list(tab).forEach(function (x) {
      var on = v && x.id === v.id;
      // `title` tu SCHVÁLNĚ NENÍ: T4 chce vlastní bublinu s poznámkou a nativní
      // tooltip by k ní po 1,5 s vyskočil druhý, přes ni. Obsah nese vtip (wireTips).
      html += '<button class="vtab' + (on ? ' is-on' : '') + (x.note ? ' has-note' : '') + '" ' +
        'type="button" role="tab" draggable="true" ' +
        'aria-selected="' + (on ? 'true' : 'false') + '" data-view="' + esc(x.id) + '">' +
        (x.ico ? '<span class="vt-i" aria-hidden="true">' + esc(x.ico) + '</span>' : '') +
        '<span class="vt-t">' + esc(x.name) + '</span>' +
        countTxt(tab, x) +
        (x.mode === 'tiles' ? '<span class="vt-m" title="zobrazeno jako dlaždice">⊞</span>' : '') +
        (on ? '<span class="vt-menu" data-act="menu" title="Možnosti view" role="button" tabindex="0">⋮</span>' : '') +
        '</button>';
    });
    html += '<button class="vtab vt-new" type="button" data-act="new" title="Vytvoř si vlastní pohled — třeba „CPL nad 500 Kč, spend nad 5 000 Kč"">+ Nové view</button>';
    html += '</div>';

    html += '<div class="vb-right">';
    // T5: výběr počtu řádků je teď DOLE v liště tabulky (Tabulator paginationSizeSelector),
    // ne tady nahoře (Filip: „řádkování dej dolů do lišty"). Zůstává jen v editoru view.
    if (dirty) {
      html += '<span class="vb-dirty" title="Rozložení sloupců / řazení / stránkování se změnilo a zatím není uložené pro tým. Drží se zatím jen v tomhle prohlížeči.">● neuloženo</span>' +
        '<button class="vb-btn vb-save" type="button" data-act="save" title="Uloží tenhle pohled pro celý tým (views jsou sdílené).">💾 Uložit view</button>' +
        '<button class="vb-btn" type="button" data-act="discard" title="Zahodí neuložené změny a vrátí poslední uložený stav.">↺ Zahodit</button>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function onBarClick(e) {
    var bar = e.currentTarget;
    var tabOf = null;
    bars.forEach(function (b) { if (b.el === bar) tabOf = b.tab; });
    if (!tabOf) return;

    var act = e.target.closest('[data-act]');
    if (act) {
      var a = act.getAttribute('data-act');
      if (a === 'menu') { e.stopPropagation(); openMenu(tabOf, act); return; }
      if (a === 'new') { openEditor(tabOf, null); return; }
      if (a === 'save') { doSave(tabOf, act); return; }
      if (a === 'discard') { discard(tabOf); return; }
    }
    var t = e.target.closest('.vtab[data-view]');
    if (t) {
      // T3 bonus: klik na ikonu UŽ aktivní záložky → otevři editor (emoji picker + poznámka).
      // U neaktivní jen přepni (dvě různé akce na jeden klik by mátly).
      if (e.target.closest('.vt-i') && activeId[tabOf] === t.getAttribute('data-view')) {
        var av = byId(tabOf, t.getAttribute('data-view'));
        if (av) { openEditor(tabOf, av, 'rename'); return; }
      }
      setActive(tabOf, t.getAttribute('data-view'));
    }
  }

  /* T5 — změna selectu „Řádků" (10/20/50/100/Vše). Bez téhle funkce hodí registerBar
   * ReferenceError na řádku `el.addEventListener('change', onBarChange)` a shodí s sebou
   * wireDrag (T2), wireTips (T4) i wireHiddenBar (S1). Proto MUSÍ existovat, i kdyby jen
   * jako no-op. `patch()` drží pageSize/paginate v sync a překreslí. */
  function onBarChange(e) {
    var sel = e.target.closest && e.target.closest('select[data-act="psize"]');
    if (!sel) return;
    var tab = tabOfBar(e.currentTarget); if (!tab) return;
    var val = sel.value === 'all' ? null : parseInt(sel.value, 10);
    patch(tab, { pageSize: val });
  }

  function doSave(tab, btn) {
    btn.disabled = true; btn.textContent = 'Ukládám…';
    save(tab)
      .then(function () { if (ADS.toast) ADS.toast('View uloženo pro celý tým ✓', 'success'); })
      .catch(function (err) {
        if (ADS.toast) ADS.toast('Uložení view selhalo: ' + errMsg(err), 'error');
        drawBars();
      });
  }

  /* --- ⋮ menu aktivního view ----------------------------------------------------------- */
  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('mousedown', onDocDown, true); } }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function openMenu(tab, anchor) {
    closeMenu();
    var v = active(tab);
    if (!v) return;
    menuEl = document.createElement('div');
    menuEl.className = 'vmenu';
    var items = [];
    items.push(['rename', '✎ Přejmenovat']);
    items.push(['edit', '⚙ Upravit view (segment, filtry…)']);
    items.push(['dup', '⧉ Duplikovat jako nové view']);
    if (v.builtin) {
      items.push(['reset', '↺ Vrátit na výchozí']);
    } else {
      items.push(['del', '🗑 Smazat view']);
    }
    menuEl.innerHTML = items.map(function (it) {
      return '<button type="button" data-m="' + it[0] + '">' + esc(it[1]) + '</button>';
    }).join('');
    document.body.appendChild(menuEl);
    var r = anchor.getBoundingClientRect();
    var left = Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 8);
    menuEl.style.left = Math.max(8, left) + 'px';
    menuEl.style.top = (r.bottom + 6) + 'px';
    menuEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-m]'); if (!b) return;
      var m = b.getAttribute('data-m');
      closeMenu();
      if (m === 'rename') openEditor(tab, v, 'rename');
      else if (m === 'edit') openEditor(tab, v, 'edit');
      else if (m === 'dup') openEditor(tab, v, 'dup');
      else if (m === 'reset') confirmReset(tab, v);
      else if (m === 'del') confirmDelete(tab, v);
    });
    setTimeout(function () { document.addEventListener('mousedown', onDocDown, true); }, 0);
  }

  function confirmReset(tab, v) {
    dialog({
      title: 'Vrátit „' + v.name + '" na výchozí?',
      body: '<p class="vd-p">Zahodí se uložené i neuložené úpravy tohohle vestavěného pohledu ' +
        '(sloupce, šířky, skryté sloupce, řazení) a vrátí se stav z kódu. Ostatní views to nijak neovlivní.</p>',
      ok: 'Vrátit na výchozí', danger: true
    }).then(function (r) {
      if (!r) return;
      remove(tab, v.id)
        .then(function () { if (ADS.toast) ADS.toast('View „' + v.name + '" je zpátky na výchozím ✓', 'success'); })
        .catch(function (err) { if (ADS.toast) ADS.toast('Nepodařilo se vrátit: ' + errMsg(err), 'error'); });
    });
  }
  function confirmDelete(tab, v) {
    dialog({
      title: 'Smazat view „' + v.name + '"?',
      body: '<p class="vd-p">Views jsou <b>sdílené</b> — zmizí i Vojtovi. Vestavěné pohledy ' +
        '(Na kill, Winners, Top spenders, Nejnovější, All-time) tím nezmizí.</p>',
      ok: 'Smazat', danger: true
    }).then(function (r) {
      if (!r) return;
      remove(tab, v.id)
        .then(function () { if (ADS.toast) ADS.toast('View smazáno ✓', 'success'); })
        .catch(function (err) { if (ADS.toast) ADS.toast('Smazání selhalo: ' + errMsg(err), 'error'); });
    });
  }

  /* ================================================================== *
   *  DIALOGY
   * ================================================================== */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'ads-modal-ov vd-ov';
      ov.innerHTML =
        '<div class="ads-modal vd-modal" role="dialog" aria-modal="true">' +
        '<div class="am-title">' + esc(opts.title) + '</div>' +
        (opts.body || '') +
        '<div class="am-actions">' +
        '<button class="btn-ghost" type="button" data-x="0">Zrušit</button>' +
        '<button class="' + (opts.danger ? 'btn-danger' : 'vd-primary') + '" type="button" data-x="1">' + esc(opts.ok || 'OK') + '</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      // opts.wire(ov) — navázání listenerů na živý DOM dialogu (T6: zvýraznění zaškrtnutých
      // funnelů). Volá se AŽ po appendChild, jinak by querySelector uvnitř nic nenašel.
      if (opts.wire) opts.wire(ov);
      function close(val) { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        // Enter potvrzuje jen z jednořádkových polí — v textarea by ubral řádkování.
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); }
      }
      function ok() {
        var val = opts.read ? opts.read(ov) : true;
        if (val === false) return;              // validace neprošla → dialog nechat otevřený
        close(val);
      }
      ov.addEventListener('click', function (e) {
        if (e.target === ov) return close(null);
        var b = e.target.closest('button[data-x]'); if (!b) return;
        if (b.getAttribute('data-x') === '1') ok(); else close(null);
      });
      document.addEventListener('keydown', onKey);
      var f = ov.querySelector('input,select');
      if (f) setTimeout(function () { f.focus(); f.select && f.select(); }, 30);
    });
  }

  /* Editor view: „+ Nové view" / přejmenovat / duplikovat.
   * Filipův příklad z KONSOLIDACE: „Zásnubní, ROAS < 2, spend > 5k" → proto pole
   * funnel + ROAS max/min + spend min nad vybraným SERVEROVÝM segmentem. */
  function openEditor(tab, base, mode) {
    mode = mode || 'new';
    var v = base ? clone(base) : {
      id: '', name: '', ico: '⭐', builtin: false, tab: tab,
      segment: (tab === 'earrings' ? 'all' : 'all'), filters: {}, sort: [{ col: 'spend', dir: 'desc' }],
      period: null, mode: 'table', paginate: true, columns: null, sub: ''
    };
    var f = v.filters || {};
    var renameOnly = (mode === 'rename');
    var funnels = (Array.isArray(ADS.FUNNELS) ? ADS.FUNNELS : []).slice();
    // Filip: „nepřiřazené" (funnel '---') v ADS.FUNNELS není → doplň ho jako poslední volbu,
    // ať jde filtrovat i kreativy bez funnelu.
    if (funnels.indexOf('---') < 0) funnels.push('---');

    var title = renameOnly ? 'Přejmenovat view' : (mode === 'dup' ? 'Duplikovat view' : (mode === 'edit' ? 'Upravit view' : 'Nové view'));
    var prefillName = (renameOnly || mode === 'dup' || mode === 'edit') ? v.name + (mode === 'dup' ? ' (kopie)' : '') : '';
    var body =
      '<p class="vd-p">' + (renameOnly
        ? 'Změní se jen název záložky. Filtry ani sloupce se nedotknou.'
        : (mode === 'edit'
          ? 'Úprava tohohle view — segment, filtry i zobrazení. Views jsou <b>sdílené pro celý tým</b>.'
          : 'Pohled = výběr ze serveru (segment) + tvoje doplňkové filtry. Views jsou <b>sdílené pro celý tým</b>.')) + '</p>' +
      '<label class="vd-l">Název<input class="vd-in" id="vd-name" type="text" maxlength="40" value="' + esc(prefillName) + '" placeholder="např. Drahé leady"></label>';

    /* T3 — ikona záložky. Filip: JEN vlastní vstup (bez gridu předvoleb) + náhled. */
    body +=
      '<label class="vd-l">Ikona záložky <span class="vd-hint">napiš emoji (nebo nech prázdné)</span>' +
        '<div class="vde-head">' +
          '<span class="vde-now' + (v.ico ? '' : ' is-empty') + '" id="vde-now">' + esc(v.ico || '') + '</span>' +
          '<input class="vd-in vde-custom" id="vde-custom" type="text" maxlength="8" placeholder="✨" value="' + esc(v.ico || '') + '">' +
        '</div>' +
      '</label>';

    if (!renameOnly) {
      body +=
        '<label class="vd-l">Základ (počítá server)' +
        '<select class="vd-in" id="vd-seg">' +
        Object.keys(SEGMENT_LABELS).filter(function (s) {
          return tab === 'rings' ? true : (s !== 'new' && s !== 'alltime');   // náušnice: server tyhle segmenty nenabízí
        }).map(function (s) {
          return '<option value="' + s + '"' + (v.segment === s ? ' selected' : '') + '>' + esc(SEGMENT_LABELS[s]) + '</option>';
        }).join('') +
        '</select></label>' +
        /* ★ T6 — funnel = MULTIPLE SELECT, na PLNOU ŠÍŘKU (Filip: půl šířky se muselo scrollovat).
         * Nic zaškrtnuto = VŠECHNY. */
        (tab === 'rings'
          ? '<div class="vd-l vd-fn vd-fn-full"><span class="vd-fn-h">Funnel <em>nic nezaškrtnuto = všechny</em></span>' +
            '<div class="vd-fn-box" id="vd-funnel">' +
            funnels.map(function (x) {
              var on = Array.isArray(f.funnel) ? f.funnel.indexOf(x) > -1 : (f.funnel === x);
              var lbl = (x === '---') ? '--- (nepřiřazené)' : x;
              return '<label class="vd-fn-i' + (on ? ' is-on' : '') + '">' +
                     '<input type="checkbox" value="' + esc(x) + '"' + (on ? ' checked' : '') + '>' +
                     esc(lbl) + '</label>';
            }).join('') +
            '</div></div>'
          : '') +
        '<div class="vd-grid">' +
        // ROAS model MAX zrušen (Filip: nepotřebuje) — jen min + Spend min.
        '<label class="vd-l">ROAS model min<input class="vd-in" id="vd-roasmin" type="number" step="0.1" min="0" placeholder="např. 3" value="' + (f.roas_min != null ? esc(f.roas_min) : '') + '"></label>' +
        '<label class="vd-l">Spend min (Kč)<input class="vd-in" id="vd-spendmin" type="number" step="100" min="0" placeholder="např. 5000" value="' + (f.spend_min != null ? esc(f.spend_min) : '') + '"></label>' +
        '</div>' +
        '<label class="vd-l vd-chk"><input type="checkbox" id="vd-active"' + (f.active_only ? ' checked' : '') + '> Zobrazit <b>jen aktivní</b> reklamy' +
        '<span class="vd-hint">skryje kreativy, které už nikde neběží (všechny ady PAUSED/vypnuté)</span></label>' +
        '<label class="vd-l vd-chk"><input type="checkbox" id="vd-tiles"' + (v.mode === 'tiles' ? ' checked' : '') + '> Zobrazit jako <b>dlaždice</b> místo tabulky' +
        '<span class="vd-hint" id="vd-tiles-hint">dlaždice umí jen základ „Nejnovější" — jinde by ukazovaly jiná data, než záložka slibuje</span></label>' +
        // Stránkování jako SELECT (stejně jako v baru nahoře): 10/20/50/100/Vše.
        '<label class="vd-l">Řádků na stránku' +
        '<select class="vd-in" id="vd-pagesize">' +
        PAGE_SIZES.map(function (p) {
          return '<option value="' + p + '"' + (v.pageSize === p ? ' selected' : '') + '>' + p + '</option>';
        }).join('') +
        '<option value="all"' + (v.pageSize == null ? ' selected' : '') + '>Vše</option>' +
        '</select></label>';
    }

    /* T4 — poznámka POSLEDNÍ pole (Filip). Ukáže se v bublině při najetí na název záložky. */
    body +=
      '<label class="vd-l">Poznámka <span class="vd-hint">ukáže se v bublině při najetí na název záložky</span>' +
        '<textarea class="vd-in" id="vd-note" maxlength="240" rows="2" placeholder="např. proč tenhle pohled existuje / na co si dát pozor">' + esc(v.note || '') + '</textarea>' +
      '</label>';

    dialog({
      title: title, ok: renameOnly ? 'Přejmenovat' : (mode === 'edit' ? 'Uložit změny' : 'Vytvořit view'), body: body,
      wire: function (ov) {
        var box = ov.querySelector('#vd-funnel');
        if (box) box.addEventListener('change', function (e) {
          var i = e.target;
          if (i && i.type === 'checkbox') i.closest('.vd-fn-i').classList.toggle('is-on', i.checked);
        });
        // T3 ikona — jen vlastní vstup → náhled .vde-now. Text se STRIPUJE hned při psaní,
        // ať v poli nezůstane nic než emoji (Filip: text se dal vložit i uložit).
        var now = ov.querySelector('#vde-now');
        var custom = ov.querySelector('#vde-custom');
        if (custom) custom.addEventListener('input', function () {
          var ic = normIco(custom.value);
          if (custom.value !== ic) custom.value = ic;   // vyhoď vše, co není emoji
          if (now) { now.textContent = ic; now.classList.toggle('is-empty', !ic); }
        });
      },
      read: function (ov) {
        var name = (ov.querySelector('#vd-name').value || '').trim();
        if (!name) { ADS.toast && ADS.toast('Vyplň název view.', 'warn'); return false; }
        var out = { name: name };
        var customEl = ov.querySelector('#vde-custom');
        out.ico = normIco(customEl ? customEl.value : '') || '⭐';
        var noteEl = ov.querySelector('#vd-note');
        if (noteEl) out.note = (noteEl.value || '').trim();
        if (!renameOnly) {
          out.segment = ov.querySelector('#vd-seg').value;
          out.filters = {};
          // T6: sesbírej zaškrtnuté funnely → POLE. Prázdné pole klíč vůbec nezaloží (= všechny).
          var fnBox = ov.querySelector('#vd-funnel');
          if (fnBox) {
            var picked = [].slice.call(fnBox.querySelectorAll('input:checked')).map(function (i) { return i.value; });
            if (picked.length) out.filters.funnel = picked;
          }
          var rmin = num(ov.querySelector('#vd-roasmin').value);
          var smin = num(ov.querySelector('#vd-spendmin').value);
          if (rmin != null) out.filters.roas_min = rmin;
          if (smin != null) out.filters.spend_min = smin;
          var actEl = ov.querySelector('#vd-active');
          if (actEl && actEl.checked) out.filters.active_only = true;
          out.mode = ov.querySelector('#vd-tiles').checked ? 'tiles' : 'table';
          // pageSize ze selectu (10/20/50/100/Vše); paginate je jeho odvozenina.
          var psEl = ov.querySelector('#vd-pagesize');
          var psv = psEl ? psEl.value : '20';
          out.pageSize = (psv === 'all') ? null : parseInt(psv, 10);
          out.paginate = out.pageSize != null;
          out.period = (out.segment === 'alltime') ? 'alltime' : null;
        }
        return out;
      }
    }).then(function (r) {
      if (!r) return;
      if (renameOnly) {
        var av = byId(tab, v.id);
        if (!av) return;
        av.name = r.name;
        if (r.ico != null) av.ico = r.ico;          // T3: změna ikony ze stejného dialogu
        if (r.note != null) av.note = r.note;        // T4: poznámka do bubliny
        // Přejmenování je změna view → ať se rovnou uloží (jinak by zůstalo jen lokálně
        // a kolega by ho neviděl; sdílené views = sdílené názvy).
        setActive(tab, av.id, true);
        save(tab)
          .then(function () { if (ADS.toast) ADS.toast('Přejmenováno ✓', 'success'); })
          .catch(function (err) { if (ADS.toast) ADS.toast('Přejmenování selhalo: ' + errMsg(err), 'error'); });
        return;
      }
      // Edit = uložit ZPĚT do stejného view (ne kopie). Sloupce (columns) necháme být —
      // ty se ladí přímo v tabulce, tady měníme segment/filtry/zobrazení.
      if (mode === 'edit') {
        var ev = byId(tab, v.id);
        if (!ev) return;
        ev.name = r.name; ev.ico = r.ico || '⭐'; ev.note = r.note || '';
        ev.segment = r.segment; ev.filters = r.filters; ev.period = r.period;
        ev.mode = r.mode; ev.paginate = r.paginate; ev.pageSize = r.pageSize;
        ev.sub = filtersSub(r.segment, r.filters);
        setActive(tab, ev.id, true);
        baseline[bkey(tab, ev.id)] = fingerprint(ev);
        save(tab)
          .then(function () { if (ADS.toast) ADS.toast('View „' + ev.name + '" upraveno ✓', 'success'); })
          .catch(function (err) { if (ADS.toast) ADS.toast('Uložení změn selhalo: ' + errMsg(err), 'error'); });
        drawBars();
        emit(tab, 'edited');
        return;
      }
      var nv = {
        id: uniqueId(tab, slugify(r.name)), name: r.name, ico: r.ico || '⭐', note: r.note || '', builtin: false, tab: tab,
        segment: r.segment, filters: r.filters, period: r.period,
        sort: (mode === 'dup' && v.sort && v.sort.length) ? v.sort : [{ col: 'spend', dir: 'desc' }],
        mode: r.mode, paginate: r.paginate, pageSize: r.pageSize,
        columns: (mode === 'dup') ? v.columns : null,
        sub: filtersSub(r.segment, r.filters)
      };
      var sv = sanitize(nv, tab);
      state[tab].push(sv);
      activeId[tab] = sv.id;
      baseline[bkey(tab, sv.id)] = fingerprint(sv);
      lsSet('view-active:' + tab, sv.id);
      save(tab)
        .then(function () { if (ADS.toast) ADS.toast('View „' + sv.name + '" vytvořeno ✓', 'success'); })
        .catch(function (err) { if (ADS.toast) ADS.toast('Uložení view selhalo: ' + errMsg(err), 'error'); });
      drawBars();
      emit(tab, 'created');
    });

    // Dlaždice jdou jen nad segmentem „new" → checkbox podle výběru zamkni (a řekni proč).
    setTimeout(function () {
      var seg = document.querySelector('#vd-seg');
      var chk = document.querySelector('#vd-tiles');
      if (!seg || !chk) return;
      function sync() {
        var ok = !!TILES_SEGMENTS[seg.value];
        chk.disabled = !ok;
        if (!ok) chk.checked = false;
        var h = document.querySelector('#vd-tiles-hint');
        if (h) h.style.display = ok ? 'none' : '';
      }
      seg.addEventListener('change', sync);
      sync();
    }, 40);
  }

  function filtersSub(segment, f) {
    var p = [];
    // T6: funnel může být pole. Vypisovat pět názvů pod sebe je nečitelné → od 3 shrň počtem.
    if (f.funnel) {
      var fa = Array.isArray(f.funnel) ? f.funnel : [f.funnel];
      if (fa.length === 1) p.push(fa[0]);
      else if (fa.length === 2) p.push(fa.join(' + '));
      else if (fa.length) p.push(fa.length + ' funnelů');
    }
    if (f.roas_max != null) p.push('ROAS < ' + f.roas_max);
    if (f.roas_min != null) p.push('ROAS ≥ ' + f.roas_min);
    if (f.spend_min != null) p.push('spend ≥ ' + f.spend_min + ' Kč');
    if (f.active_only) p.push('jen aktivní');
    return p.length ? p.join(' · ') : (SEGMENT_LABELS[segment] || '');
  }

  /* ================================================================== *
   *  START
   * ================================================================== */
  var ready = serverPrefs().then(function (prefs) {
    TABS.forEach(function (tab) {
      state[tab] = build(tab, prefs);
      var saved = lsGet('view-active:' + tab);
      activeId[tab] = (saved && byId(tab, saved)) ? saved : ((state[tab][0] || {}).id || null);
    });
    drawBars();
    // Aktivní view je hotové AŽ TEĎ → řekni to tabulce.
    //
    // PROČ: tables.js sice dělá `ADS.views.ready.then(() => renderTab(tab))`, ale ten render
    // proběhne dřív, než je `active(tab)` k dispozici, a renderTab tiše skončí na `if (!view) return`
    // → v sekci zůstane jen scaffold (474 znaků) a Filip vidí PRÁZDNOU sekci Kreativy.
    // Naměřeno 17. 7.: po ručním vyvolání téhož renderTab naskočí 100 930 znaků / 13 řádků.
    // Emit je stejný kanál, kterým jede přepínání views (a ten funguje), takže tu nevzniká
    // druhá cesta — jen se použije ta ověřená. renderTokens v tables.js hlídají dvojí render.
    TABS.forEach(function (tab) { emit(tab, 'ready'); });
  });

  // Fallback: kdyby prefs_get visel, ať UI nečeká na nic — vestavěné views hned.
  TABS.forEach(function (tab) {
    if (!state[tab].length) {
      state[tab] = builtins(tab);
      state[tab].forEach(function (v) { baseline[bkey(tab, v.id)] = fingerprint(v); });
      var saved = lsGet('view-active:' + tab);
      activeId[tab] = (saved && byId(tab, saved)) ? saved : state[tab][0].id;
    }
  });

  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  ADS.views = {
    ready: ready,
    list: list,
    active: active,
    byId: byId,
    setActive: setActive,
    patch: patch,
    isDirty: isDirty,
    save: save,
    discard: discard,
    remove: remove,
    setCounts: setCounts,
    onChange: onChange,
    renderBar: registerBar,
    redrawBar: drawBars,
    setColumnsProvider: setColumnsProvider,
    defaultColumns: defaultColumns,
    canTiles: canTiles,
    SEGMENT_LABELS: SEGMENT_LABELS
  };

  injectStyles();

  /* ================================================================== *
   *  STYLY (light, stejný jazyk jako zbytek nástroje — žádná systémová tlačítka)
   * ================================================================== *
   * ⚠️ Poučení z minulých iterací (C1 „chipy odporné", I1 „šipky šeredné"):
   * element BEZ CSS = defaultní systémové tlačítko se šedým 3D rámečkem = „Windows 2000".
   * Každá třída níž proto MUSÍ mít pravidlo. */
  function injectStyles() {
    if (document.getElementById('ads-views-css')) return;
    var css = `
.ads-viewbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.ads-viewbar .vb-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.ads-viewbar .vb-right{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto}

/* Záložka = pilulka. Aktivní = plná tmavá (stejný jazyk jako .fchip.is-on v tables.js). */
.vtab{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;margin:0;
  background:#fff;color:#2c2b28;border:1px solid #eceae3;border-radius:999px;
  font-family:inherit;font-size:13px;font-weight:650;line-height:1;letter-spacing:-.005em;
  cursor:pointer;-webkit-appearance:none;appearance:none;white-space:nowrap;
  transition:background .12s,border-color .12s,color .12s,box-shadow .12s}
.vtab:hover{background:#faf8f4;border-color:#ddd8cc}
.vtab:focus-visible{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16)}
.vtab .vt-i{font-size:13px;line-height:1}
.vtab .vt-n{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:19px;padding:0 6px;
  background:#f4f1ea;color:#8d897f;border-radius:999px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.vtab .vt-n.vt-wait{color:#b8b3a8;letter-spacing:1px}
.vtab .vt-m{font-size:10px;color:#a8a49a}
.vtab.is-on{background:#2c2b28;border-color:#2c2b28;color:#fff;box-shadow:0 1px 2px rgba(30,25,15,.14)}
.vtab.is-on:hover{background:#1f1e1c;border-color:#1f1e1c}
.vtab.is-on .vt-n{background:rgba(255,255,255,.2);color:#fff}
.vtab.is-on .vt-m{color:rgba(255,255,255,.6)}
.vtab .vt-menu{display:inline-flex;align-items:center;justify-content:center;width:20px;height:22px;margin:0 -5px 0 1px;
  border-radius:6px;font-size:14px;font-weight:700;color:rgba(255,255,255,.65);cursor:pointer;line-height:1}
.vtab .vt-menu:hover{background:rgba(255,255,255,.16);color:#fff}
.vtab.vt-new{border-style:dashed;color:#8d897f;font-weight:600}
.vtab.vt-new:hover{color:#2c2b28;border-color:#c9a9b0;border-style:solid}

.ads-viewbar .vb-dirty{font-size:11.5px;font-weight:700;color:#b5651d;white-space:nowrap;cursor:help}
.ads-viewbar .vb-btn{height:30px;padding:0 11px;background:#fff;color:#2c2b28;border:1px solid #ddd8cc;
  border-radius:8px;font-family:inherit;font-size:11.5px;font-weight:650;cursor:pointer;white-space:nowrap;
  transition:background .12s,border-color .12s}
.ads-viewbar .vb-btn:hover{background:#f4f1ea;border-color:#c9a9b0}
.ads-viewbar .vb-btn:focus-visible{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16)}
.ads-viewbar .vb-btn:disabled{opacity:.6;cursor:progress}
.ads-viewbar .vb-save{background:#2c2b28;border-color:#2c2b28;color:#fff}
.ads-viewbar .vb-save:hover{background:#1f1e1c;border-color:#1f1e1c}

/* ⋮ menu */
.vmenu{position:fixed;z-index:10002;min-width:220px;padding:5px;background:#fff;border:1px solid #eceae3;
  border-radius:11px;box-shadow:0 12px 34px rgba(30,25,15,.2);display:flex;flex-direction:column;gap:2px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.vmenu button{display:block;width:100%;text-align:left;padding:8px 10px;background:transparent;border:0;
  border-radius:8px;font-family:inherit;font-size:13px;font-weight:550;color:#2c2b28;cursor:pointer;line-height:1.3}
.vmenu button:hover{background:#faf8f4}

/* dialog (staví na .ads-modal z tables.js — tady jen doplňky) */
.vd-modal{max-width:520px}
.vd-p{margin:6px 0 14px;font-size:12.5px;line-height:1.55;color:#6b675f}
.vd-l{display:block;font-size:11.5px;font-weight:700;color:#6b675f;margin:0 0 11px;text-transform:none}
.vd-in{display:block;width:100%;box-sizing:border-box;margin-top:5px;height:36px;padding:0 10px;
  border:1px solid #e6e3db;border-radius:9px;background:#fff;font-family:inherit;font-size:13px;font-weight:500;color:#2c2b28}
select.vd-in{height:36px;padding:0 8px;-webkit-appearance:none;appearance:none;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,#8d897f 50%),linear-gradient(135deg,#8d897f 50%,transparent 50%);
  background-position:calc(100% - 15px) 15px,calc(100% - 10px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.vd-in:focus{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.14)}
.vd-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}
.vd-chk{display:flex;flex-wrap:wrap;align-items:center;gap:7px;font-weight:600;color:#2c2b28;font-size:12.5px}
.vd-chk input{width:15px;height:15px;margin:0;accent-color:#a86a78;cursor:pointer}
.vd-chk b{font-weight:750}
.vd-hint{flex:1 1 100%;font-size:11px;font-weight:400;color:#a8a49a;line-height:1.45}
.vd-primary{background:#2c2b28;color:#fff;border:1px solid #2c2b28;border-radius:9px;padding:8px 18px;
  font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.vd-primary:hover{background:#1f1e1c}
@media(max-width:640px){.vd-grid{grid-template-columns:1fr}}
`;
    var style = document.createElement('style');
    style.id = 'ads-views-css';
    style.textContent = css;
    document.head.appendChild(style);
  }
}
