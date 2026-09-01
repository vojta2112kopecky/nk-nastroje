/* =====================================================================
 * NK Ads Dashboard — tables.js
 * Frontend TABULKA (Tabulator v6). Konzumuje POUZE window.ADS + ADS.views.
 *
 * ⚠️ KONSOLIDACE (KONSOLIDACE.md, schváleno Filipem 16. 7.) — POZOR, TOHLE SE ZMĚNILO:
 * Dřív tu bylo PĚT samostatných tabulek (kill / winners / top spenders / nejnovější /
 * all-time), každá s vlastní instancí Tabulatoru. Filip: „jestli tolik těch tabulek není
 * overkill… spíš bych to měl jako záložky, které mění views." Měl pravdu — všechny jely
 * z JEDNOHO API volání a lišily se jen filtrem + řazením + obdobím + sloupci.
 *
 * DNES: **jedna instance Tabulatoru na tab**, nad ní řádek záložek (views.js).
 *   prsteny  → mount #creatives-rings     (v .sec[data-sec=creatives])
 *   náušnice → mount #creatives-earrings  (v .sec[data-sec=ear-creatives])
 * Sekce v index.html (#section-kill, #section-winners, #topspenders, #alltime) tenhle
 * modul při startu SÁM PŘESTAVÍ (restructureDOM) — index.html se kvůli tomu měnit nemusí.
 * #newest zůstává naživu (parkuje se do těla sekce) → dlaždice dál renderuje newest.js.
 * #charts-root / #charts-earrings se NEDOTÝKÁME (patří charts.js).
 *
 * Data: ADS.api('creatives',{from,to,tab,segment}) · ADS.api('alltime',{tab,days}).
 * ⚠️ SEGMENT SE POČÍTÁ NA SERVERU. FE si predikát „kdo je winner" NIKDY nedělá sám —
 *    16. 7. přesně tohle stálo za rozporem „dlaždice 13 winnerů vs. tabulka 15".
 *    Počty v záložkách jsou proto délky serverových odpovědí, ne dopočet.
 *
 * Kontrakt window.ADS (shell ho definuje):
 *   state{from,to,tab,user,preset} · TH{...prahy} · FUNNELS · BQ_RANGE{min,max} · USERS
 *   api(action,params,opts) · fmt{money,int,roas,pct,date} · semafor(roas)->barva
 *   openPreview(ad) · toast(msg,type) · el(sel) · bus:EventTarget · onReady(cb)
 * Volitelně (když je jiný modul poskytne, sáhneme po nich; jinak fallback):
 *   ADS.views (views.js — POVINNÉ, doloadujeme si ho sami) · ADS.renderTiles · ADS.thumbs
 *
 * Vlastní styly injektuji zde (styles.css patří shellu) — light, krémově-bílá,
 * žádná zlatá; jemné stíny, zaoblení, hover stavy.
 * ===================================================================== */
(function boot(){
  /* views.js je TVRDÁ závislost. Aby integrátor nemusel sahat do index.html (a hlavně
   * aby to nespadlo, kdyby na to zapomněl), doloadujeme si ho sami — se STEJNÝM ?v=
   * stampem, jaký má tables.js, ať platí cache-busting z index.html (nález #7).
   * Když už ho index.html načítá, nic se neděje: druhý <script> nepřidáme. */
  var me = document.currentScript;
  var ver = (me && me.src && (me.src.match(/[?&]v=(\d+)/) || [])[1]) || '';
  function haveViewsTag(){
    var s = document.getElementsByTagName('script');
    for (var i = 0; i < s.length; i++) if (/(^|\/)views\.js(\?|$)/.test(s[i].getAttribute('src') || '')) return true;
    return false;
  }
  if (!haveViewsTag() && !(window.ADS && window.ADS.views)){
    var t = document.createElement('script');
    t.src = 'views.js' + (ver ? '?v=' + ver : '');
    t.async = false;                    // ať doběhne před prvním onReady
    (document.head || document.documentElement).appendChild(t);
  }

  (function wait(tries){
    if (window.ADS && typeof window.ADS.onReady === 'function') { main(window.ADS); }
    else if (tries < 60) { setTimeout(function(){ wait(tries + 1); }, 100); }
    else { console.error('[tables] window.ADS není dostupné — tabulky se nevykreslí.'); }
  })(0);
})();

function main(ADS) {
  'use strict';

  if (typeof window.Tabulator === 'undefined') {
    console.error('[tables] Tabulator (vendor) není načten.');
    return;
  }

  var F = ADS.fmt || {};

  // Čeština pro Tabulator (stránkování G1 by jinak bylo anglicky: „Showing 1 to 20 of 45 rows").
  var TAB_LANGS = {
    cs: {
      data: { loading: 'Načítám…', error: 'Chyba' },
      pagination: {
        page_size: 'Řádků na stránku', page_title: 'Stránka',
        first: '«', first_title: 'První stránka',
        last: '»', last_title: 'Poslední stránka',
        prev: '‹', prev_title: 'Předchozí stránka',
        next: '›', next_title: 'Další stránka',
        all: 'Vše',
        counter: { showing: 'Zobrazeno', of: 'z', rows: 'kreativ', pages: 'stránek' }
      }
    }
  };

  /* ------------------------------------------------------------------ *
   *  Malé utility
   * ------------------------------------------------------------------ */
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errMsg(e) { return (e && (e.message || e.error || e.msg)) || String(e || 'neznámá chyba'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /* ★ F8/A1 — HLASITÉ SELHÁNÍ MÍSTO TICHA.
   * Filip (10. 8.): „klikám na řádek / na náhled / na šipku rozkliku a nic se neděje."
   * Když handler spadne na výjimce, prohlížeč ji spolkne do konzole a navenek to vypadá
   * PŘESNĚ jako mrtvý klik — nerozeznatelné od překrytého prvku. Tenhle obal rozdíl
   * zviditelní: chyba jde do konzole S KONTEXTEM a Filipovi vyskočí toast s důvodem.
   * Bez toho se příčina nedá dohledat jinak než reprodukcí u něj na stroji. */
  function safe(label, fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) {
        console.error('[tables] ' + label + ' spadl:', e);
        if (ADS.toast) ADS.toast(label + ' selhal: ' + errMsg(e), 'error');
      }
    };
  }
  function th(k, dflt) { return (ADS.TH && ADS.TH[k] != null) ? num(ADS.TH[k]) : dflt; }
  function sum(rows, f) { return rows.reduce(function (s, r) { var v = num(f(r)); return s + (v || 0); }, 0); }

  // Formátovací wrappery — použij ADS.fmt, jinak rozumný fallback.
  function fmtMoney(v) { var n = num(v); if (n == null) return '—'; return F.money ? F.money(n) : (Math.round(n).toLocaleString('cs-CZ') + ' Kč'); }
  function fmtInt(v) { var n = num(v); if (n == null) return '—'; return F.int ? F.int(n) : String(Math.round(n)); }
  function fmtRoas(v) { var n = num(v); if (n == null) return '—'; return F.roas ? F.roas(n) : n.toFixed(2); }
  function fmtPct(v) { var n = num(v); if (n == null) return '—'; return F.pct ? F.pct(n) : (Math.round(n * 100) + ' %'); }
  function fmtDate(s) { if (!s) return '—'; return F.date ? F.date(s) : String(s).slice(0, 10); }

  // Semafor barva pro ROAS_model — primárně ADS.semafor, jinak z prahů.
  function semClass(v) {
    var n = num(v);
    if (n == null) return 'none';
    if (typeof ADS.semafor === 'function') return ADS.semafor(n) || 'none';
    var G = th('ROAS_GREEN', 3), LG = th('ROAS_LGREEN', 2), Y = th('ROAS_YELLOW', 1.3), O = th('ROAS_ORANGE', 1);
    if (n >= G) return 'green'; if (n >= LG) return 'lgreen'; if (n >= Y) return 'yellow'; if (n >= O) return 'orange'; return 'red';
  }

  // Trend CPS: 'up' = CPS roste (horší) = červená · 'down' = klesá (lepší) = zelená · 'flat'.
  function trendDir(v) {
    if (v && typeof v === 'object') v = v.dir || v.trend || v.direction || v.value;
    if (typeof v === 'string') {
      var s = v.toLowerCase();
      if (/up|worse|zhor|rost|rise|▲|↑/.test(s)) return 'up';
      if (/down|better|lep|kles|fall|▼|↓/.test(s)) return 'down';
      return 'flat';
    }
    var n = num(v);
    if (n == null) return 'flat';
    if (n > 1.05) return 'up';       // ratio 7d/30d > 1 → dráž
    if (n < 0.95) return 'down';
    return 'flat';
  }
  // Server posílá spend_pct KANONICKY v 0..100 (api.php). Dřívější heuristika `n > 1 ? n/100 : n`
  // rozbíjela malé podíly: 0,7 % se vykreslilo jako 70 %. Držíme jeden kontrakt → vždy /100.
  function pctNorm(v) { var n = num(v); if (n == null) return 0; return n / 100; }

  // Reprezentativní ad pro náhled / openPreview. (sample_ad může být null → fallback na ads[0].)
  function previewAd(d) { return (d && (d.sample_ad || (d.ads && d.ads[0]))) || {}; }
  /* --- N3: NÁHLED PODLE REŽIMU ---------------------------------------------------------
   * Filip: „dlaždice = PLNÁ kvalita, přednačítat · list view = malé stačí, ale o 30 % větší,
   * nízká kvalita OK."
   * Zdroj pravdy je `ADS.thumbs` (app.js) — jeden modul, jedna logika pro celý dashboard.
   * Fallback níž zůstává pro případ, že by shell `thumbs` neposkytl (starší app.js):
   *   malý: `thumbnail` = lokální cache (thumbnail_local); při cache-missu prázdný string
   *         → podepsaná CDN URL → image_url. Náhled je VŽDY (SPEC §5).
   *   velký: Meta `thumbnail_url` je jen 64×64 px, proto refresh.php cachuje druhou, velkou
   *         variantu (`cache/{ad_id}_big.jpg`) a api.php ji posílá jako `thumbnail_big`.
   * Fyzickou velikost v tabulce (38 → 50 px, +30 %) řeší CSS `.prev-img`. */
  function thumbOf(ad) {
    if (ADS.thumbs && typeof ADS.thumbs.forMode === 'function') {
      var u = ADS.thumbs.forMode(ad, 'list');
      if (u) return u;
    }
    return (ad && (ad.thumbnail || ad.thumbnail_url || ad.image_url)) || '';
  }
  function thumbBigOf(ad) {
    if (ADS.thumbs && typeof ADS.thumbs.big === 'function') {
      var u = ADS.thumbs.big(ad);
      if (u) return u;
    }
    return (ad && (ad.thumbnail_big || ad.thumbnail_big_url || ad.image_url || ad.thumbnail || ad.thumbnail_url)) || '';
  }
  // Ad objekt pro ADS.openPreview: app.js preferuje `image_url` → podstrčíme mu VELKOU verzi
  // (a doplníme kreativu/funnel z řádku, ads_meta je na adu nenese) — bez sahání do app.js.
  function previewAdBig(d) {
    var a = previewAd(d), big = thumbBigOf(a);
    var o = {}; for (var k in a) o[k] = a[k];
    if (big) o.image_url = big;
    if (!o.creative && d && d.creative) o.creative = d.creative;
    if (!o.funnel && d && d.funnel) o.funnel = d.funnel;
    return o;
  }

  /* --- PARITA S LOOKEREM: metriky, které Filip chce vidět všude (FEEDBACK D3–D5/D7) ---
   * Server je zdroj pravdy; níž jsou jen FALLBACKY, kdyby pole nedorazilo (starší api.php / mock):
   *   cpa        = Lookerova „CPA" = spend / (rezervace × % hovorů) — server ji historicky
   *                posílá pod klíčem `cps` (SPEC §1: „cps = … → ukládáme jako bookings_eff").
   *                Prsteny: cena za schůzku · Náušnice: cena za rezervaci (spend / rezervace).
   *   pct_call   = called / lead_rows            → fallback na `call_rate` (server ho počítá stejně, s clampem)
   *   pct_schuzek= passed / bookings             → fallback dopočtem z okenních součtů (jen DISPLAY!)
   * ⚠️ Tyhle fallbacky NIKDY nesmí ovlivnit ROAS model — ten je předpočítaný na denním řádku
   *    (revenue_model) a nad oknem se jen sčítá. Tady jde čistě o zobrazení mezi-metrik. */
  function cpaOf(d) { var v = num(d.cpa); return v != null ? v : num(d.cps); }
  /* ⚠️ NÁLEZ (16. 7., naostro): u kreativy s 0 leady se v „% hovorů" ukazovalo „5 %".
   * PŘÍČINA: api.php posílá `pct_call: null`, když nejsou leady (správně — nebylo koho volat),
   * jenže fallback sáhl na `call_rate`, a ten je ZÁMĚRNĚ CLAMPNUTÝ na [0.05, 1] (CALL_RATE_MIN),
   * aby se jím dalo dělit v modelu. Clamp tak protekl do DISPLEJE jako vymyšlené „5 %".
   * Naměřeno na P-913-004 (13 815 Kč spendu, 0 leadů) — což je přesně řádek, který Filip
   * označil za „nějaký divný" (FEEDBACK-3 H1).
   * OPRAVA: `call_rate` bereme jen tehdy, když leady VŮBEC jsou; jinak „—".
   * ⚠️ Model se tím NEMĚNÍ — ten jede z `revenue_model` předpočítaného na serveru.
   *    Tohle je čistě zobrazení mezi-metriky. */
  function pctCallOf(d) {
    var v = num(d.pct_call); if (v != null) return v;
    var l = num(d.leads);
    if (!l || l <= 0) return null;                  // 0 leadů → dovolání nedává smysl
    var c = num(d.called); if (c != null) return c / l;
    return num(d.call_rate);                        // starší api.php / mock bez pct_call
  }
  /* ⚠️ F7/B — DISPLEJ vs. MATEMATIKA se tu rozcházejí ZÁMĚRNĚ.
   * Když kreativa nemá ANI JEDNU rezervaci, api.php posílá `pct_schuzek: 1.0` (dosazená
   * hodnota, ať zralost nespadne na „—" — viz zralost_from_counts). Vypsat ve sloupci
   * „100 % schůzek proběhlo" u kreativy, kde žádná schůzka nevznikla, by ale byla lež.
   * → Sloupec ukáže „—", zralost si 1.0 vezme (zralostOf níž). Rozlišovač = `schuzek_empty`. */
  function pctSchuzekOf(d) {
    if (d && d.schuzek_empty) return null;              // 0 rezervací → není co zobrazovat
    var v = num(d.pct_schuzek); if (v != null) return v;
    var b = num(d.bookings), p = num(d.passed);
    if (p == null || b == null || b <= 0) return null;   // náušnice: passed = null → sloupec zůstane „—"
    return p / b;
  }
  function createdOf(d) {
    if (d._created) return d._created;
    var best = d.created_time || (d.sample_ad && d.sample_ad.created_time) || '';
    (d.ads || []).forEach(function (a) { if (a.created_time && a.created_time > best) best = a.created_time; });
    return best || '';
  }
  /* H3 — SPÁLENÉ PENÍZE POČÍTÁ SERVER. My je jen zobrazíme a řadíme podle nich.
   *
   * Zdroj pravdy = `burned` v řádku (api.php, proti break-evenu 2,0). NEDOPOČÍTÁVÁME
   * si ho po svém — je to HLAVNÍ ŘAZENÍ kill listu a dvě různé definice na klientu
   * a serveru = Filip vidí jiné pořadí, než podle čeho se rozhoduje.
   *
   * ⚠️ Co bylo špatně: `1 − ROAS` měřilo ztrátu proti ROAS 1,0. Jenže break-even je
   * 2,0 (SPEC §1) → kreativa s ROAS 1,0 reálně PROdělává (vrátí polovinu toho, co
   * musí), ale vycházela jako „spáleno 0 Kč" a padala na konec kill listu. Přesně ta
   * kreativa, kterou má Filip vidět nahoře.
   *
   * Fallback (server pole ještě neposílá — ostrá api.php ho 16. 7. NEMÁ, ověřeno
   * curlem: `burned` chybí, `breakeven` v řádku JE): počítáme proti `d.breakeven`
   * ze serveru, ne proti 1,0. Tzn. i bez nasazené api.php je řazení SPRÁVNĚ; až
   * `burned` dorazí, přebije fallback bez zásahu do kódu.
   *     podíl ztráty = 1 − ROAS/break-even     (clamp 0..1)
   *     ROAS 0 → celý spend · ROAS 1 při BE 2,0 → půlka spendu · ROAS ≥ BE → 0
   */
  var BREAKEVEN_FALLBACK = 2.0;   // SPEC §1: plošně 2,0; jen kdyby nedorazil ani `breakeven`

  function burnedWith(spend, roas, breakeven) {
    var sp = num(spend) || 0, r = num(roas);
    var be = num(breakeven);
    if (!(be > 0)) be = BREAKEVEN_FALLBACK;
    var lost = (r == null) ? 1 : Math.max(0, Math.min(1, 1 - (r / be)));
    return sp * lost;
  }
  /** Server `burned` má přednost; jinak dopočet proti break-evenu ŘÁDKU. */
  function burnedOf(d, roas) {
    var srv = num(d.burned);
    if (srv != null) return srv;
    return burnedWith(d.spend, roas, d.breakeven);
  }
  function burned(d) { return burnedOf(d, d.roas_model); }
  function activeAdIds(d) {
    // Vypnutá je i reklama s `status=PAUSED` a `effective_status=WITH_ISSUES`
    // (bezpečnostní ochrana účtu — viz meta_kill v lib/meta.php). Bez téhle kontroly
    // se killuje znovu něco, co už vypnuté JE.
    var ids = (d.ads || []).filter(function (a) {
      return a.ad_id && !/PAUSED/i.test(a.effective_status || '') && !/PAUSED/i.test(a.status || '');
    })
      .map(function (a) { return a.ad_id; });
    if (!ids.length) { var s = d.sample_ad && d.sample_ad.ad_id; if (s) ids.push(s); }
    return ids;
  }

  /* ================================================================== *
   *  T9: BĚŽÍ / PAUZNUTO
   * ================================================================== *
   * Filip: „první sloupec by ukazoval, jestli běží. Jenom malá ikonka, ne emoji —
   * zelený kolečko a nebo šedý pause. Pokud alespoň jedna reklama toho typu aspoň
   * někde běží, tak to bude zeleně."
   *
   * ⚠️ POROVNÁVÁME PŘESNĚ NA 'ACTIVE', ne regexem /ACTIVE/i jako activeAdIds() výš.
   * Důvod je konkrétní: Meta posílá i `CAMPAIGN_PAUSED` / `ADSET_PAUSED` (reklama je
   * sama o sobě ACTIVE, ale nedoručuje, protože je vypnutá nad ní kampaň/sada) — a to
   * NENÍ „běží". Substringový test by navíc chytil i `INACTIVE`. Držíme tím definici,
   * kterou má api.php sama (`effective_status === 'ACTIVE'`) → dlaždice i tabulka
   * počítají „běží" stejně. Dvě definice = Filip vidí dvě různá čísla (viz konsolidace
   * winnerů 16. 7.).
   *
   * `null` = stav NEZNÁME (server ho neposlal) → „—", NIKDY ne šedá pauza. Šedá pauza
   * je tvrzení „tohle neběží"; to o kreativě bez dat tvrdit nesmíme (datový kontrakt).
   */
  function isAdActive(a) {
    var s = (a && (a.effective_status || a.status)) || '';
    return String(s).trim().toUpperCase() === 'ACTIVE';
  }
  function runningOf(d) {
    if (!d) return null;
    if (d._killed) return false;                       // právě killnuto → hned šedá, nečekáme na refresh
    var ads = (d.ads || []).filter(function (a) { return a && (a.effective_status || a.status); });
    if (ads.length) return ads.some(isAdActive);
    var s = d.sample_ad || null;
    if (s && (s.effective_status || s.status)) return isAdActive(s);
    if (d.effective_status || d.status) return isAdActive(d);
    return null;                                       // nevíme → „—"
  }
  function runningHTML(d) {
    var r = runningOf(d);
    if (r == null) {
      return '<span class="muted" title="server u téhle kreativy neposlal stav reklam — proto „—“, ne šedá pauza">—</span>';
    }
    var n = (d.ads || []).filter(isAdActive).length;
    if (r) {
      return '<span class="rs rs-on" title="' + esc('běží' + (n ? ' (' + n + ' aktivní reklam' + (n === 1 ? 'a' : 'y') + ')' : '')) + '">' +
        '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4"/></svg>' +
        '<i class="sr">běží</i></span>';
    }
    return '<span class="rs rs-off" title="žádná reklama téhle kreativy neběží (pauznuto)">' +
      '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.6" y="1.4" width="2.6" height="7.2" rx="1"/>' +
      '<rect x="5.8" y="1.4" width="2.6" height="7.2" rx="1"/></svg>' +
      '<i class="sr">pauznuto</i></span>';
  }

  /* T10: „Běží od" = PRVNÍ výskyt kreativy. Server posílá `age_days` (api.php:
   * MIN(created_time) přes všechny reklamy kreativy).
   * ⚠️ NEPLÉST s „Vytvořeno" (`_created`) — to je MAX(created_time), tedy NEJNOVĚJŠÍ
   * reklama. Přesně tenhle rozpor Filip 16. 7. reklamoval („stáří" v Nejnovějších);
   * proto teď existují oba sloupce vedle sebe a každý říká v hintu, co měří.
   * Datum v tooltipu je DOPOČET z age_days (≈) — server posílá dny, ne datum, a
   * vymýšlet si přesné datum by bylo tvrzení, které nemáme z dat. */
  function ageOf(d) { var v = num(d && d.age_days); return (v == null || v < 0) ? null : v; }
  function ageHTML(d) {
    var v = ageOf(d);
    if (v == null) return '<span class="muted" title="server neposlal age_days (první výskyt kreativy)">—</span>';
    var dd = Math.round(v);
    var word = (dd === 1) ? 'den' : (dd >= 2 && dd <= 4) ? 'dny' : 'dní';
    var approx = '';
    try {
      var t = new Date(); t.setDate(t.getDate() - dd);
      approx = ' (první reklama ≈ ' + t.toLocaleDateString('cs-CZ') + ')';
    } catch (_) { }
    return '<span class="age" title="' + esc('kreativa poprvé naběhla před ' + dd + ' ' + word + approx) + '">' +
      dd + ' ' + word + '</span>';
  }
  function layerName(l) {
    return { 1: 'Spend bez leadů', 2: 'Tichý žrout', 3: 'Extrém CPL', 4: 'Zralá ROAS<1',
             5: 'Spend bez rezervace', 6: 'Vysoké CPA' }[l] || 'Kill kandidát';
  }

  /* ------------------------------------------------------------------ *
   *  Hover náhled (lehký pop-up) — sdílený jeden element
   * ------------------------------------------------------------------ */
  var hoverPop = null;
  function getHoverPop() {
    if (!hoverPop) { hoverPop = document.createElement('div'); hoverPop.className = 'ads-thumb-pop'; document.body.appendChild(hoverPop); }
    return hoverPop;
  }
  function showHover(ad, cell) {
    // FEEDBACK A1/A3: v hoveru chceme VELKOU variantu (thumbnail_big), ne 64px placku.
    // onerror → spadni na malý thumbnail, ať hover nikdy nezůstane prázdný.
    var src = thumbBigOf(ad), small = thumbOf(ad);
    if (!src) return;
    var p = getHoverPop();
    p.innerHTML = '<img src="' + esc(src) + '" alt="" ' +
      (small && small !== src ? 'onerror="this.onerror=null;this.src=' + JSON.stringify(small).replace(/"/g, '&quot;') + '"' : '') + '>';
    p.style.display = 'block';
    var r = cell.getElement().getBoundingClientRect();
    // FEEDBACK F1: pop-up 2× větší (obrázek 220 → 440 px). Rozměry MUSÍ sedět s CSS
    // `.ads-thumb-pop img` níž, jinak by se flip u pravého okraje počítal ze špatné šířky:
    // 440 obrázek + 2×5 px padding + 2×1 px rámeček = 452.
    var pw = 452, ph = 452, left = r.right + 12, top = r.top - 20;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 12;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    if (top < 8) top = 8;
    p.style.left = left + 'px'; p.style.top = top + 'px';
    // Vynucený reflow místo requestAnimationFrame: rAF se v skryté/překryté záložce
    // nemusí vůbec spustit (a pop-up by pak zůstal na opacity:0). Reflow je deterministický
    // a transition proběhne stejně.
    void p.offsetWidth;
    p.classList.add('show');
  }
  function hideHover() { if (hoverPop) { hoverPop.classList.remove('show'); hoverPop.style.display = 'none'; } }

  function openPreview(ad) { if (typeof ADS.openPreview === 'function') ADS.openPreview(ad); }

  /* P1-B (K5-root) — jeden detail reklamy pro CELÝ dashboard. Hlavní tabulka dřív
   * otevírala starý „Náhled kreativy" (jen média + read-only řádky); bohatý detail
   * (play badge, video/statika K6, kroužek zralosti, K1 skupiny) měla jen sekce
   * Nejnovější. newest.js ho teď vystavuje jako ADS.openDetail(rowData).
   * - `d`  = kreativní řádek (má funnel/roas_model/zralost/_tab) → bohatý detail.
   * - `fallbackAd` = ad objekt pro starý openPreview, když openDetail nejde (náušnice,
   *   chybějící ADS.openDetail, nebo throw). Náušnice funnely/schůzky nerozlišují →
   *   detailHTML by pro ně počítal nesmysly, proto pro ně vědomě starý náhled. */
  function openRowDetail(d, fallbackAd) {
    var isEar = d && d._tab === 'earrings';
    // Náušnice: vlastní detail (rings openDetail by počítal nesmysly). Kdyby cokoli spadlo,
    // spadneme na starý náhled — klik NIKDY nesmí skončit „nic se neděje".
    if (isEar) {
      try { openEarringsDetail(d); return; }
      catch (e) { console.error('[tables] openEarringsDetail selhal, fallback:', e); }
      try { openPreview(fallbackAd || (d ? previewAdBig(d) : {})); } catch (e2) { console.error(e2); }
      return;
    }
    if (d && typeof ADS.openDetail === 'function') {
      try { ADS.openDetail(d); return; }
      catch (e) { console.error('[tables] openDetail selhal, fallback na náhled:', e); }
    }
    try { openPreview(fallbackAd || (d ? previewAdBig(d) : {})); } catch (e3) { console.error(e3); }
  }

  /* Detail náušnicové kreativy (Filip: klik na řádek/preview → detail; rings openDetail
   * pro ně nesedí). Vlastní `.ads-modal-ov` (nezávislý na #modal-root, stejný pattern jako
   * kill/trend modal). ŽÁDNÝ modelový ROAS/tržba — jen reálná čísla (Filip 18. 7.). */
  var earDetailOv = null;
  function closeEarDetail() { if (earDetailOv) { earDetailOv.remove(); earDetailOv = null; document.removeEventListener('keydown', earDetailKey); } }
  function earDetailKey(e) { if (e.key === 'Escape') closeEarDetail(); }
  function openEarringsDetail(d) {
    if (!d) return;
    closeEarDetail();
    var a = previewAd(d), big = thumbBigOf(a) || '';
    var ig = a.instagram_permalink || a.ig || '', prev = a.preview_link || '';
    var aml = a.adsmanager_link || '';
    var isVid = /video/i.test(a.media_type || '') || /VIDEO/i.test(a.object_type || '') || (!!ig && !big);
    var media = big
      ? '<img class="edt-img" src="' + esc(big) + '" alt="" onerror="this.style.display=&quot;none&quot;">'
      : '<div class="edt-img edt-noimg">' + (isVid ? '▶ Video — otevři v Meta / IG' : 'Bez náhledu') + '</div>';
    var camp = (a.campaign_name || '').trim(), adset = (a.adset_name || '').trim();
    var metaLine = (camp || adset)
      ? '<div class="edt-camp"><span>📣 ' + esc(camp || '—') + '</span><span>👥 ' + esc(adset || '—') + '</span></div>' : '';
    // Filip: ROAS celkem/zaplaceno + tržba celkem/zaplaceno — žádný modelový dopočet.
    var groups = [
      ['💰 Peníze', [['Spend', fmtMoney(d.spend)], ['Tržba zaplaceno', fmtMoney(d._paid)], ['Tržba celkem', fmtMoney(d._createdRev)]]],
      ['🔻 Trychtýř', [['Poptávky', fmtInt(d._demands)], ['Rezervace', fmtInt(d._reservations)], ['% hovorů', d._pct_call == null ? '—' : fmtPct(d._pct_call)]]],
      ['🏷 Cena', [['CPA', costOrDash(d._cpa, d._reservations)]]],
      ['📈 ROAS', [['ROAS zaplaceno', fmtRoas(d._roasPaid)], ['ROAS celkem', fmtRoas(d._roasTotal)]]]
    ];
    var body = groups.map(function (g) {
      return '<div class="edt-grp"><div class="edt-grp-h">' + esc(g[0]) + '</div><div class="edt-tiles">' +
        g[1].map(function (t) { return '<div class="edt-t"><span>' + esc(t[0]) + '</span><b>' + t[1] + '</b></div>'; }).join('') +
        '</div></div>';
    }).join('');
    var acts = '';
    if (prev) acts += '<a class="btn btn-sm" href="' + esc(prev) + '" target="_blank" rel="noopener">Přehrát / FB náhled</a>';
    if (ig)   acts += '<a class="btn btn-sm" href="' + esc(ig) + '" target="_blank" rel="noopener">IG</a>';
    if (aml)  acts += '<a class="btn btn-sm btn-primary" href="' + esc(aml) + '" target="_blank" rel="noopener">Otevřít v Meta</a>';

    var ov = document.createElement('div');
    ov.className = 'ads-modal-ov edt-ov';
    ov.innerHTML =
      '<div class="ads-modal edt-modal" role="dialog" aria-modal="true" aria-label="Detail náušnicové kreativy">' +
      '<div class="edt-head"><span class="edt-code">' + esc(d.creative || 'Detail') + '</span>' +
      '<button type="button" class="edt-x" aria-label="Zavřít">×</button></div>' +
      '<div class="edt-body">' + media + metaLine + body +
      (acts ? '<div class="edt-acts">' + acts + '</div>' : '') + '</div></div>';
    document.body.appendChild(ov);
    earDetailOv = ov;
    ov.querySelector('.edt-x').addEventListener('click', closeEarDetail);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeEarDetail(); });
    document.addEventListener('keydown', earDetailKey);
  }

  /* ------------------------------------------------------------------ *
   *  HTML fragmenty (buňky)
   * ------------------------------------------------------------------ */
  // FEEDBACK A3/B1: sloupec NÁHLED = JEN OBRÁZEK. Copy kód (ZCP-103 apod.) sem NEPATŘÍ —
  // název kreativy (kód před `|`) má vlastní sloupec KREATIVA a copy varianty Filip vidět nechce.
  // Placeholder s iniciálami zůstává jen pro případ, že náhled fakt neexistuje.
  function previewHTML(d) {
    var a = previewAd(d), t = thumbOf(a);
    return '<div class="prev">' + (t
      ? '<img class="prev-img" src="' + esc(t) + '" loading="lazy" alt="" title="Klikni pro velký náhled">'
      : '<div class="prev-img noimg" title="bez náhledu">' + esc(String(d.creative || '?').slice(0, 2)) + '</div>') + '</div>';
  }
  function subPreviewHTML(a) {
    var t = thumbOf(a);
    return '<div class="prev sub">' + (t
      ? '<img class="prev-img sm" src="' + esc(t) + '" loading="lazy" alt="" title="Klikni pro velký náhled">'
      : '<div class="prev-img sm noimg"></div>') + '</div>';
  }
  function creativeHTML(d) { return '<span class="cr-code">' + esc(d.creative || '—') + '</span>'; }

  /* ================================================================== *
   *  T13: BARVY FUNNEL PILLS
   * ================================================================== *
   * Filip: snubní 30K = modrá · 100K (přímo) = černá · Maledivy = žlutá ·
   * zásnubní 49K = hnědá · šaty = červenorůžová · 100K „funýlky" (fotosoutěž,
   * dotazník atd.) = fialová. Ostatní = neutrální šedá.
   *
   * ⚠️ Klasifikujeme podle NÁZVU, protože seznam funnelů je dynamický (`ADS.FUNNELS`
   * z `action=config`, jména chodí z BQ) — natvrdo vyjmenovat je nejde a nový funnel
   * musí spadnout do šedé, ne do náhodné barvy.
   *
   * ⚠️⚠️ POŘADÍ TESTŮ JE KRITICKÉ: „zásnubní" OBSAHUJE „snubní" jako podřetězec
   * (po odstranění diakritiky „zasnubni".indexOf("snubni") === 2). Kdyby se `snubni`
   * testovalo dřív, Zásnubní 49K by byl MODRÝ místo hnědého — tedy přesně ta dvojice
   * funnelů, které Filip potřebuje od sebe rozeznat na první pohled. Proto `zasnubni`
   * VŽDY první. Nepřehazovat.
   *
   * „100K přímo" vs „100K funýlky": rozlišuje se přítomností mezikroku v názvu
   * (dotazník / fotosoutěž / kvíz). Holé „100K" = přímý funnel = černá.
   */
  function funnelKindOf(f) {
    var s = String(f == null ? '' : f).toLowerCase();
    // NFD + odstranění diakritiky → „Zásnubní" i „zasnubni" projdou stejným testem.
    // ̀-ͯ = combining marks. Psáno ESCAPEM schválně: literální kombinující
    // znaky v regexu jsou v editoru neviditelné a jeden překlep v kódování je tiše
    // zabije (test by pak nikdy neprošel a všechno by zšedlo).
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { }
    s = s.trim();
    if (!s || s === '---') return 'none';
    if (/100\s*-?\s*k|100\s*000/.test(s)) {
      return /dotazn|fotosout|soutez|kviz|quiz|funyl|anket/.test(s) ? 'f100soft' : 'f100';
    }
    if (/zasnubni/.test(s)) return 'zasnubni';   // MUSÍ být před `snubni` — viz komentář výš
    if (/snubni/.test(s)) return 'snubni';
    if (/maledi/.test(s)) return 'maledivy';
    if (/saty/.test(s)) return 'saty';
    return 'other';
  }
  // T13 — JEDEN klasifikátor pro tabulku i graf (dřív měl graf vlastní pravidlo pro 100K
  // funýlky → pilulka a čára mohly dát jiný odstín). Graf (charts.js) si ho bere odsud.
  ADS.funnelKind = funnelKindOf;
  var FUNNEL_KIND_TIP = {
    snubni: 'Snubní 30K', zasnubni: 'Zásnubní 49K', maledivy: 'Maledivy', saty: 'Šaty',
    f100: '100K napřímo', f100soft: '100K přes mezikrok (fotosoutěž / dotazník)',
    other: 'ostatní funnel', none: 'bez funnelu'
  };
  // FEEDBACK D2: funnel je vlastní SORTOVATELNÝ sloupec (dřív jen chip nalepený ke kreativě).
  function funnelHTML(d) {
    var f = d.funnel || '';
    if (!f) return '<span class="muted">—</span>';
    var k = funnelKindOf(f);
    var tip = FUNNEL_KIND_TIP[k] || '';
    return '<span class="chip chip-funnel fk-' + k + '" title="' + esc(f + (tip && tip !== f ? ' — ' + tip : '')) + '">' +
      esc(f) + '</span>';
  }
  function trendHTML(v) {
    var dir = trendDir(v);
    var g = { up: ['▲', 'CPS roste (dráž)'], down: ['▼', 'CPS klesá (lépe)'], flat: ['→', 'beze změny'] }[dir];
    return '<span class="trend t-' + dir + '" title="' + g[1] + '">' + g[0] + '</span>';
  }
  /* ================================================================== *
   *  N7: DŮVOD = KRÁTKÝ PILL + POPUP S DETAILEM PO NAJETÍ
   * ================================================================== *
   * Filip: „Sloupec DŮVOD: text KRÁTKÝ („Vysoké CPL", „Tichý žrout", „ROAS pod
   * break-even"). Detail ze závorky → po najetí na pill se otevře popup s vysvětlením
   * + daty (klik = jako dnes). Ne overkill — pár řádků."
   *
   * Dřív se do buňky cpal celý serverový text („Spend bez leadů (13815 Kč, 0 leadů)"),
   * ellipsou se stejně usekl a v tabulce nebyl čitelný.
   * Dnes: pill = jen jméno pravidla · popup = SERVEROVÝ text (ten nese čísla, je zdroj
   * pravdy — nedopočítáváme je znovu) + JEDNA věta, proč pravidlo existuje.
   *
   * `kill_rule` / `kill_rules` posílá api.php jako strojové slugy → mapujeme přes ně,
   * ne přes text (text se může přeformulovat, slug ne). `kill_layer` je fallback.
   */
  /* KÓDY VRSTEV (Filip 15. 8.: „chtěl bych u toho důvodu vidět L1, L2 a tak dále").
   * Systém: L = leadové vrstvy · R = rezervační · B = break-even/ROAS · N = náušnice.
   * Kód je i v `kill_reason` ze serveru, tady je pro pilulku a legendu. */
  var KILL_RULES = {
    spend_no_lead: {
      code: 'L1', tab: 'both', short: 'Utraceno bez jediného leadu', layer: 1,
      why: 'Kreativa utratila víc než práh a nepřinesla ANI JEDEN lead. Pod prahem se schválně nekilluje — tam ještě sbírá data.'
    },
    tichy_zrout: {
      code: 'R3', tab: 'both', short: 'Leady provolané, ale žádná rezervace', layer: 2,
      why: 'Leady chodí a call centrum je provolalo, ale nevznikla ani jedna rezervace. Kreativa přitahuje lidi, kteří si termín nedomluví.'
    },
    cpl_extreme: {
      code: 'L2', tab: 'both', short: 'Lead dražší než strop (a bez zisku)', layer: 3,
      why: 'Cena za lead je nad stropem A kreativa zároveň neukazuje žádný zisk — samotné drahé CPL důvod ke killu NENÍ (u prstenů drahý lead často znamená LEPŠÍ lead).'
    },
    roas_lt_1: {
      code: 'B1', tab: 'both', short: 'Zralá data a ROAS pod break-even', layer: 4,
      why: 'Kreativa má dost rezervací, aby se dala soudit, a její ROAS model je pod break-even (plošně 2,0). Tady se neváhá — každý den otálení pálí peníze.'
    },
    gate_r1: {
      code: 'R1', tab: 'rings', short: '5 000 Kč a žádná rezervace', layer: 7,
      why: 'Protočila za život 5 tis. Kč a nemá ANI JEDNU rezervaci. Čeká se, až je provoláno ≥70 % leadů a od překročení prahu uplynuly ≥2 dny — jinak by se killovaly leady, které se ještě nedovolaly. Backtest 3–7/2026: chybovost 1 %, killnutý spend nesl 0,95 Kč marže/Kč = prodělek.'
    },
    gate_r2: {
      code: 'R2', tab: 'rings', short: '10 000 Kč a méně než 3 rezervace', layer: 8,
      why: 'Protočila za život 10 tis. Kč a má míň než 3 rezervace (po provolání ≥70 % a ≥2 dnech od prahu). Backtest: chybovost 3 %. Přísnější prahy střílely budoucí winnery — E-077-001 měla při 5 tis. jedinou rezervaci a pak udělala 578 tis. Kč.'
    },
    earrings_spend_no_resv: {
      code: 'N1', tab: 'earrings', short: 'Utraceno bez jediné rezervace', layer: 5,
      why: 'Kreativa utratila víc než práh a nepřinesla ANI JEDNU rezervaci. Bez grace periody — nulový výsledek za tolik peněz už nepotřebuje čas na rozjezd.'
    },
    earrings_cpa_kill: {
      code: 'N2', tab: 'earrings', short: 'Rezervace dražší než strop', layer: 6,
      why: 'Cena za rezervaci přelezla strop. Bere se DOPOČTENÁ CPA (dle % provolání) — stejné číslo jako ve sloupci CPA. Grace platí: mladá kreativa má pár dní na rozjezd.'
    }
  };
  function ruleOf(d) {
    var r = d && d.kill_rule;
    if (r && KILL_RULES[r]) return KILL_RULES[r];
    var rs = (d && d.kill_rules) || [];
    for (var i = 0; i < rs.length; i++) if (KILL_RULES[rs[i]]) return KILL_RULES[rs[i]];
    return null;
  }
  /* ── LEGENDA PRAVIDEL (Filip 14. 8.): člověk si má umět přečíst, jak systém funguje,
   * přímo v dashboardu — modal z KILL_RULES + živých prahů z configu (ADS.state.config).
   * Stejný obsah zná i AI chat (lib/ai.php ai_system_prompt) → jedna pravda, dvě okna. */
  function killLegendHTML(tab) {
    tab = (tab === 'earrings') ? 'earrings' : 'rings';
    var th = (window.ADS && ADS.state && ADS.state.config && ADS.state.config.thresholds) || {};
    function n(x, fb) { return (x == null ? fb : x); }
    function kc(x, fb) { return String(n(x, fb)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }   // 5000 → 5 000
    var C = { L: '#8a6d3b', R: '#1f6fb2', B: '#c0271f', N: '#7a4f9e' };

    /* ŽIVOTNÍ CYKLUS — vizuální kroky, ne textový blok (Filip 15. 8.: „ta část
     * není přehledná, udělej to jinak než jen v textovém bloku"). */
    var steps = (tab === 'rings') ? [
      { n: '1', t: 'Nasazení', d: '6–8 <b>výrazně odlišných</b> kreativ do EXPERIMENT setu. Ne 20 variant téhož — Meta si podobné slije a vybere náhodně.', lane: 'EXPERIMENT' },
      { n: '2', t: 'SET-kill — ZRUŠENO 17. 8. 2026', d: 'Dřív: set utratí ~600 Kč a má 0–1 lead → kill celého setu (ručně v Ads Manageru). <b>Backtest ukázal ztrátu −242 tis. Kč</b> — pravidlo zabíjelo ziskové sety (9 z 39 mělo potom ROAS 5,6). Navíc <b>kill jedné kreativy stačí</b>: 93 % jejího rozpočtu se přelije do zbylých v setu. Celý set killuj jen kvůli vadnému cílení, ne kvůli výkonu.', lane: 'EXPERIMENT' },
      { n: '3', t: 'R1 — ' + kc(th.GATE_R1_SPEND, 5000) + ' Kč', d: 'Žádná rezervace → kill. (Až po provolání ≥' + Math.round(n(th.GATE_CALL_PCT, .7) * 100) + ' % a ≥' + n(th.GATE_WAIT_DAYS, 2) + ' dnech.)', lane: 'EXPERIMENT' },
      { n: '4', t: 'R2 — ' + kc(th.GATE_R2_SPEND, 10000) + ' Kč', d: 'Méně než ' + n(th.GATE_R2_MIN_BOOKINGS, 3) + ' rezervace → kill.', lane: 'EXPERIMENT' },
      { n: '5', t: 'Verdikt — ' + n(th.PROMOTE_MIN_BOOKINGS, 10) + ' rezervací', d: 'Tři východy: <b>CPA ≤ benchmark A ROAS model ≥ ' + n(th.WINNER_ROAS, 5) + '</b> → povýšit · CPA výrazně nad benchmarkem → kill · cokoli mezi → <b>nechat běžet</b> (nesahat, nezvyšovat budget).', lane: 'EXPERIMENT' },
      { n: '6', t: 'Povýšení — jediné škálování, které máme', d: 'Rozpočet se ručně nepřilévá, umíme jen přesun do SCALE — proto plný winner práh <b>ROAS model ≥ ' + n(th.WINNER_ROAS, 5) + '</b>. <b>Post-ID duplikát</b> do SCALE kampaně; originál nechat běžet, dokud kopie nemá ~10 vlastních rezervací. Co ROAS ' + n(th.WINNER_ROAS, 5) + ' nesplní, se <b>nevypíná</b> — jen zatím nepovyšuje.', lane: 'PŘECHOD' },
      { n: '7', t: 'Řízení ve SCALE', d: 'ROAS až od 25 rezervací. <b>B1</b>: zralá pod break-even → kill hned. Podvyživený winner → push delivery.', lane: 'SCALE' }
    ] : [
      { n: '1', t: 'Nasazení', d: 'Kreativy do EXPERIMENT setu. Náušnicový cyklus je krátký (~5 dní), tržba dozrává rychle.', lane: 'EXPERIMENT' },
      { n: '2', t: 'N1 — bez rezervace', d: 'Utraceno přes práh a 0 rezervací → kill. Bez grace periody.', lane: 'EXPERIMENT' },
      { n: '3', t: 'N2 — drahá rezervace', d: 'Dopočtená CPA nad stropem → kill. Grace platí (mladá kreativa má pár dní).', lane: 'EXPERIMENT' },
      { n: '4', t: 'Škálování', d: 'Vyhodnocuje se na ZAPLACENO. Rezervační gaty R1/R2 tu neběží — mají smysl jen u prstenů.', lane: 'SCALE' }
    ];
    var LANE = { 'EXPERIMENT': '#8a6d3b', 'PŘECHOD': '#4f9a3f', 'SCALE': '#1f6fb2' };
    var cyc = '';
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      cyc += '<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 11px;margin:0 0 6px;' +
        'background:#fff;border:1px solid #eee6d8;border-left:3px solid ' + (LANE[st.lane] || '#ccc') + ';border-radius:9px">' +
        '<span style="flex:0 0 22px;height:22px;border-radius:50%;background:' + (LANE[st.lane] || '#ccc') + ';color:#fff;' +
        'font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">' + st.n + '</span>' +
        '<span style="flex:1"><b>' + st.t + '</b><br><span style="color:#6b6355;font-size:12.5px">' + st.d + '</span></span>' +
        '<span style="flex:0 0 auto;font-size:10.5px;color:' + (LANE[st.lane] || '#999') + ';font-weight:700;letter-spacing:.03em">' + st.lane + '</span>' +
        '</div>';
    }

    /* KILL PRAVIDLA — jen vrstvy PATŘÍCÍ K TOMUTO TABU (Filip: náušnicové sem nepatří). */
    var order = (tab === 'rings')
      ? ['spend_no_lead', 'cpl_extreme', 'gate_r1', 'gate_r2', 'tichy_zrout', 'roas_lt_1']
      : ['spend_no_lead', 'cpl_extreme', 'tichy_zrout', 'roas_lt_1', 'earrings_spend_no_resv', 'earrings_cpa_kill'];
    var rows = '';
    for (var j = 0; j < order.length; j++) {
      var r = KILL_RULES[order[j]]; if (!r) continue;
      var col = C[(r.code || 'L')[0]] || '#3c372e';
      rows += '<div style="margin:0 0 7px;padding:10px 12px;background:#faf8f3;border:1px solid #eee6d8;border-radius:10px">' +
        '<div style="font-weight:600;display:flex;align-items:center;gap:9px">' +
        '<span style="min-width:30px;text-align:center;padding:2px 7px;border-radius:6px;background:' + col +
        ';color:#fff;font-size:11.5px;font-weight:700">' + esc(r.code) + '</span>' + esc(r.short) + '</div>' +
        '<div style="font-size:12.5px;color:#6b6355;margin-top:4px">' + esc(r.why) + '</div></div>';
    }

    return '<div style="max-width:660px;font-size:13.5px;line-height:1.5">' +
      '<h4 style="margin:0 0 8px">Životní cyklus reklamy</h4>' + cyc +
      '<h4 style="margin:16px 0 6px">Kill pravidla' + (tab === 'earrings' ? ' — náušnice' : '') + '</h4>' +
      '<div style="font-size:12px;color:#8a8172;margin-bottom:7px">' +
      '<b style="color:' + C.L + '">L</b> = leadové · <b style="color:' + C.R + '">R</b> = rezervační · ' +
      '<b style="color:' + C.B + '">B</b> = break-even' + (tab === 'earrings' ? ' · <b style="color:' + C.N + '">N</b> = náušnicové' : '') +
      '</div>' + rows +
      '</div>';
  }

  function bindKillLegendLinks() {
    var links = document.querySelectorAll('.kill-legend-link');
    for (var i = 0; i < links.length; i++) {
      if (links[i].dataset.bound) continue;
      links[i].dataset.bound = '1';
      links[i].addEventListener('click', function (ev) {
        // tab podle sekce, ve které odkaz sedí — náušnicová legenda ukazuje N1/N2,
        // prstenová R1/R2 (Filip 15. 8.: „náušnicový tam nedávej, ty dáš do záložky náušnice").
        var sec = ev.currentTarget.closest('.sec');
        var isEar = sec && String(sec.getAttribute('data-sec') || '').indexOf('ear') === 0;
        ADS._modal(killLegendHTML(isEar ? 'earrings' : 'rings'),
                   { title: isEar ? 'Pravidla killů — náušnice' : 'Pravidla killů a gaty' });
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindKillLegendLinks);
  else bindKillLegendLinks();

  function killShort(d) {
    var r = ruleOf(d);
    // Filip 15. 8.: „u toho důvodu chci vidět L1, L2 a tak dále" → kód je součástí popisku.
    if (r) return (r.code ? r.code + ' · ' : '') + r.short;
    return layerName(num(d.kill_layer) || 0);
  }
  /* „Detail ze závorky" (Filipova formulace N7): server posílá
   *   „Spend bez leadů (13940 Kč, 0 leadů)"
   *   „ROAS pod break-even (vzorek 24, ROAS 1.73 < break-even 2× funnelu Snubní 30K)"
   * → v pop-upu je nadpis už jako pill, takže z textu bereme JEN obsah závorky.
   * Když text tenhle tvar nemá (server ho přeformuluje), ukážeme ho celý — radši
   * duplicita než ztracená informace. */
  function killDetail(d) {
    var t = String(d.kill_reason || '').trim();
    if (!t) return '';
    var m = t.match(/^[^(]{3,60}\((.+)\)$/);
    return m ? m[1].trim() : t;
  }
  // Popup: nadpis · vrstva · detail s čísly ze serveru · proč · (další vrstvy).
  function killPopHTML(d) {
    var r = ruleOf(d);
    var layer = num(d.kill_layer) || (r ? r.layer : 0);
    var h = '<b class="rp-h">' + esc(killShort(d)) + '</b>' +
      '<span class="rp-l">kill vrstva ' + (layer || '—') + ' ze 4</span>';
    var det = killDetail(d);
    if (det) h += '<span class="rp-d">' + esc(det) + '</span>';
    if (r) h += '<span class="rp-w">' + esc(r.why) + '</span>';
    var rs = (d.kill_rules || []).filter(function (x) { return KILL_RULES[x] && (!r || KILL_RULES[x] !== r); });
    if (rs.length) {
      h += '<span class="rp-m">Spustila i: ' + rs.map(function (x) { return esc(KILL_RULES[x].short); }).join(' · ') +
        ' <i>(ukazuje se nejvyšší priorita)</i></span>';
    }
    h += '<span class="rp-c">Klikni na řádek pro graf trendu.</span>';
    return h;
  }
  function killReasonHTML(d) {
    var layer = num(d.kill_layer) || 0;
    // `th-tip` = zapojení do sdíleného pop-up mechanismu (F2). `data-tip-html` = bohatá
    // varianta (showHint ji pozná a vloží jako HTML místo textContent).
    return '<span class="chip layer-' + layer + ' kill-pill th-tip" data-tip-html="' +
      esc(killPopHTML(d)) + '">' + esc(killShort(d)) + '</span>';
  }
  /* T14 (Filip, náušnice): „je tam takovej divnej batch… jsou tam dvě fajfky, je tam
   * nějakej otazník, moc to nechápu."
   * Měl pravdu — badge skládal „Scale" + `✓✓` (dvě fajfky = jen kosmetika, nic
   * neznamenaly) + `?`/`✓` (třetí podmínka). Tři znaky pro JEDEN bit informace.
   *
   * DNES: JEDNA ikonka + srozumitelný tooltip celou větou.
   *   ✓ zelená  = unese škálování (dost rezervací + CPA pod mediánem funnelu)
   *   ~ šedá    = unese, ale 3. podmínku (poslední škálování > 7 dní) v1 neumí ověřit
   *   —         = nevyhodnoceno / neunese
   * Význam ✓ vs ~ je v tooltipu SLOVY, ne dalším symbolem — Filip má číst ikonu, ne
   * luštit legendu. */
  /* Filip 17. 8.: „nevím, jestli ten vykřičník znamená, že je podvyživená, nebo není."
   * → v sloupci NELUŠTIT ikonu. Píše se SLOVO. Prázdný stav je „—", jako u ostatních sloupců. */
  function starvedBadgeHTML(d) {
    if (!d.starved) {
      return '<span class="muted" title="Dostává dost prostoru. (Sloupec hlásí jen winnery s ROAS model ≥ 5 — u ostatních se nevyhodnocuje.)">—</span>';
    }
    var t = d.starved_reason || 'Winner, ale Facebook jí nedává prostor';
    return '<span class="starv" title="' + esc(t) + '">hladoví</span>';
  }
  // Zralost: zdroj pravdy je server (api.php počítá `maturity` přes early_kill_spend()
  // a per-funnel nuance) a posílá 'young' | 'mature'. Klientský dopočet je jen fallback,
  // kdyby pole nedorazilo.
  // POZOR: badge byl OTOČENÝ — 'mature' se tvářila jako „mladá". young = málo spendu
  // a 0 rezervací → ještě nemá data (nekillovat); mature = data má.
  function maturityBadgeHTML(d) {
    var young;
    if (d.maturity === 'young' || d.maturity === 'mature') {
      young = (d.maturity === 'young');
    } else {
      var early = th('EARLY_KILL_SPEND', th('SPEND_NO_LEAD_MIN', 450));
      young = (num(d.bookings) || 0) < 1 && (num(d.spend) || 0) < early;
    }
    // G1: chip má vlastní sloupec „Stav dat" → popisek může být krátký (dřív se „mladá /
    // čekáme data" mačkalo do buňky vedle data vytvoření). ⚠️ Slovo „zralá" je pryč
    // ZÁMĚRNĚ: kolidovalo se sloupcem Zralost (A1), který měří něco úplně jiného —
    // tohle je „má dost spendu/rezervací na hodnocení", ne „kolik tržby je reálné".
    return young
      ? '<span class="chip wait" title="málo spendu a 0 rezervací — nekillovat, ještě sbírá data">⏳ čekáme na data</span>'
      : '<span class="chip fresh" title="kreativa už má naměřená data — dá se soudit">✓ má data</span>';
  }
  function dopocetBadgeHTML(d) {
    var p = num(d.dopocet_pct);
    var warn = d.dopocet_warn === true || (p != null && p > th('DOPOCET_WARN_PCT', 0.5)) ||
      (num(d.call_rate) != null && num(d.call_rate) < th('CALL_RATE_WARN', 0.4));
    return '<span class="chip ' + (warn ? 'dop-warn' : 'dop-ok') + '" title="' + (warn ? 'velký dopočet' : 'dopočet OK') + '">' +
      fmtPct(p) + (warn ? ' ⚠' : '') + '</span>';
  }
  function killBtnHTML(d) {
    if (d._killed) return '<span class="tag-off">⏸ Vypnutá</span>';
    return '<button class="btn-kill" type="button">Kill</button>';
  }
  // FEEDBACK I1 → C1: šipka byla „šeredná". Důvod: `.chev-btn` NEMĚLA v CSS vůbec nic,
  // takže se kreslila jako defaultní systémové tlačítko (šedý rámeček) a glyf `▸` se navíc
  // renderuje v každém fontu jinak. Teď: SVG šipka (ostrá v každé velikosti) v pojmenované
  // klikatelné ploše 30×30 s hover/active/focus stavem a plynulou rotací (viz CSS `.chev-btn`).
  // Klik na tuhle buňku rozbaluje; klik jinam na řádek otevírá graf trendu (M1).
  function chevronHTML(d) {
    var open = !!d._expanded;
    return '<button class="chev-btn' + (open ? ' open' : '') + '" type="button" aria-expanded="' + (open ? 'true' : 'false') +
      '" title="' + (open ? 'Sbalit jednotlivé reklamy' : 'Rozbalit jednotlivé reklamy') + '">' +
      '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  }
  function statusChipHTML(v) {
    var paused = /PAUSED/i.test(v || ''), active = /ACTIVE/i.test(v || '');
    var cls = paused ? 'off' : active ? 'on' : 'mid';
    var label = paused ? '⏸ Vypnutá' : active ? '● Aktivní' : (v || '—');
    return '<span class="st st-' + cls + '">' + esc(label) + '</span>';
  }
  function amLinkHTML(a) {
    var url = a.adsmanager_link || '';
    if (!url) return '<span class="muted">—</span>';
    return '<a class="am-link" href="' + esc(url) + '" target="_blank" rel="noopener">Ads Manager ↗</a>';
  }

  /* ================================================================== *
   *  A1/A3/A4: ZRALOST = kolik % tržby je REÁLNÉ (zbytek je dopočet)
   * ================================================================== *
   * Filip (FEEDBACK-3 A): „mám 100 leadů, provolala se půlka a z těch se udělalo 10 schůzek
   * a z nich proběhla půlka → vím, že čtvrtina tržby proběhla… vydělím 0,5 a pak znovu 0,5.
   * Pak tu zralost nemusím brát pro výpočet, ale jenom informativně, abych věděl, na kolik
   * procent je to dopočtené — je rozdíl, když je dopočteno z 25 % nebo z 90 %."
   *
   * ⚠️ TOHLE NENÍ dosavadní ČASOVÁ zralost (MATURITY_CURVE / `window_maturity` / „14 dní").
   * Ta měřila STÁŘÍ DAT a Filip ji jako ukazatel v UI nechce (A2) — je to jiná veličina.
   * Tady jde o DŮVĚRU V DOPOČET:
   *     zralost = pct_call × pct_schuzek
   * = přesně převrácená hodnota Lookerova dopočtu (trzba_celkem = tržba / pct_schuzek / pct_call).
   * Dopočet zralost UŽ ŘEŠÍ ve výpočtu → tenhle sloupec do ničeho nevstupuje, jen říká,
   * jak moc je ROAS model vycucaný z prstu.
   *
   * NÁUŠNICE: model dělí JEN call_rate (schůzky neexistují — api.php: revenue_model =
   * created / call_rate, `pct_schuzek` posílá null) → zralost = pct_call. Násobit ji nulou
   * za chybějící schůzky by celý náušnicový tab natřelo červeně.
   *
   * KONTRAKT S API: `zralost` je 0..1 (stejně jako `pct_call` / `pct_schuzek`, které api.php
   * takhle posílá už dnes). Hodnota > 1 je matematicky nemožná (součin dvou pravděpodobností),
   * takže ji bereme jako procenta a dělíme stem. ⚠️ Tahle záchrana je bezpečná JEN tady:
   * u `spend_pct` úplně stejná heuristika rozbíjela malé podíly (0,7 % se kreslilo jako 70 %),
   * proto tam držíme /100 natvrdo (viz pctNorm výš).
   */
  var ZR_TIP = 'kolik % tržby je REÁLNÉ; zbytek je dopočet (tržba / % schůzek / % provolaných). ' +
    'NENÍ to stáří dat — je to důvěra v číslo: je rozdíl, když je ROAS dopočtený z 25 % nebo z 90 %. ' +
    'Červená < 25 % · oranžová 25–50 % · žlutá 50–75 % · zelená > 75 %.';

  function zralostOf(d) {
    var v = num(d.zralost);
    if (v != null) return v > 1 ? v / 100 : v;   // server = zdroj pravdy (doplňuje jiný agent)
    var c = pctCallOf(d);
    if (c == null) return null;
    if (d._tab === 'earrings') return c;         // jen JEDEN dopočet (bez schůzek)
    /* F7/B (Filip 23. 7., L-173-001): ŽÁDNÁ rezervace ≠ „nevím". Když nic nevzniklo,
     * není na co čekat → komponenta schůzek = 1 a zralost = jen % hovorů (43 %, ne „—").
     * Rozlišuj od „rezervace jsou, ale nevíme, jak dopadly" → to je dál null. */
    var bk = num(d.bookings);
    var s = (d.schuzek_empty || bk === 0) ? 1 : pctSchuzekOf(d);
    if (s == null) return null;                  // rezervace jsou, výsledek neznáme → „—"
    return c * s;
  }
  // Barvu primárně bere ze serveru (`zralost_color`), jinak z Filipových pásem.
  function zralostClass(d, v) {
    var sc = d && d.zralost_color;
    if (typeof sc === 'string' && /^(red|orange|yellow|green)$/.test(sc.trim().toLowerCase())) {
      return sc.trim().toLowerCase();
    }
    if (v == null) return 'none';
    if (v < 0.25) return 'red';
    if (v < 0.50) return 'orange';
    if (v <= 0.75) return 'yellow';
    return 'green';
  }
  // A3: barevný kroužek (conic-gradient donut) + číslo. Kroužek nese podíl i opticky —
  // Filip skenuje tabulku očima, ne čte procenta řádek po řádku.
  function zralostHTML(d) {
    var v = zralostOf(d);
    if (v == null) {
      return '<span class="muted" title="bez rezervací se dopočet nedá vyhodnotit">—</span>';
    }
    var pct = Math.round(v * 100), cls = zralostClass(d, v);
    return '<span class="zr zr-' + cls + '" title="' + esc(pct + ' % tržby je reálné, ' + (100 - pct) + ' % je dopočet') + '">' +
      '<span class="zr-ring" style="--zp:' + Math.max(0, Math.min(100, pct)) + '"></span>' +
      '<span class="zr-v">' + pct + ' %</span></span>';
  }

  /* ================================================================== *
   *  F2: HINTY NA NÁZVY SLOUPCŮ — „ono to moc nefunguje"
   * ================================================================== *
   * PROČ to nefungovalo (změřeno v prohlížeči, ne odhad):
   *  1. `.th-tip` NEMĚLA V CSS ANI ŘÁDEK → „ⓘ" se kreslilo jako holé kurzívové písmenko
   *     bez kurzoru a bez afordance. Nikdo nepozná, že tam něco je.
   *  2. Hint mělo jen 6 sloupců z ~20 (CPA, % hovorů, % rezervací, Tržby, Spáleno, Poptávky,
   *     Rezervace). Spend, Leadů, ROAS real, ROAS model, Trend, Důvod, Scale, % spendu,
   *     Náhled, Kreativa, Funnel neměly NIC → Filip najel na sloupec a nevyskočilo nic.
   *  3. Nativní `title` má ~1–2 s prodlevu a uvnitř hlavičky s `overflow:hidden` se v Safari
   *     často neukáže vůbec.
   * ŘEŠENÍ: jeden REGISTR (HINTS) + centrální applier (decorateHeaders) → hint dostane
   * KAŽDÝ sloupec ve VŠECH tabulkách, viditelný marker „ⓘ" a VLASTNÍ okamžitý pop-up.
   */
  var HINTS = {
    _preview:      'náhled reklamy — najetím se zvětší, klikem se otevře velký náhled s odkazem do Mety',
    creative:      'kód kreativy = text před „|" v názvu reklamy (copy varianty za „|" jsou až v rozkliku)',
    funnel:        'funnel, do kterého kreativa sype leady. Bez rámečku = jistý z dat; kreativa bez jediného leadu ho má odvozený z prefixu kódu.',
    spend_pct:     'podíl této kreativy na CELKOVÉM spendu za období — kam reálně tečou peníze',
    spend:         'kolik Meta za období za tuhle kreativu utratila (CZK)',
    leads:         'počet leadů za období (Looker „počet leadů" = počet řádků, ne součet new_leads). Jmenovatel CPL.',
    // --- F: VLeads + New leads (FEEDBACK-3/4) — TŘI RŮZNÉ VĚCI, které se pletou ---------
    // `leads` (výš) = lead_rows = COUNT(*) → tímhle se dělí CPL a takhle to má Looker.
    // `new_leads` = SUM(analytics_new_lead) → kolik z těch řádků je NOVÝ člověk (ne opakovaná
    //   poptávka). Bývá NIŽŠÍ než leads. NEPLETE se do CPL — jinak by se rozbila parita.
    // `vleads` = SUM(analytics_valuable_lead) → kolik leadů je kvalifikovaných.
    // ⚠️ Obojí je DEFAULTNĚ SKRYTÉ (viz DEFAULT_HIDDEN) — tabulka má i tak 16 sloupců.
    //    V pruhu „Skryté sloupce" nad tabulkou jsou na jeden klik.
    new_leads:     'počet NOVÝCH leadů = součet analytics_new_lead (kolik řádků je od člověka, který tu ještě nebyl). ⚠️ CPL se dělí sloupcem „Leadů" (počet řádků), NE tímhle — tak to počítá Looker a držíme s ním paritu.',
    valuable_leads: 'VLeads = kvalifikované („valuable") leady, součet analytics_valuable_lead. Říká, kolik z leadů má reálnou hodnotu — samotný levný lead není výhra.',
    selected_leads: 'Selected = lead s termínem svatby, nebo (zásnubní) plánuje svatbu do 6 měsíců. Statisticky hodnotnější: 61 % leadů nese 79 % tržeb. Zdroj: Ninox share view (v BQ zatím není).',
    bookings:      'počet vytvořených rezervací (schůzek) z těchto leadů',
    _cpa:          'cena za rezervaci se zohledněním provolanosti: spend / (rezervace × % hovorů). Přesně Lookerova „CPA" (dřív se sloupec jmenoval „CPS"). Počet rezervací, ze kterých je spočítaná, je ve zvláštním sloupci Rezervace (u malého vzorku je to nejisté číslo).',
    cpl:           'cena za lead = spend / leady. Filip: „nejčastěji když se sníží CPL, tak se to propadne" — samotné levné leady nejsou výhra, kontroluj proti CPA a ROAS.',
    _pct_call:     'kolik % leadů se povedlo provolat = provoláno / leady (Looker pct_call). Nižší číslo = větší část tržby je dopočtená → viz sloupec Zralost.',
    _pct_schuzek:  'kolik % rezervací reálně proběhlo = proběhlé schůzky / rezervace (Looker pct_schuzek). Druhý dělitel dopočtu → taky tlačí Zralost dolů.',
    revenue_real:  'tržba, která UŽ REÁLNĚ padla (Looker „Tržba") — skutečné peníze za období',
    revenue_model: 'tržba dopočtená modelem (Looker „Tržba celkem") = tržba nyní / % rezervací / % hovorů. Odpovídá na „kdyby se provolalo 100 % leadů a dostavilo 100 % schůzek". NENÍ to předpověď budoucna — je to dopočet toho, co se nedotrackovalo.',
    roas_real:     'ROAS ze SKUTEČNÝCH peněz = tržba nyní / spend. Nepodléhá žádnému modelu, ale podhodnocuje kreativy, u kterých se ještě neprovolalo.',
    roas_model:    'ROAS z DOPOČTENÉ tržby = tržba dopočet / spend. ⚠️ Prahy (kill i winners) jsou kotvené SEM — Looker to má stejně. Je o ~44 % vyšší než ROAS real; jak moc se na něj dá spolehnout, říká sloupec Zralost.',
    _zralost:      ZR_TIP,
    trend_cps:     'trend CPA: posledních 7 dní vs. 30 dní. ▲ červená = rezervace zdražují · ▼ zelená = zlevňují · → beze změny. Klikem se otevře graf.',
    _burned:       'spend × (1 − ROAS / break-even) = kolik peněz shořelo proti hranici zisku (2,0). Počítá to server. U ROAS 0 celý spend; kreativa s ROAS 1,0 spálila půlku spendu — vrací totiž jen polovinu toho, co musí. Řadí se podle něj — nahoře jsou největší průšvihy, ne největší spendy.',
    kill_reason:   'která kill vrstva se spustila a proč (1 = spend bez leadů · 2 = tichý žrout · 3 = extrém CPL · 4 = zralá ROAS pod prahem). Kreativa může spadnout do víc vrstev — ukazuje se ta nejvyšší priorita.',
    scale_ready:   'PODVYŽIVENÁ: kreativa je winner (ROAS model ≥ 5), ale za 7 dní dostala míň než práh své kampaně (hlavní 5 000 Kč / experiment 3 000 Kč) — Facebook jí nedává prostor. Není to akce, jen upozornění.',
    _created:      'kdy Meta reklamu vytvořila (nejnovější z reklam téhle kreativy)',
    maturity:      'má už kreativa dost dat, aby se dala soudit? „čekáme na data" = málo spendu a 0 rezervací → NEKILLOVAT, ještě sbírá. ⚠️ Není to Zralost — ta říká, jak moc je dopočtená tržba.',
    _share:        'podíl téhle jedné reklamy na spendu celé kreativy za období',
    // --- náušnice ---
    _demands:      'počet poptávek — 1 řádek v Ninoxu = 1 poptávka (kolik LIDÍ poptalo)',
    _reservations: 'počet objednaných PÁRŮ — není totéž co poptávky: jeden člověk může vzít víc párů (ověřeno 43 poptávek vs. 47 rezervací). Tohle je jmenovatel CPA.',
    _paid:         'tržba ze ZAPLACENÝCH objednávek (Ninox „analytics_zaplaceno") — rozhodovací metrika náušnic: kotví se na ni kill i winners',
    _createdRev:   'tržba ze VŠECH vytvořených objednávek, i nezaplacených (Ninox „analytics_celkem")',
    _roasPaid:     'ROAS ze zaplacených objednávek = tržba zaplaceno / spend. Tohle je u náušnic rozhodovací číslo (semafor i kill jsou kotvené sem).',
    _roasTotal:    'ROAS ze všech vytvořených objednávek = tržba celkem / spend. Vyšší než zaplaceno, protože počítá i objednávky, které se ještě nezaplatily.',
    _roasCalc:     'ROAS z dopočtené tržby = (tržba celkem / % hovorů) / spend — dorovnává leady, na které se ještě nevolalo',
    dopocet_pct:   'jak velká část výsledku stojí na dopočtu (1 − % hovorů). Nad 50 % nebo při hovorů pod 40 % svítí ⚠ — číslu se pak dá věřit míň.'
  };

  /* ------------------------------------------------------------------ *
   *  Znovupoužitelné column factory
   * ------------------------------------------------------------------ */
  /* ================================================================== *
   *  HLAVIČKA SLOUPCE = tip (F2) + OČIČKO (S1)
   * ================================================================== *
   * F2 (hint): nativní `title` schválně NEPOUŽÍVÁME — kreslil by se přes náš pop-up
   * a se zpožděním. Text bere z registru HINTS podle `field`, výjimky si sloupec řekne
   * přes `_tip` (např. CPA má jiný význam u prstenů a u náušnic).
   *
   * S1 (skrývání): Filip: „očičko v hlavičce = skrýt; nahoře seznam skrytých → klik =
   * vrátit. Tím si u všech tabulek můžu upravovat počty sloupců — to bude geniální."
   * → očičko dostane KAŽDÝ pojmenovaný sloupec, centrálně, aby se na žádný nezapomnělo
   *   (přesně to byl důvod, proč Filipovi „hinty moc nefungovaly" — měla je jen ⅓ sloupců).
   * → sloupce BEZ názvu (rozklik `_exp`, `Kill` `_kill`) očičko NEMAJÍ: nemají kam ho dát
   *   a hlavně — schovat si tlačítko Kill v kill listu je jediná cesta, jak si nástroj
   *   uřízne vlastní funkci. Zbytek jde skrýt všechen.
   */
  /* T7 (Filip): „ty ikonky u těch sloupců jsou už takový nahňácaný… To íčko vedle bejt
   * nemusí, to očičko tam bejt nemusí — udělá se klik pravým a dát skrýt sloupec a bude
   * tam jenom ta šipička pro to řazení." + „při najetí na ten název toho sloupce se ukáže info."
   * → V hlavičce zůstává NÁZEV + Tabulatorova šipka řazení. Nic víc.
   *   • info  = hover na NÁZEV (`.th-tip` → showHint, mechanismus F2 beze změny)
   *   • skrýt = pravý klik na hlavičku → kontextové menu (wireColMenu)
   * Celý název je teď hover cíl (dřív jím bylo jen mrňavé „ⓘ“) → trefit se je snazší,
   * ne těžší, i když marker zmizel. */
  function headerHTML(text, tip) {
    var h = '<span class="th-wrap">';
    h += tip
      ? '<span class="th-tip" data-tip="' + esc(tip) + '">' + esc(text) + '</span>'
      : '<span class="th-plain">' + esc(text) + '</span>';
    return h + '</span>';
  }
  // Centrální applier — jediné místo, kde se hlavička skládá. Volá se na KAŽDÝ set sloupců.
  function decorateHeaders(cols) {
    (cols || []).forEach(function (c) {
      if (!c || typeof c.title !== 'string' || !c.title) return;
      var tip = c._tip || HINTS[c.field] || '';
      // `_tip` je NAŠE pole, ne Tabulatorovo → po spotřebování ho zahodíme.
      // Jinak `debugInvalidOptions` vysype do konzole „Invalid column definition
      // option: _tip" za každý sloupec (naměřeno: 14 varování na jeden render).
      delete c._tip;
      c.titleFormatter = (function (text, tp) {
        return function () { return headerHTML(text, tp); };
      })(c.title, tip);
    });
    return cols;
  }

  /* --- F2: vlastní hint pop-up (sdílený jeden element) ---
   * pointer-events:none → nepřekáží tažení hlavičky (movableColumns) ani kliku na řazení.
   * position:fixed → neořízne ho `overflow:hidden` na hlavičce ani na .sec. */
  var hintPop = null;
  function getHintPop() {
    if (!hintPop) { hintPop = document.createElement('div'); hintPop.className = 'ads-hint-pop'; document.body.appendChild(hintPop); }
    return hintPop;
  }
  function showHint(el) {
    // Dvě varianty obsahu:
    //   data-tip      → prostý text (hlavičky sloupců, F2)
    //   data-tip-html → bohatý pop-up (N7 „Důvod"): nadpis + data + proč
    // HTML si skládáme SAMI z esc()nutých kusů (killPopHTML) — do atributu se nikdy
    // nedostane nic ze serveru bez escapu.
    var html = el.getAttribute('data-tip-html');
    var tip = el.getAttribute('data-tip');
    if (!html && !tip) return;
    var p = getHintPop();
    p.classList.toggle('rich', !!html);
    if (html) p.innerHTML = html; else p.textContent = tip;
    // ⚠️ display MUSÍ nastavit JS, ne CSS: inline styl přebije stylopis, takže
    // „display:block" tady by zabil `.ads-hint-pop.rich{display:flex}` a všechny
    // řádky bohatého pop-upu by se slily do jednoho odstavce (naměřeno v prohlížeči:
    // „Spend bez leadůKILL VRSTVA 1 ZE 4Spend bez leadů (13940 Kč…" na jedné řádce).
    p.style.display = html ? 'flex' : 'block';
    // Změř až S TEXTEM: mimo obrazovku, ať uživatel nevidí bliknutí na špatné pozici.
    p.style.left = '-9999px'; p.style.top = '0px';
    var r = el.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
    var left = r.left, top = r.bottom + 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;   // nevejde se dolů → nad hlavičku
    if (top < 8) top = 8;
    p.style.left = left + 'px'; p.style.top = top + 'px';
    void p.offsetWidth;   // reflow (rAF se ve skryté záložce nemusí spustit — viz showHover)
    p.classList.add('show');
  }
  function hideHint() { if (hintPop) { hintPop.classList.remove('show'); hintPop.style.display = 'none'; } }
  function wireHints() {
    if (document._adsHintsWired) return;
    document._adsHintsWired = true;
    // capture=true: Tabulator si na hlavičkách drží vlastní handlery, tímhle je předběhneme.
    document.addEventListener('mouseover', function (e) {
      var t = (e.target && e.target.closest) ? e.target.closest('.th-tip') : null;
      if (t) showHint(t);
    }, true);
    document.addEventListener('mouseout', function (e) {
      var t = (e.target && e.target.closest) ? e.target.closest('.th-tip') : null;
      if (t) hideHint();
    }, true);
    // Scroll/tažení sloupce → pop-up nesmí zůstat viset u staré pozice hlavičky.
    window.addEventListener('scroll', hideHint, true);
    document.addEventListener('mousedown', hideHint, true);
  }

  function colPreview() {
    // A3: jen obrázek → sloupec může být úzký (dřív 190 px kvůli copy textu).
    return {
      title: 'Náhled', field: '_preview', width: 70, minWidth: 60, headerSort: false, cssClass: 'c-prev',
      formatter: function (cell) { return previewHTML(cell.getData()); },
      // R1/R2 + P1-B: klik → bohatý detail kreativy (fallback na velký náhled).
      // klik → bohatý detail: obsluhuje wireRowClicks (F8/A3), NE cellClick — viz komentář tam
      cellMouseEnter: function (e, cell) { showHover(previewAd(cell.getData()), cell); },
      cellMouseLeave: function () { hideHover(); }
    };
  }
  /* FEEDBACK E1: „sloupec kreativa je moc široký, je to všude (hlavně Nejnovější)".
   * PŘÍČINA (ověřeno ve zdrojáku Tabulatoru, layout `fitColumns`): sloupec BEZ `width`
   * je „flex" a rozebere si VŠECHNO volné místo. `creative` měl jen `minWidth:128` a
   * v tabulkách bez jiného flex sloupce (Nejnovější, All-time, Top spenders) tak zbyl
   * jako JEDINÝ kandidát → na širokém monitoru narostl klidně na 400+ px.
   * ŘEŠENÍ: kód kreativy je krátký a fixní délky (P-647-001) → dostane pevnou `width`.
   *   ⚠️ ŽÁDNÝ maxWidth — ten by clampoval i ruční resize a rozbil E2.
   * Volné místo teď schválně nasává `funnel` (chip s dlouhým textem, šířka mu prospěje)
   * a v kill tabulkách navíc `Důvod` — proto `colFunnel()` níž `width` NEMÁ. */
  function colCreative() {
    // F2: `headerTooltip` (nativní popup Tabulatoru) je pryč — tip řeší decorateHeaders
    // z registru HINTS, ať mají všechny sloupce jeden a tentýž mechanismus.
    return {
      title: 'Kreativa', field: 'creative', width: 112, minWidth: 92, cssClass: 'c-cr',
      formatter: function (cell) { return creativeHTML(cell.getData()); },
      // T8: popisek sumárního řádku — kolik kreativ se sčítá (respektuje funnel filtr).
      bottomCalc: function (values, data) { return data.length; },
      bottomCalcFormatter: function (cell) { return '<b>Σ ' + fmtInt(cell.getValue()) + '</b> kreativ'; }
    };
  }
  /* T10 — „Běží od": kdy kód kreativy POPRVÉ vyjel (MIN created_time napříč jejími
   * reklamami) + kolik dní běží (age_days ze serveru). Řadí se dle age_days (číslo). */
  function firstRunDate(d) {
    var best = '';
    (d && d.ads || []).forEach(function (a) {
      if (a.created_time && (!best || a.created_time < best)) best = a.created_time;
    });
    return best;
  }
  function colAge() {
    return {
      title: 'Běží od', field: 'age_days', hozAlign: 'right', sorter: 'number', width: 108, cssClass: 'c-age',
      _tip: 'kdy kód kreativy POPRVÉ vyjel (nejstarší reklama) a kolik dní od té doby běží',
      formatter: function (cell) {
        var d = cell.getData();
        var dt = firstRunDate(d);
        var age = num(cell.getValue());
        var days = age != null ? ' <i class="cnt" style="font-style:normal">(' + fmtInt(age) + ' d)</i>' : '';
        if (dt) return '<span class="cdate">' + fmtDate(dt) + '</span>' + days;
        return age != null ? fmtInt(age) + ' d' : '<span class="muted">—</span>';
      }
    };
  }
  // FEEDBACK D2: sortovatelný funnel sloupec.
  // E1: schválně BEZ `width` → tohle je ten „flex" sloupec, co v prstenových tabulkách
  // nasaje zbylé místo místo `creative`. Text funnelu je dlouhý, šířka mu jde k duhu.
  //
  // M4 — `minWidth` NENÍ od oka (stejná metoda jako u sloupce „Důvod" výš: změřeno
  // v prohlížeči na 1512 px). Při minWidth:100 se sloupec v plných tabulkách scvrkl
  // přesně na 100 px a ellipsis usekl DVA NEJČASTĚJŠÍ funnely:
  //     „Snubní 30K"    scrollWidth 82 > clientWidth 78  → „Snubní 3…"
  //     „Zásnubní 49K"  scrollWidth 95 > clientWidth 78  → „Zásnubn…"
  //   (7 z 9 buněk useknutých; useklo se to v KAŽDÉM řádku)
  // Rozpočet šířky pro „Zásnubní 49K" = nejdelší text, který MUSÍ být celý:
  //     text 77 + chip padding 2×9 + chip border 2×1 + buňka padding 2×12 = 121 px
  // 128 = 121 + 7 rezerva na jiné vykreslení fontu/zoom. Delší názvy („Zásnubní:
  // Zjistit velikost dotazník") se pořád ellipsují — ty celé být nemusí, drží je title.
  function colFunnel() {
    return {
      title: 'Funnel', field: 'funnel', minWidth: 128, cssClass: 'c-fun',
      formatter: function (cell) { return funnelHTML(cell.getData()); },
      /* P1-G — NE 'string' (to dá „---" nahoru, protože '-' < písmena). Řadíme dle
       * VELIKOSTI SKUPINY (kolik reklam funnel má), „—"/„---" VŽDY dole v obou směrech.
       * Tabulator řadí komparátorem vzestupně a pro desc pole obrací (reverse) → blank
       * musí být směrově-vědomý, jinak by v desc vyskočil nahoru. */
      sorter: function (a, b, aRow, bRow, column, dir) {
        var blankSign = (dir === 'desc') ? -1 : 1;
        var ba = isBlankFunnel(a), bb = isBlankFunnel(b);
        if (ba !== bb) return (ba ? 1 : -1) * blankSign;   // blank dole v asc i desc
        if (ba && bb) return 0;
        var counts = funnelGroupCounts(aRow.getTable());
        var ca = counts[a] || 0, cb = counts[b] || 0;
        if (ca !== cb) return ca - cb;                     // menší skupina dřív (asc); desc = větší nahoře
        return String(a).localeCompare(String(b), 'cs');
      }
    };
  }

  /* ★ T9 — BĚŽÍ / PAUZNUTO. Filip: „první sloupec by ukazoval, jestli běží. Buď by tam bylo,
   * že je pauznutá, a nebo že běží. Jenom malá ikonka, ne emoji — prostě zelený kolečko
   * a nebo šedý pause jako ikonka. Ono to je vidět až po rozkliknutí, a já bych to chtěl
   * vidět i tady. Pokud alespoň jedna reklama toho typu aspoň někde běží, tak to bude zeleně."
   *
   * → Kreativa = zelená, když JAKÁKOLI její reklama běží. Jinak šedá pauza.
   * `active_ads` posílá server (počet běžících reklam kreativy); `ads[]` je záloha,
   * kdyby dorazil starší tvar odpovědi.
   * Řadí se podle počtu běžících → jeden klik a máš nahoře to, co reálně utrácí.
   */
  /* Stav řádku pro sloupec i řazení. Staví na `runningOf()` výš — ta má správnou definici
   * „běží" (přesně 'ACTIVE', ne substring) a vrací `null`, když stav NEZNÁME.
   * Vlastní počítadlo tu ZÁMĚRNĚ NENÍ: druhá definice „běží" = dvě různá čísla v UI. */
  function colState() {
    return {
      title: '', field: '_state', width: 34, minWidth: 34, hozAlign: 'center',
      cssClass: 'c-state', headerSort: true, resizable: false,
      headerTooltip: 'Běží / pauznuto — zelené kolečko = aspoň jedna reklama téhle kreativy běží. Klikni pro seřazení.',
      // `_state` v datech není → sorter si stav odvodí sám. null (neznámo) řadíme doprostřed.
      sorter: function (a, b, aRow, bRow) {
        var rank = function (d) { var r = runningOf(d); return r === true ? 2 : (r === null ? 1 : 0); };
        return rank(aRow.getData()) - rank(bRow.getData());
      },
      formatter: function (cell) {
        var d = cell.getData();
        var r = runningOf(d);
        if (r === null) return '<span class="muted" title="Stav reklam neznáme — server ho neposlal">—</span>';
        if (r) {
          var n = (d.ads || []).filter(isAdActive).length;
          var bezi = 'Běží' + (n ? ' (' + n + ' aktivní' + (n === 1 ? ' reklama' : 'ch reklam') + ')' : '');
          return '<span class="st-dot" title="' + esc(bezi) + '"></span>';
        }
        return '<span class="st-pause" title="Pauznuto — žádná reklama téhle kreativy neběží"></span>';
      }
    };
  }
  /* Číselný sorter, který PRÁZDNÉ (null/„—") vždy strká DOLŮ — v obou směrech řazení
   * (Filip: „bez CPA nahoru neřaď"). Tabulatorí `alignEmptyValues:'bottom'` v tomhle buildu
   * nezabralo. Tabulator výsledek pro 'desc' obrací, proto prázdné pro 'desc' vracíme opačně,
   * ať po obrácení skončí zase dole. */
  function numEmptyLast(a, b, aRow, bRow, column, dir) {
    var ea = (a == null || a === '' || (typeof a === 'number' && isNaN(a)));
    var eb = (b == null || b === '' || (typeof b === 'number' && isNaN(b)));
    if (ea && eb) return 0;
    if (ea) return dir === 'desc' ? -1 : 1;
    if (eb) return dir === 'desc' ? 1 : -1;
    return (Number(a) || 0) - (Number(b) || 0);
  }
  function colMoney(title, field, width) {
    return Object.assign({
      title: title, field: field, hozAlign: 'right', sorter: 'number', width: width || 82, cssClass: 'c-num',
      formatter: function (cell) { return fmtMoney(cell.getValue()); }
    }, bcSum(fmtMoney));
  }
  function colInt(title, field, width) {
    return Object.assign({
      title: title, field: field, hozAlign: 'right', sorter: 'number', width: width || 72, cssClass: 'c-num',
      formatter: function (cell) { var v = num(cell.getValue()); return v == null ? '—' : fmtInt(v); }
    }, bcSum(fmtInt));
  }
  function colRoasPlain(title, field, width) {
    return Object.assign({
      title: title, field: field, hozAlign: 'right', sorter: 'number', width: width || 84, cssClass: 'c-num',
      formatter: function (cell) { return fmtRoas(cell.getValue()); }
    }, bcRatio(CALC_ROAS_NUM[field] || 'revenue_real', 'spend', fmtRoas, 'VÁŽENÝ: Σ tržba ÷ Σ spend'));
  }

  /* ★ T8 — SUMÁRNÍ ŘÁDEK přes Tabulator `bottomCalc` (per sloupec). Nahradil slitou
   * patičku `.ads-foot` (footerHTML), která byla MIMO grid → neseděla pod sloupci
   * (Filip to reklamoval). `bottomCalc` fce dostane `(values, data)` — `data` = VŠECHNY
   * (filtrované) řádky → vážené poměry (Σtržba/Σspend…) jdou spočítat. Řádek se sám
   * zarovná pod sloupce, scrolluje s gridem, respektuje funnel filtr i řazení sloupců.
   *
   * ⚠️ „PRŮMĚR" U POMĚRŮ JE VÁŽENÝ (Σnum/Σden), ne avg(řádků) — jinak by kreativa se 100 Kč
   *    a ROAS 30× táhla průměr stejně jako kreativa za 300 000 Kč (statistický nesmysl).
   *    Sedí to i na headline dlaždice (server je počítá ze součtů stejně). */
  var CALC_ROAS_NUM = {
    roas_real: 'revenue_real', roas_model: 'revenue_model',
    _roasCalc: 'revenue_model', _roasTotal: '_createdRev', _roasPaid: '_paid', _burned: 'revenue_model'
  };
  function bcSum(fmt) {
    return {
      bottomCalc: function (values) {
        var t = 0, has = false;
        for (var i = 0; i < values.length; i++) { var n = num(values[i]); if (n != null) { t += n; has = true; } }
        return has ? t : null;
      },
      bottomCalcFormatter: function (cell) { var v = cell.getValue(); return v == null ? '' : fmt(v); }
    };
  }
  function bcRatio(numF, denF, fmt, tip) {
    return {
      bottomCalc: function (values, data) {
        var sn = 0, sd = 0;
        for (var i = 0; i < data.length; i++) {
          var n = num(data[i][numF]);
          var d = typeof denF === 'function' ? denF(data[i]) : num(data[i][denF]);
          if (n != null) sn += n;
          if (d != null) sd += d;
        }
        return sd > 0 ? sn / sd : null;
      },
      bottomCalcFormatter: function (cell) {
        var v = cell.getValue();
        if (v == null) return '';
        return tip ? '<span title="' + esc(tip) + '">' + fmt(v) + '</span>' : fmt(v);
      }
    };
  }

  /* ★ T8 — SUMÁRNÍ ŘÁDEK. Filip: „chybí mi sum řádek, co by to průměroval." Řeší se
   * PER SLOUPEC přes Tabulator `bottomCalc` (viz bcSum/bcRatio výš) — zarovnaný pod
   * gridem, respektuje funnel filtr i řazení sloupců. Vážené poměry (Σtržba/Σspend…)
   * jdou spočítat z `data` v bottomCalc fci. Původní slitá patička (footerAgg/footerHTML)
   * byla MIMO grid → neseděla pod sloupci; odstraněná v této iteraci. */

  /* --- FEEDBACK D3/D4/D5/D7: metriky, které chce Filip vidět ve VŠECH tabulkách --------- */

  // D3: CPA místo CPS. Prsteny = Lookerova CPA (spend / (rezervace × % hovorů)),
  // náušnice = cena za rezervaci (K1: spend / rezervace, CPL nezajímá).
  // D2 (FEEDBACK-3): za číslo POČET REZERVACÍ v závorce — „4 004 Kč (2)". Bez něj se
  // CPA ze dvou rezervací čte stejně sebevědomě jako CPA z dvou set.
  // Náušnice CPA semafor: červená ≥ kill práh (EARRINGS_CPA_KILL), oranžová ≥ 0,8× prahu, jinak zelená.
  // Práh čteme z thresholds (Settings) → barva se hýbe s tím, co si Filip nastaví. Fallback 1000.
  function earCpaClass(v) {
    var t = (ADS.TH && (ADS.TH.EARRINGS_CPA_KILL || ADS.TH.earrings_cpa_kill));
    var kill = Number(t); if (!(kill > 0)) kill = 1000;
    if (v >= kill) return 'cpa-red';
    if (v >= kill * 0.8) return 'cpa-orange';
    return 'cpa-green';
  }
  function colCpa(tab) {
    var ear = (tab === 'earrings');
    var tip = ear
      ? 'cena za REZERVACI = spend / rezervace (řídíme se Lookerem; CPL u náušnic neřešíme). V závorce je počet rezervací, ze kterých je spočítaná.'
      : HINTS._cpa;
    return Object.assign({
      title: 'CPA', field: '_cpa', hozAlign: 'right', sorter: numEmptyLast, width: 100, cssClass: 'c-num c-cpa',
      _tip: tip,
      formatter: function (cell) {
        var d = cell.getData(), v = num(cell.getValue());
        var n = num(ear ? d._reservations : d.bookings);
        // ⚠️ Bez rezervací CPA NEEXISTUJE (dělení nulou). api.php ji ale posílá jako 0,
        // protože sdiv() vrací při nulovém jmenovateli 0 → v tabulce svítilo „0 Kč",
        // což se čte jako „rezervace zadarmo" — přesný opak pravdy (0 rezervací za 622 Kč).
        // Držíme konvenci, kterou má api.php samo v komentáři u pct_call/pct_schuzek:
        // „null (ne 0) při nulovém jmenovateli → FE ukáže —, ne zavádějící 0".
        // Naměřeno na kill řádcích Z-267-005 / P-913-004 (spend bez leadů).
        if (!n || n <= 0) {
          return '<span class="muted" title="žádné rezervace za období → cena za rezervaci neexistuje (nedá se dělit nulou)">—</span>';
        }
        var txt = (v == null || v === 0) ? '—' : fmtMoney(v);
        // Náušnice: barva CPA dle kill prahu (Filip: <800 zelená · 800–1000 oranžová · >1000 kilo/červená).
        // Oranžová = 0,8× práh, červená = práh → mění se automaticky, když se práh v Settings upraví.
        var cls = (ear && v != null && v > 0) ? (' ' + earCpaClass(v)) : '';
        // Filip: počet rezervací v závorce v hlavní tabulce NE — je na to zvlášť sloupec.
        // Vzorek (z kolika rezervací je CPA) zůstává aspoň v tooltipu buňky.
        return '<span class="cpa-val' + cls + '" title="' +
          esc('spočítáno z ' + fmtInt(n) + ' rezervací za období') + '">' + txt + '</span>';
      }
    }, bcRatio('spend', function (r) {
      return ear ? num(r._reservations)
                 : (num(r.bookings_eff) != null ? num(r.bookings_eff) : num(r.bookings));
    }, fmtMoney, 'VÁŽENÁ: Σ spend ÷ Σ rezervace'));
  }
  // CPL se stejným guardem jako CPA: bez leadů cena za lead NEEXISTUJE, ale api.php ji přes
  // sdiv() posílá jako 0 → „0 Kč" na kill řádku „spend bez leadů" je čitelné jako „leady
  // zadarmo", což je opak reality (622 Kč za 0 leadů). Filip: „nejčastěji když se sníží CPL,
  // tak se to propadne" → tenhle sloupec čte pozorně a nesmí lhát.
  function colCplRings() {
    return Object.assign({
      title: 'CPL', field: 'cpl', hozAlign: 'right', sorter: numEmptyLast, width: 78, cssClass: 'c-num',
      formatter: function (cell) {
        var d = cell.getData(), v = num(cell.getValue()), l = num(d.leads);
        if (!l || l <= 0) {
          return '<span class="muted" title="žádné leady za období → cena za lead neexistuje (nedá se dělit nulou)">—</span>';
        }
        return (v == null) ? '—' : fmtMoney(v);
      }
    }, bcRatio('spend', 'leads', fmtMoney, 'VÁŽENÁ: Σ spend ÷ Σ leadů'));
  }
  /* --- F: VLeads + New leads --------------------------------------------------------
   * Data v DB jsou (ads_rings_daily.new_leads / .valuable_leads), api.php je do řádku
   * doplňuje. Sloupce jsou proto DEFENZIVNÍ: když pole nedorazí (starší api.php), ukážou
   * „—" a řeknou proč — NIKDY ne 0. Nula by se četla jako fakt („žádné valuable leady"),
   * a to je přesně ta třída chyb, kterou jsme dnes u CPA/CPL vymýtili. */
  function colLeadVariant(title, field, tip) {
    return Object.assign({
      title: title, field: field, hozAlign: 'right', sorter: 'number', width: 88, cssClass: 'c-num',
      _tip: tip,
      formatter: function (cell) {
        var v = num(cell.getValue());
        if (v == null) {
          return '<span class="muted" title="tuhle metriku zatím neposílá API (doplňuje se) — proto „—" a ne 0">—</span>';
        }
        return fmtInt(v);
      }
    }, bcSum(fmtInt));
  }
  function colNewLeads() { return colLeadVariant('New leads', 'new_leads', HINTS.new_leads); }
  function colSelected() { return colLeadVariant('Selected', 'selected_leads', HINTS.selected_leads); }
  function colVLeads() {
    /* ⚠️ KONTRAKT: api.php posílá pole `valuable_leads` (ověřeno ve zdroji present_row),
     * NE `vleads` — to je jen jeho interní název v agregaci. Sloupec proto čte
     * `valuable_leads`; `vleads` bereme jako fallback v normalizeRings, kdyby se
     * kontrakt někdy sjednotil opačně. Kdyby se tyhle dva rozešly, sloupec by mlčky
     * ukazoval „—" napořád a nikdo by nepoznal proč. */
    return colLeadVariant('VLeads', 'valuable_leads', HINTS.valuable_leads);
  }
  // A3/A4: ZRALOST — kolik % tržby je reálné. Ukazuje se VŠUDE, kde se porovnává ROAS
  // (Filip: „to je důležité") → je součástí společného ocasu metrik, hned za ROAS model.
  function colZralost() {
    return Object.assign({
      title: 'Zralost', field: '_zralost', hozAlign: 'right', sorter: 'number', width: 96, cssClass: 'c-num c-zr',
      formatter: function (cell) { return zralostHTML(cell.getData()); }
    }, bcRatio('revenue_real', 'revenue_model', fmtPct, 'VÁŽENÁ: Σ tržba reálná ÷ Σ tržba model'));
  }
  // D4: % provolaných hovorů / % proběhlých rezervací — jak v Lookeru.
  function colPct(title, field, tip, width) {
    return {
      title: title, field: field, hozAlign: 'right', sorter: 'number', width: width || 84, cssClass: 'c-num c-pct',
      _tip: tip,
      formatter: function (cell) {
        var v = num(cell.getValue());
        return v == null ? '<span class="muted">—</span>' : fmtPct(v);
      }
    };
  }
  // F1: Filip sloupec pojmenoval „% hovorů" (ne „% hovorů") → držíme jeho slovník.
  function colPctCall() {
    return colPct('% hovorů', '_pct_call', HINTS._pct_call, 92);
  }
  function colPctSchuzek() {
    return colPct('% rezervací', '_pct_schuzek', HINTS._pct_schuzek, 96);
  }
  // D5: celkové (reálné) tržby — kvůli reklamám s vysokým ROAS a drahým leadem.
  function colRevenue(title, field, width, tip) {
    title = title || 'Tržba real';   // sjednoceno (ne „Tržba nyní") — pár k „Tržba model"
    field = field || 'revenue_real';
    return Object.assign({
      title: title, field: field, hozAlign: 'right', sorter: 'number',
      width: width || 96, cssClass: 'c-num',
      _tip: tip || HINTS[field] || HINTS.revenue_real,
      formatter: function (cell) { return fmtMoney(cell.getValue()); }
    }, bcSum(fmtMoney));
  }
  /* F1: ⚠️ „tržba dopočet (model)" — sloupec, který DODNES CHYBĚL. Filip ho má v pořadí
   * mezi „tržba nyní" a „ROAS real", protože bez něj se ROAS model nedá zkontrolovat:
   * je vidět jen výsledek podílu, ne čitatel. api.php `revenue_model` posílá už dnes
   * (ověřeno naostro: E-028-001 → real 360 940 Kč vs. model 453 174 Kč). */
  function colRevenueModel() {
    return Object.assign({
      title: 'Tržba model', field: 'revenue_model', hozAlign: 'right', sorter: 'number',
      width: 108, cssClass: 'c-num c-revmodel',
      formatter: function (cell) { return fmtMoney(cell.getValue()); }
    }, bcSum(fmtMoney));
  }
  // D6: „SPÁLENÉ vs SPEND" Filip nechápal → jasný název + tooltip se vzorcem.
  function colBurned(roasLabel) {
    return Object.assign({
      title: 'Spáleno (ztráta)', field: '_burned', hozAlign: 'right', sorter: 'number',
      width: 112, cssClass: 'c-num burned',
      // H3: měří se proti BREAK-EVENU (2,0), ne proti ROAS 1,0 — text musí říkat totéž
      // co počítá server, jinak Filip čte vzorec, podle kterého se nerozhoduje.
      _tip: 'spend × (1 − ' + (roasLabel || 'ROAS model') + ' / break-even) = kolik peněz shořelo ' +
            'proti hranici zisku; u ROAS 0 celý spend, na break-evenu 0',
      formatter: function (cell) { return fmtMoney(cell.getValue()); }
    }, bcSum(fmtMoney));
  }
  // ROAS_model se semaforovým pozadím buňky.
  function colRoasModel(field, title) {
    field = field || 'roas_model';
    return Object.assign({
      title: title || 'ROAS model', field: field, hozAlign: 'right', sorter: 'number', width: 94, cssClass: 'c-sem',
      formatter: function (cell) {
        var cls = semClass(cell.getValue()), el = cell.getElement();
        el.classList.remove('sem-green', 'sem-lgreen', 'sem-yellow', 'sem-orange', 'sem-red', 'sem-none');
        el.classList.add('sem-' + cls);
        return '<span class="sem-val">' + fmtRoas(cell.getValue()) + '</span>';
      }
    }, bcRatio(CALC_ROAS_NUM[field] || 'revenue_model', 'spend', fmtRoas, 'VÁŽENÝ: Σ tržba model ÷ Σ spend'));
  }
  function colTrend(field) {
    return {
      // trend_cps je z API OBJEKT {dir,cps7,cps30} → tooltip:false, jinak by Tabulator
      // vypsal "[object Object]"; vlastní title si nastavuje trendHTML().
      title: 'Trend', field: field || 'trend_cps', hozAlign: 'center', headerSort: false, width: 62,
      cssClass: 'c-trend c-trend-click', tooltip: false,
      formatter: function (cell) { return trendHTML(cell.getValue()); }
      // M1: šipka trendu je nejpřirozenější místo pro „ukaž mi graf" (stejně jako klik na řádek).
      // Obsluhuje wireRowClicks (F8/A3) přes `.c-trend`, NE cellClick.
    };
  }
  /* DECAY — signál umírající kreativy: CPA teď vs. CPA na VLASTNÍM startu (ověřeno 97% precision,
   * viz analýza 19. 7.). Nahrazuje „Trend" (7d vs 30d), který Filipovi nic neříkal. */
  var DECAY_MAP = {
    ok:    ['dec-ok', '🟢', 'v normě'],
    warn:  ['dec-warn', '🟠', 'zhoršuje se'],
    dying: ['dec-dying', '🔴', 'umírá']
  };
  function decayHTML(dc) {
    dc = dc || {};
    var lv = dc.level;
    if (!lv || lv === 'na') {
      return '<span class="muted th-tip" data-tip="Zatím nelze soudit — kreativa potřebuje ≥28 dní běhu a dost rezervací na startu i teď. Jinak by to byl šum.">—</span>';
    }
    var m = DECAY_MAP[lv] || DECAY_MAP.ok;
    var rtx = dc.ratio != null ? ('×' + String(dc.ratio).replace('.', ',')) : '';
    var tip = 'CPA vs. vlastní start kreativy: ' + (dc.ratio != null ? ('×' + String(dc.ratio).replace('.', ',')) : '?') +
      ' (start ' + fmtMoney(dc.base) + ' → teď ' + fmtMoney(dc.recent) + '). ' +
      (lv === 'dying' ? 'Umírá — CPA vylétla, kandidát na vypnutí.'
        : lv === 'warn' ? 'Zhoršuje se — hlídej, ať nemaže profit.' : 'Drží se.');
    return '<span class="dec-pill ' + m[0] + ' th-tip" data-tip="' + esc(tip) + '">' + m[1] + ' ' + esc(rtx) + '</span>';
  }
  function colDecay() {
    return {
      title: 'Decay', field: 'decay', hozAlign: 'center', width: 88, cssClass: 'c-decay', tooltip: false,
      // řadí dle závažnosti (umírá > zhoršuje > ok > nevíme) → view „Zhoršují se" dá nejhorší nahoru
      sorter: function (a, b) { var o = { dying: 3, warn: 2, ok: 1, na: 0 }; return (o[(a || {}).level] || 0) - (o[(b || {}).level] || 0); },
      formatter: function (cell) { return decayHTML(cell.getValue()); }
      // klik → graf trendu; obsluhuje wireRowClicks (F8/A3) přes `.c-decay`, NE cellClick
    };
  }
  function colSpendPct() {
    // F1: „% spendu" je teď ve VŠECH hlavních tabulkách (dřív jen v Top spenders) → 128 px
    // by z ostatních tabulek ukroulo moc; bar s procentem se v klidu vejde do 112.
    return {
      title: '% spendu', field: 'spend_pct', width: 112, sorter: 'number', cssClass: 'c-bar',
      formatter: function (cell) {
        var p = pctNorm(cell.getValue()), w = Math.max(2, Math.min(100, Math.round(p * 100)));
        return '<div class="bar"><div class="bar-fill" style="width:' + w + '%"></div>' +
          '<span class="bar-lbl">' + Math.round(p * 100) + ' %</span></div>';
      }
    };
  }
  // I1: klikatelná plocha 32×32 uvnitř 44px sloupce (dřív 32px sloupec s 12px glyfem).
  function colExpand() {
    return {
      title: '', field: '_exp', width: 40, minWidth: 40, headerSort: false, hozAlign: 'center', cssClass: 'c-exp',
      formatter: function (cell) { return chevronHTML(cell.getData()); }
      // rozbalení obsluhuje wireRowClicks (F8/A3), NE cellClick
    };
  }
  /* ===========================================================================
   * F7/D7 — SLOUPEC „FLAG" (trvalé poznámky ke kreativě)
   * ---------------------------------------------------------------------------
   * Filip 23. 7.: „byl by to i jako volitelný sloupec, který by se propisoval napříč
   * všema zobrazeníma. Tím pádem já si ho tam můžu dát a vidím ten flag, a tím pádem
   * já vím, co s tou kreativou třeba bylo špatně."
   *
   * DEFAULTNĚ SKRYTÝ (DEFAULT_HIDDEN) — tabulka má i bez něj 16 sloupců a většina kreativ
   * flag nemá. Kdo ho chce, vrátí si ho z pruhu „Skryté sloupce"; pozice i viditelnost
   * se pak drží ve view jako u každého jiného sloupce (proto „napříč zobrazeními").
   *
   * Data nejdou z řádku (server je v ?action=creatives neposílá — flag není metrika), ale
   * ze sdíleného storu ADS.flags. Ten se plní jedním dotazem a překresluje se na
   * 'flagschange' → přidání flagu v detailu je v tabulce vidět hned.
   * ⚠️ Řadí se podle POČTU flagů, ne podle textu: „která kreativa má nejvíc poznámek"
   *    je jediné smysluplné řazení; abecedně podle první poznámky by nikomu nic neřeklo. */
  function flagsOf(d) {
    try { return (ADS.flags && ADS.flags.get(d && d.creative)) || []; } catch (_) { return []; }
  }
  function flagTipOf(list) {
    return list.map(function (f) {
      return fmtDate(String(f.created_at || '').slice(0, 10)) + ' · ' + (f.note || '');
    }).join('\n');
  }
  function colFlag() {
    return {
      title: 'Flag', field: '_flag', width: 74, minWidth: 62, hozAlign: 'center', cssClass: 'c-flag',
      headerTooltip: 'Vlastní poznámky ke kreativě (co hlídat, co bylo špatně). Klik = otevřít detail, ' +
                     'kde se dají přidávat a mazat. Ve sloupci je počet a v tooltipu texty s daty.',
      sorter: function (a, b, aRow, bRow) {
        return flagsOf(aRow.getData()).length - flagsOf(bRow.getData()).length;
      },
      formatter: function (cell) {
        var list = flagsOf(cell.getData());
        if (!list.length) return '<span class="fl-none" title="Bez poznámky">—</span>';
        return '<span class="fl-on" title="' + esc(flagTipOf(list)) + '">🚩' +
          (list.length > 1 ? '<i>' + list.length + '</i>' : '') + '</span>';
      },
      // klik → detail (flagy se spravují tam, jedno místo). Obsluhuje wireRowClicks (F8/A3).
    };
  }

  /* F7/A3 — Kill jako PLNOHODNOTNÝ sloupec (Filip 23. 7.: „chci ho součástí vlastního
   * sloupce, který mohou posouvat, skrývat apod").
   * Vlastní sloupec to byl vždycky, ale měl `title: ''` — a celý systém skrývání/vracení
   * se drží právě názvu (wireColMenu i renderHiddenBar přeskakují sloupce bez titulu,
   * aby si je uživatel nemohl schovat a už nikdy nenajít). Pojmenováním se automaticky
   * odemklo skrývání i pruh „Skryté sloupce"; přesouvání tažením už fungovalo
   * (movableColumns) a pozice se ukládá do view přes persistColumns().
   * ⚠️ `_exp` (rozklik) zůstává BEZ názvu schválně — bez něj by se řádky nedaly rozbalit. */
  function colKill() {
    return {
      title: 'Kill', field: '_kill', width: 78, minWidth: 74, headerSort: false, hozAlign: 'center', cssClass: 'c-kill',
      formatter: function (cell) { return killBtnHTML(cell.getData()); }
      // kill obsluhuje wireRowClicks (F8/A3) přes killCreativeRow(row) — NE cellClick
    };
  }

  /* ------------------------------------------------------------------ *
   *  Kill flow (creative + per-ad)
   * ------------------------------------------------------------------ */
  // D3/D5: v confirm modalu ukazujeme stejné metriky jako v tabulce (CPA místo CPS + tržby),
  // ať Filip nekilluje kreativu, která má 20× ROAS a jen drahý lead.
  /* ⚠️ NÁLEZ (16. 7., naostro v prohlížeči): kill modal u P-913-004 („Spend bez leadů",
   * 13 940 Kč / 0 leadů) hlásil „CPA 0 Kč" a „CPL 0 Kč". To se čte jako „leady zadarmo" —
   * PŘESNÝ OPAK pravdy a přesně ta chyba, kterou už mají opravenou sloupce v tabulce
   * (colCpa/colCplRings). Modal na ni ale zapomněl — a je to poslední obrazovka PŘED
   * nevratnou akcí, takže je to to nejhorší možné místo, kde lhát.
   * Příčina je stejná: api.php posílá přes sdiv() nulu, když je jmenovatel 0.
   * PRAVIDLO: bez leadů CPL NEEXISTUJE · bez rezervací CPA NEEXISTUJE → „—", ne 0. */
  function costOrDash(value, denom) {
    var n = num(denom);
    if (!n || n <= 0) return '—';
    var v = num(value);
    return (v == null || v === 0) ? '—' : fmtMoney(v);
  }
  function killMetricsHTML(d) {
    var items = (d._tab === 'earrings')
      ? [
          ['Spend', fmtMoney(d.spend)], ['CPA', costOrDash(d._cpa, d._reservations)], ['Tržba zaplaceno', fmtMoney(d._paid)],
          ['Poptávky', fmtInt(d._demands)], ['Rezervace', fmtInt(d._reservations)], ['ROAS zaplaceno', fmtRoas(d._roasPaid)]
        ]
      : [
          ['Spend', fmtMoney(d.spend)], ['CPA', costOrDash(d._cpa, d.bookings)], ['CPL', costOrDash(d.cpl, d.leads)],
          ['Leads', fmtInt(d.leads)], ['Rezervace', fmtInt(d.bookings)], ['Tržby', fmtMoney(d.revenue_real)],
          ['% hovorů', d._pct_call == null ? '—' : fmtPct(d._pct_call)],
          ['% rezervací', d._pct_schuzek == null ? '—' : fmtPct(d._pct_schuzek)],
          ['ROAS model', fmtRoas(d.roas_model)]
        ];
    return items.map(function (it) {
      return '<div class="mt"><span>' + esc(it[0]) + '</span><b>' + it[1] + '</b></div>';
    }).join('');
  }

  // Potvrzovací modal (vlastní, aby nekolidoval s openPreview → #modal-root).
  function killConfirm(opts) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'ads-modal-ov';
      ov.innerHTML =
        '<div class="ads-modal" role="dialog" aria-modal="true">' +
        '<div class="am-title">🔴 ' + esc(opts.title) + '</div>' +
        (opts.sub ? '<div class="am-sub">' + esc(opts.sub) + '</div>' : '') +
        (opts.metrics ? '<div class="am-metrics">' + opts.metrics + '</div>' : '') +
        '<label class="am-reason">Důvod <span class="am-opt">(volitelné)</span>' +
        '<textarea rows="2" placeholder="mladá / čekám data / strategická…"></textarea></label>' +
        '<div class="am-actions">' +
        '<button class="btn-ghost am-cancel" type="button">Zrušit</button>' +
        '<button class="btn-danger am-ok" type="button">Ano, zabít</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      var ta = ov.querySelector('textarea');
      function close(val) { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); }
      function doOk() { close({ ok: true, reason: ta.value.trim() }); }
      function onKey(e) {
        if (e.key === 'Escape') close({ ok: false });
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doOk();
      }
      ov.querySelector('.am-cancel').onclick = function () { close({ ok: false }); };
      ov.querySelector('.am-ok').onclick = doOk;
      ov.addEventListener('click', function (e) { if (e.target === ov) close({ ok: false }); });
      document.addEventListener('keydown', onKey);
      setTimeout(function () { ov.querySelector('.am-ok').focus(); }, 30);
    });
  }

  // POST kill pro každé ad_id, pak poll ad_status dokud PAUSED (1.5 s, max ~30 s).
  async function performKill(ids, creative, reason) {
    for (var i = 0; i < ids.length; i++) {
      await ADS.api('kill', { ad_id: ids[i], creative: creative, reason: reason }, { method: 'POST' });
    }
    var ok = await pollAllPaused(ids);
    if (!ok) throw new Error('Meta nepotvrdila vypnutí (timeout).');
    return true;
  }
  async function pollAllPaused(ids) {
    var pending = {}, cnt = 0;
    ids.forEach(function (id) { pending[id] = 1; cnt++; });
    var deadline = Date.now() + 30000;
    while (Date.now() < deadline && cnt > 0) {
      await sleep(1500);
      var keys = Object.keys(pending);
      for (var i = 0; i < keys.length; i++) {
        var id = keys[i];
        try {
          var r = await ADS.api('ad_status', { ad_id: id });
          var st = (r && (r.effective_status || r.status)) || '';
          if (/PAUSED/i.test(st)) { delete pending[id]; cnt--; }
        } catch (_) { /* přechodná chyba → zkusíme v dalším kole */ }
      }
    }
    return cnt === 0;
  }

  function setKillBtnLoading(cell, loading) {
    var el = cell.getElement();
    if (loading) {
      var btn = el.querySelector('.btn-kill');
      if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.innerHTML = '<span class="spin"></span>'; }
    } else {
      // reformat obnoví buňku (tlačítko zpět → retry).
      try { cell.getRow().reformat(); } catch (_) { }
    }
  }
  function markKilled(row) {
    var d = row.getData();
    d._killed = true; d.effective_status = 'PAUSED';
    (d.ads || []).forEach(function (a) { a.effective_status = 'PAUSED'; });
    try { row.reformat(); } catch (_) { }
  }
  function busKilled(detail) {
    if (ADS.bus && typeof ADS.bus.dispatchEvent === 'function') {
      ADS.bus.dispatchEvent(new CustomEvent('killed', { detail: detail }));
    }
  }

  /* Jádro killu kreativy — JEDNA cesta pro obě vstupní branky:
   *   • tlačítko ve sloupci Kill  → killCreativeFlow(cell)
   *   • pravý klik na řádek (T11) → killCreativeRow(row)
   * `busy` je VOLITELNÝ callback na kreslení spinneru. Kontextové menu ho nemá kam
   * kreslit — a hlavně: ve views „Nejnovější" a „All-time" sloupec Kill vůbec není
   * (defaultColumnKeys), takže by `.btn-kill` neexistoval. Proto je `busy` nepovinný
   * a ne natvrdo setKillBtnLoading(cell) jako dřív.
   * ⚠️ Logika (potvrzení, performKill, markKilled, bus) se NESMÍ rozdvojit — dvě kopie
   * = dva různé killy a Filip nepozná, který zrovna běžel. */
  async function killCreativeCore(row, busy) {
    var d = row.getData();
    if (d._killed) return;
    var ids = activeAdIds(d);
    if (!ids.length) { if (ADS.toast) ADS.toast('Žádné aktivní reklamy k vypnutí.', 'warn'); return; }
    var res = await killConfirm({
      title: 'Opravdu zabít „' + (d.creative || '') + '"?',
      sub: ids.length + ' aktivní reklam' + (ids.length === 1 ? 'a' : 'y') + ' v této kreativě',
      metrics: killMetricsHTML(d)
    });
    if (!res.ok) return;
    if (busy) busy(true);
    try {
      await performKill(ids, d.creative, res.reason);
      markKilled(row);
      if (ADS.toast) ADS.toast('„' + d.creative + '" vypnutá ✓', 'success');
      busKilled({ scope: 'creative', creative: d.creative, ad_ids: ids });
    } catch (err) {
      if (ADS.toast) ADS.toast('Kill selhal: ' + errMsg(err), 'error');
      if (busy) busy(false);
    }
  }
  function killCreativeFlow(cell) {
    return killCreativeCore(cell.getRow(), function (on) { setKillBtnLoading(cell, on); });
  }
  // T11: kill z kontextového menu — stejný tok, jen bez spinneru v tlačítku.
  function killCreativeRow(row) { return killCreativeCore(row, null); }

  async function killAdFlow(subCell, parentRow) {
    var a = subCell.getData();
    if (/PAUSED/i.test(a.effective_status || '') || /PAUSED/i.test(a.status || '')) return;
    var res = await killConfirm({
      title: 'Zabít reklamu ' + (a.ad_id || '') + '?',
      sub: a.copy_code || a.ad_name || '',
      metrics: '<div class="mt"><span>Spend</span><b>' + fmtMoney(a.spend) + '</b></div>'
    });
    if (!res.ok) return;
    setKillBtnLoading(subCell, true);
    var creative = parentRow.getData().creative;
    try {
      await performKill([a.ad_id], creative, res.reason);
      a.effective_status = 'PAUSED';
      var pd = parentRow.getData();
      var pa = (pd.ads || []).filter(function (x) { return x.ad_id === a.ad_id; })[0];
      if (pa) pa.effective_status = 'PAUSED';
      var allOff = (pd.ads || []).length && pd.ads.every(function (x) { return /PAUSED/i.test(x.effective_status || ''); });
      if (allOff) markKilled(parentRow);          // rebuildne i sub-tabulku
      else { try { subCell.getRow().reformat(); } catch (_) { } }
      if (ADS.toast) ADS.toast('Reklama ' + a.ad_id + ' vypnutá ✓', 'success');
      busKilled({ scope: 'ad', ad_id: a.ad_id, creative: creative });
    } catch (err) {
      if (ADS.toast) ADS.toast('Kill selhal: ' + errMsg(err), 'error');
      setKillBtnLoading(subCell, false);
    }
  }

  // Cross-table: když se něco zabije jinde, promítni to i sem.
  // Překresluj podle SHODY řádku, ne podle toho, jestli se data změnila:
  // stejná kreativa může být ve víc tabulkách a klidně sdílet tentýž objekt
  // (nebo už být označená) — gate na "změnu" by pak řádek nikdy nepřekreslil.
  function onKilledEvent(e) {
    var det = e.detail || {};
    // scope je nepovinný: wizard historicky posílal jen {ad_id, creative} (bez scope).
    // Bez odvození by takový event nesedl na žádnou větev → tichý no-op (řádek by se
    // nepřepsal na „⏸ Vypnutá"). ad_id vyhrává nad creative: vypnutí JEDNÉ reklamy
    // nesmí zašedit celou kreativu, dokud nejsou vypnuté všechny její ady.
    var scope = det.scope || (det.ad_id ? 'ad' : (det.creative ? 'creative' : ''));
    Object.keys(tables).forEach(function (id) {
      var t = tables[id]; if (!t || !t.getRows) return;
      try {
        t.getRows().forEach(function (r) {
          var d = r.getData(), match = false;
          if (scope === 'creative' && det.creative && d.creative === det.creative) {
            d._killed = true; d.effective_status = 'PAUSED';
            (d.ads || []).forEach(function (a) { a.effective_status = 'PAUSED'; });
            match = true;
          } else if (scope === 'ad' && det.ad_id && d.ads) {
            d.ads.forEach(function (a) { if (a.ad_id === det.ad_id) { a.effective_status = 'PAUSED'; match = true; } });
            if (match && d.ads.length && d.ads.every(function (a) { return /PAUSED/i.test(a.effective_status || ''); })) d._killed = true;
          }
          if (match) r.reformat();   // idempotentní
        });
      } catch (_) { }
    });
  }

  /* ------------------------------------------------------------------ *
   *  Rozklik → pod-tabulka jednotlivých ad
   * ------------------------------------------------------------------ */
  // Souhrnný stav kreativy z jejích ad (kolik jich ještě běží).
  function creativeStatusHTML(d) {
    var ads = d.ads || [];
    if (!ads.length) return statusChipHTML(d.effective_status || '');
    var act = ads.filter(function (a) { return !/PAUSED/i.test(a.effective_status || ''); }).length;
    if (!act) return '<span class="st st-off">⏸ Vypnutá</span>';
    return '<span class="st st-on" title="' + act + ' z ' + ads.length + ' reklam běží">● Aktivní ' + act + '/' + ads.length + '</span>';
  }

  /* FEEDBACK I2: v rozkliku byl JEN spend → doplňujeme stejné metriky jako v hlavním řádku.
   * ⚠️ POCTIVĚ: leady/tržby/ROAS NEJDOU rozpadnout na jednotlivé ad_id — BigQuery páruje
   * leady na KÓD KREATIVY (`kreativa_lead`), ne na ad_id, takže per-ad existuje jen spend
   * (z Meta insights). Proto jsou metriky nahoře jako pruh ZA CELOU KREATIVU a v tabulce
   * pod tím je per-ad to, co je opravdu per-ad: spend, jeho podíl, stav, odkaz, kill.
   * Rozpočítat tržbu podle podílu spendu by byla vymyšlená čísla → NEDĚLÁME. */
  // Metriky za celou kreativu, tab-gated (K1: náušnice CPL nemají — api.php ho ani neposílá).
  // Sdílí je rozklik (sub-head) i modal grafu trendu (M1) → jeden zdroj pravdy, ať se
  // nerozejde, co Filip vidí na dvou místech o téže kreativě.
  // D1/D4: v rozkliku i v modalu grafu je CPA i CPL (Filip: „nejčastěji když se sníží CPL,
  // tak se to propadne") a nově i ZRALOST — u ROAS musí být vidět, z kolika procent je
  // dopočtený, ať se dvě čísla nečtou stejně sebevědomě.
  /* K1 — metriky v detailu SESKUPENÉ do smysluplných rodin (Filip: plochá mřížka 12
   * dlaždic je nepřehledná). Vrací POLE SKUPIN: [ [nadpis, [[label,val],…]], … ]. */
  function metricItems(d) {
    var zr = (d._zralost != null) ? d._zralost : zralostOf(d);
    var zrTxt = (zr == null) ? '—' : (Math.round(zr * 100) + ' %');
    return (d._tab === 'earrings')
      ? [
          ['💰 Peníze', [
            ['Spend', fmtMoney(d.spend)],
            ['Tržba zaplaceno', fmtMoney(d._paid)],
            ['Tržba celkem', fmtMoney(d._createdRev)]
          ]],
          ['🔻 Trychtýř', [
            ['Poptávky', fmtInt(d._demands)],
            ['Rezervace', fmtInt(d._reservations)]
          ]],
          ['🏷 Cena', [
            ['CPA', costOrDash(d._cpa, d._reservations)]
          ]],
          ['📈 ROAS', [
            ['ROAS zaplaceno', fmtRoas(d._roasPaid)],
            ['ROAS celkem', fmtRoas(d._roasTotal)]
          ]],
          ['🌡 Zralost', [
            ['Zralost', zrTxt]
          ]]
        ]
      : [
          ['💰 Peníze', [
            ['Spend', fmtMoney(d.spend)],
            ['Tržba real', fmtMoney(d.revenue_real)],
            ['Tržba model', fmtMoney(d.revenue_model)]
          ]],
          ['🔻 Trychtýř', [
            ['Leadů', fmtInt(d.leads)],
            ['Rezervace', fmtInt(d.bookings)],
            ['% hovorů', d._pct_call == null ? '—' : fmtPct(d._pct_call)],
            ['% rezervací', d._pct_schuzek == null ? '—' : fmtPct(d._pct_schuzek)]
          ]],
          ['🏷 Cena', [
            ['CPA', costOrDash(d._cpa, d.bookings)],
            ['CPL', costOrDash(d.cpl, d.leads)]
          ]],
          ['📈 ROAS', [
            ['ROAS real', fmtRoas(d.roas_real)],
            ['ROAS model', fmtRoas(d.roas_model)]
          ]],
          ['🌡 Zralost', [
            ['Zralost', zrTxt]
          ]]
        ];
  }
  function metricTilesHTML(groups) {
    // Zpětná kompatibilita: kdyby přišel starý plochý seznam [[l,v],…] (bez skupin),
    // pozná se podle toho, že druhý prvek NENÍ pole skupinových dvojic → obalí se.
    var isGrouped = groups.length && Array.isArray(groups[0]) && Array.isArray(groups[0][1]) &&
                    groups[0][1].length && Array.isArray(groups[0][1][0]);
    var gs = isGrouped ? groups : [['', groups]];
    return gs.map(function (g) {
      var head = g[0] ? '<div class="mt-g">' + esc(g[0]) + '</div>' : '';
      var tiles = g[1].map(function (it) {
        return '<div class="mt"><span>' + esc(it[0]) + '</span><b>' + it[1] + '</b></div>';
      }).join('');
      return head + tiles;
    }).join('');
  }

  /* --- FEEDBACK C2: „rozkliknutý obsah má metriky hnusně nalepeně pod sebou" -----------
   * PŘÍČINA: `.sub-mt` / `.sub-head` / `.sub-note` NEMĚLY v injektovaném CSS ani řádek
   * (na rozdíl od `.tm-mt` v modalu grafu) → z kachlíků se staly holé <div>y a ty se
   * naskládaly pod sebe. Odtud „nalepeně".
   * ŘEŠENÍ (Filip: „musí být v řádku, sloupcově zarovnané pod hlavičkou parenta,
   * aby čísla lícovala"): metriky za celou kreativu kreslíme jako PRUH, který přebírá
   * mřížku parent tabulky — pro každý viditelný sloupec parenta vyrobíme buňku o JEHO
   * šířce a hodnotu dáme do té, kde parent ukazuje tutéž metriku. Číslo tak sedí přesně
   * pod svojí hlavičkou.
   * Šířky čteme ŽIVĚ z Tabulatoru (column.getWidth()), ne z definic → pruh lícuje i po
   * uživatelově resize/přehození sloupců (E2/E3). Po každé takové změně ho překreslí
   * realignSubrows().
   * ⚠️ Proto má `.ads-subwrap` nulový horizontální padding — jakýkoli by mřížku posunul.
   */

  // field sloupce parenta → hodnota metriky ZA CELOU KREATIVU (už naformátovaná).
  // Klíče musí sedět s `field` v registru colDef() (RING_METRICS / EAR_METRICS).
  function metricByField(d) {
    var m = {};
    m.spend = fmtMoney(d.spend);
    // Stejný guard jako v tabulce a v kill modalu: bez jmenovatele cena NEEXISTUJE → „—", ne 0.
    m._cpa = costOrDash(d._cpa, (d._tab === 'earrings') ? d._reservations : d.bookings);
    m._burned = fmtMoney(d._burned);
    // A3/A4 + F1: nové sloupce musí mít svou hodnotu i v pruhu pod rozklikem, jinak by pod
    // nimi zela díra a pruh by přestal lícovat čitelně.
    var zr = (d._zralost != null) ? d._zralost : zralostOf(d);
    m._zralost = (zr == null) ? '—' : (Math.round(zr * 100) + ' %');
    m.spend_pct = (num(d.spend_pct) == null) ? '—' : (Math.round(pctNorm(d.spend_pct) * 100) + ' %');
    if (d._tab === 'earrings') {
      m._demands = fmtInt(d._demands);
      m._reservations = fmtInt(d._reservations);
      m._paid = fmtMoney(d._paid);
      m._createdRev = fmtMoney(d._createdRev);
      m._roasPaid = fmtRoas(d._roasPaid);
      m._roasTotal = fmtRoas(d._roasTotal);
      m._roasCalc = fmtRoas(d._roasCalc);
    } else {
      m.leads = fmtInt(d.leads);
      m.bookings = fmtInt(d.bookings);
      m.cpl = costOrDash(d.cpl, d.leads);                        // D4: CPL i v rozkliku
      m._pct_call = (d._pct_call == null) ? '—' : fmtPct(d._pct_call);
      m._pct_schuzek = (d._pct_schuzek == null) ? '—' : fmtPct(d._pct_schuzek);
      m.revenue_real = fmtMoney(d.revenue_real);
      m.revenue_model = fmtMoney(d.revenue_model);               // F1
      m.roas_real = fmtRoas(d.roas_real);
      m.roas_model = fmtRoas(d.roas_model);
    }
    return m;
  }

  // Živá mřížka parenta: [{field, width, right}] jen pro VIDITELNÉ sloupce, v aktuálním pořadí.
  function parentColMeta(parentRow) {
    try {
      var t = parentRow.getTable();
      if (!t || typeof t.getColumns !== 'function') return null;
      return t.getColumns().filter(function (c) {
        try { return c.isVisible(); } catch (_) { return true; }
      }).map(function (c) {
        var def = {};
        try { def = c.getDefinition() || {}; } catch (_) { }
        return { field: c.getField() || '', width: c.getWidth() || 0, right: def.hozAlign === 'right' };
      }).filter(function (c) { return c.width > 0; });
    } catch (e) { console.warn('[tables] mřížku parenta nejde přečíst:', e); return null; }
  }

  function subAlignedStripHTML(d, parentRow) {
    var cols = parentColMeta(parentRow);
    if (!cols || !cols.length) return '';   // bez mřížky radši pruh nekreslíme, než ho kreslit křivě
    var vals = metricByField(d), labelDone = false;
    var cells = cols.map(function (c) {
      var v = vals[c.field];
      if (v != null) {
        return '<div class="sas-c sas-v' + (c.right ? ' r' : '') + '" style="width:' + c.width + 'px">' + v + '</div>';
      }
      // Popisku pruhu dáme do prvního nemetrikového sloupce, který na ni má místo
      // (typicky „Kreativa") → pruh se čte jako součtový řádek pod parentem.
      // „Celá kreativa" (ne „Za celou kreativu"): delší varianta se do 112px sloupce
      // Kreativa nevešla a sama se usekávala na „ZA CELOU KREATIV…" (ověřeno v prohlížeči).
      if (!labelDone && c.width >= 104) {
        labelDone = true;
        return '<div class="sas-c sas-lbl" style="width:' + c.width + 'px">Celá kreativa</div>';
      }
      return '<div class="sas-c" style="width:' + c.width + 'px"></div>';
    }).join('');
    return '<div class="sub-align">' + cells + '</div>';
  }

  function subMetricsHTML(d, parentRow) {
    var strip = subAlignedStripHTML(d, parentRow);
    // Fallback (mřížka nedostupná): kachlíky v ŘÁDKU — `.sub-mt` už má CSS, nenalepí se.
    if (!strip) strip = '<div class="sub-mt">' + metricTilesHTML(metricItems(d)) + '</div>';
    return '<div class="sub-head">' +
      '<div class="sub-head-l"><span class="sub-h-code">' + esc(d.creative || '—') + '</span>' + creativeStatusHTML(d) + '</div>' +
      '<button class="btn-ghost sm sub-trend" type="button">📈 Graf trendu</button>' +
      '</div>' + strip;
  }

  function subAdColumns(parentRow) {
    return [
      {
        title: 'Náhled', field: '_p', width: 72, minWidth: 64, cssClass: 'c-prev',
        formatter: function (c) { return subPreviewHTML(c.getData()); },
        // P1-B: sub-řádek = jedna instance reklamy (bez agregátních polí) → otevři
        // bohatý detail RODIČOVSKÉ kreativy; fallback = velký náhled té konkrétní reklamy.
        cellClick: function (e, c) { openRowDetail(parentRow.getData(), subAdBig(c.getData(), parentRow)); },
        cellMouseEnter: function (e, c) { showHover(c.getData(), c); },
        cellMouseLeave: function () { hideHover(); }
      },
      { title: 'Ad ID', field: 'ad_id', width: 140, cssClass: 'c-id', formatter: function (c) { return '<span class="mono">' + esc(c.getValue() || '—') + '</span>'; } },
      // Copy varianta (text ZA `|`) patří sem, ne do sloupce Náhled (FEEDBACK A3/B1) —
      // tady rozlišuje jednotlivé instance téže kreativy, což je přesně k čemu je.
      {
        title: 'Copy', field: 'copy_code', minWidth: 130, cssClass: 'c-copy',
        formatter: function (c) {
          var a = c.getData(), v = a.copy_code || a.ad_name || '';
          return v ? '<span class="copy-code" title="' + esc(v) + '">' + esc(String(v).slice(0, 42)) + '</span>' : '<span class="muted">—</span>';
        }
      },
      // Filip: u každé reklamy v rozkliku vidět, KDE běží — kampaň + ad set (event + cílení).
      {
        title: 'Kampaň / Ad set', field: 'campaign_name', minWidth: 180, cssClass: 'c-camp', headerSort: false,
        formatter: function (c) {
          var a = c.getData();
          var camp = (a.campaign_name || '').trim(), adset = (a.adset_name || '').trim();
          if (!camp && !adset) return '<span class="muted" title="doplní se při nejbližším Meta refreshi">—</span>';
          return '<div class="camp-cell">' +
            '<span class="camp-c" title="' + esc(camp) + '">📣 ' + esc(camp || '—') + '</span>' +
            '<span class="camp-a" title="' + esc(adset) + '">👥 ' + esc(adset || '—') + '</span>' +
            '</div>';
        }
      },
      { title: 'Stav', field: 'effective_status', width: 120, formatter: function (c) { return statusChipHTML(c.getValue()); } },
      colMoney('Spend', 'spend'),
      {
        title: '% kreativy', field: '_share', width: 104, sorter: 'number', cssClass: 'c-bar',
        formatter: function (c) {
          var p = num(c.getValue()) || 0, w = Math.max(2, Math.min(100, Math.round(p * 100)));
          return '<div class="bar"><div class="bar-fill" style="width:' + w + '%"></div>' +
            '<span class="bar-lbl">' + Math.round(p * 100) + ' %</span></div>';
        }
      },
      { title: 'Odkaz', field: 'adsmanager_link', minWidth: 130, headerSort: false, formatter: function (c) { return amLinkHTML(c.getData()); } },
      {
        title: '', field: '_k', width: 92, hozAlign: 'center', headerSort: false, cssClass: 'c-kill',
        formatter: function (c) {
          return /PAUSED/i.test(c.getData().effective_status || '') ? '<span class="tag-off">⏸</span>' : '<button class="btn-kill sm" type="button">Kill</button>';
        },
        cellClick: function (e, c) { if (e.target.closest('.btn-kill')) killAdFlow(c, parentRow); }
      }
    ];
  }
  function subAdBig(a, parentRow) {
    var pd = parentRow ? parentRow.getData() : {};
    var big = thumbBigOf(a), o = {}; for (var k in a) o[k] = a[k];
    if (big) o.image_url = big;
    if (!o.creative && pd.creative) o.creative = pd.creative;
    if (!o.funnel && pd.funnel) o.funnel = pd.funnel;
    return o;
  }

  function buildSubTable(holder, d, parentRow) {
    var all = (d.ads || []).map(function (a) { var o = {}; for (var k in a) o[k] = a[k]; return o; });
    if (!all.length) { holder.innerHTML = '<div class="sub-empty">Žádné jednotlivé reklamy.</div>'; return; }

    // I3: řadit podle spendu DESC (nespoléhat na pořadí z API — mock ho nedrží)
    // a potlačit instance s NULOVÝM spendem: Meta má u jedné kreativy reálně i 16 naduplikovaných
    // ad přes ad sety (ověřeno u P-647-001) → bez tohohle je rozklik samý balast.
    all.sort(function (a, b) { return (num(b.spend) || 0) - (num(a.spend) || 0); });
    var total = sum(all, function (a) { return a.spend; });
    all.forEach(function (a) { a._share = total > 0 ? (num(a.spend) || 0) / total : 0; });

    var live = all.filter(function (a) { return (num(a.spend) || 0) > 0; });
    var zero = all.filter(function (a) { return !((num(a.spend) || 0) > 0); });
    // Kdyby spend neměla ANI JEDNA (kreativa mimo okno), nemá co potlačovat → ukaž všechny.
    if (!live.length) { live = all; zero = []; }

    holder.innerHTML = subMetricsHTML(d, parentRow);
    var trendBtn = holder.querySelector('.sub-trend');
    if (trendBtn) trendBtn.onclick = function (e) { e.stopPropagation(); openTrendModal(d); };

    // C2: `.ads-subwrap` má nulový horizontální padding, aby `.sub-align` lícoval s mřížkou
    // parenta. Odsazení proto nese až `.sub-body` — všechno, co lícovat NEMÁ (per-ad tabulka
    // s vlastními sloupci, poznámka, přepínač nul).
    var body = document.createElement('div');
    body.className = 'sub-body';
    body.innerHTML =
      '<div class="sub-note">Metriky v pruhu výš jsou za <b>celou kreativu</b> — leady a tržby se párují na kód kreativy, ' +
      'ne na jednotlivou reklamu. Per reklamu má Meta jen spend, proto je v tabulce níž jen on.</div>';
    holder.appendChild(body);

    // Tabulator si přebarví mount element na .tabulator → mountuj do vnitřního divu,
    // ať .sub-body zůstane čistý layout wrapper (padding/pozadí).
    var inner = document.createElement('div');
    inner.className = 'ads-sub-tbl';
    body.appendChild(inner);

    function mkTable(el, rows) {
      return new window.Tabulator(el, {
        data: rows,
        layout: 'fitColumns',
        index: 'ad_id',
        headerSort: false,
        renderVertical: 'basic',
        placeholder: 'Žádné reklamy.',
        columns: decorateHeaders(subAdColumns(parentRow), true)   // F2 (hinty ano, očičko ne)
      });
    }
    holder._sub = mkTable(inner, live);

    if (zero.length) {
      var allPaused = zero.every(function (a) { return /PAUSED/i.test(a.effective_status || ''); });
      var label = '+ ' + zero.length + (allPaused ? ' vypnutých' : '') + ' bez spendu' +
        (allPaused ? '' : ' (' + zero.filter(function (a) { return /PAUSED/i.test(a.effective_status || ''); }).length + ' vypnutých)');
      var tog = document.createElement('button');
      tog.className = 'btn-ghost sm sub-zero-tog';
      tog.type = 'button';
      tog.textContent = label;
      tog.title = 'Instance téže kreativy bez spendu za období (naduplikované přes ad sety) — schované, ať nedělají balast.';
      var zwrap = document.createElement('div');
      zwrap.className = 'ads-sub-tbl zero';
      zwrap.hidden = true;
      body.appendChild(tog);
      body.appendChild(zwrap);
      tog.onclick = function (e) {
        e.stopPropagation();
        zwrap.hidden = !zwrap.hidden;
        tog.classList.toggle('open', !zwrap.hidden);
        tog.textContent = zwrap.hidden ? label : '− skrýt ' + zero.length + ' bez spendu';
        if (!zwrap.hidden && !holder._subZero) holder._subZero = mkTable(zwrap, zero);
      };
    }
  }

  // rowFormatter pro tabulky s rozklikem (kill/winners/earrings).
  function expandableRowFormatter(row) {
    var d = row.getData(), el = row.getElement();
    el._adsRow = row;                       // ★ F8/A3 — kotva pro vlastní delegovaný klik (viz wireRowClicks)
    el.classList.toggle('is-killed', !!d._killed);
    var holder = el.querySelector(':scope > .ads-subwrap');
    if (d._expanded) {
      if (!holder) {
        holder = document.createElement('div');
        holder.className = 'ads-subwrap';
        el.appendChild(holder);
        buildSubTable(holder, d, row);
      }
    } else if (holder) {
      if (holder._sub) { try { holder._sub.destroy(); } catch (_) { } }
      if (holder._subZero) { try { holder._subZero.destroy(); } catch (_) { } }
      holder.remove();
    }
  }
  // rowFormatter pro tabulky bez rozkliku (jen šedivění killnutých).
  function plainRowFormatter(row) {
    row.getElement()._adsRow = row;         // ★ F8/A3 — viz wireRowClicks
    row.getElement().classList.toggle('is-killed', !!row.getData()._killed);
  }

  /* ------------------------------------------------------------------ *
   *  M1: modal „graf trendu" jedné kreativy
   * ------------------------------------------------------------------ *
   * NÁLEZ #8: openTrendModal se volala ze 3 míst (šipka trendu, tlačítko v rozkliku,
   * klik na řádek), ale NIKDY nebyla definovaná → ReferenceError a modal navěky na
   * „Načítám…". Tady je implementace.
   *
   * Graf kreslí charts.js přes window.ADS.miniTrend(el,{creative,tab,from,to}) —
   * ten drží osu Y od 0, ořez p95, breakeven čáru na 1,0 i vlastní loading/error stav.
   * My dodáváme jen rám: název kreativy, období, metriky, VAROVÁNÍ O DOZRÁVÁNÍ a úklid.
   *
   * ⚠️ DOZRÁVÁNÍ — proč je tu ten žlutý pruh:
   * miniTrend šrafuje jen posledních ESTIMATING_DAYS (=3) dní, ale tržba dozrává ~14 DNÍ
   * (config.php MATURITY_CURVE, přeměřeno 16. 7.: 0 d = 30 % … 13 d = 91 % · 14+ d = 100 %).
   * Na pravém konci každého okna tedy ROAS křivka MUSÍ klesat — je to artefakt měření,
   * ne propad výkonu. Bez téhle věty by modal dělal přesně to, co nález #4 vyčítá týdennímu
   * grafu: Filip přečte „kreativa se hroutí" a zabije funkční reklamu.
   */
  var trendModal = null;   // {ov, inst} — otevřený je vždy max jeden

  /* ===========================================================================
   * F7/A5 — „NEJDE ROZKLIKNOUT ŘÁDEK ANI NÁHLED" (Filip 23. 7.: „někdy se mi stane,
   * že při tom, co si třeba přepnu záložku a změním řazení… Už jsme to jednou řešili,
   * ale děje se to furt.")
   *
   * 🔴 TENHLE ROZBOR BYL NEÚPLNÝ — viz F8/A3 u `wireRowClicks()`. Držel se toho, že
   * „handler se neztratí, protože je delegovaný", což je pravda, ALE Tabulator si ke
   * kliknutému <div> musí objekt řádku teprve dohledat (`getVisibleRows().find(...)`)
   * a když se netrefí, TIŠE nedispatchne — handler tedy sedí na místě a stejně se nic
   * nestane. To byla ta hlavní příčina (10. 8.) a řeší ji vlastní delegace ve
   * `wireRowClicks()`. Osiřelý overlay níž je DRUHÁ, samostatná cesta ke stejnému
   * projevu — platí dál, jen nevysvětluje případy, kdy na obrazovce žádná vrstva není.
   *
   * DRUHÝ MECHANISMUS: OSIŘELÝ OVERLAY. Trend modal, detail náušnic, kill dialog
   * i přiřazení funnelu si každý staví vlastní `.ads-modal-ov` rovnou do <body>
   * (position:fixed; inset:0; z-index:10000). Zavírají se přes vlastní referenci
   * (`trendModal`, `earDetailOv`) — a `closeTrendModal()` na začátku dělá `if (!trendModal) return`.
   * Jakmile se reference a DOM rozejdou (výjimka mezi appendChild a přiřazením reference,
   * nebo přepnutí tabu/období, které overlay nikdy nezavře), zůstane v DOM neviditelná
   * průhledná vrstva přes celou obrazovku. Klik na řádek i na náhled pak trefí JI, ne tabulku —
   * navenek to vypadá, že „přestalo fungovat rozklikávání".
   *
   * OPRAVA JE DVOJÍ (obojí je potřeba):
   *   1. `sweepOverlays()` — tvrdý úklid podle DOM, ne podle referencí. Nezávisí na tom,
   *      jestli si nějaký modal svůj stav ohlídal.
   *   2. Volá se při KAŽDÉ změně kontextu (tab / období / refresh) a na Escape.
   * ======================================================================== */
  /* ⚠️ 10. 8. — SELEKTOR BYL PŘÍLIŠ ÚZKÝ. `body > .ads-modal-ov` mine VŠECHNY ostatní
   * celoobrazovkové vrstvy, které si dashboard staví jinam:
   *   · `#modal-root .modal-overlay` (app.js `_modal` → openPreview) — NENÍ dítě <body>
   *   · `#wizard-root.hw-overlay` (wizard.js) — když `close()` spadne dřív, než dojde
   *     k `rootEl.className = ''` (disposeCharts/hideHoverPop nejsou v try), zůstane
   *     viset fixní vrstva se z-indexem 8000 přes celou obrazovku
   *   · zámek scrollu `html.ads-modal-open` + `documentElement.style.overflow` — přežije
   *     odstraněný overlay a tváří se pak jako „zaseknutá stránka"
   * Úklid proto jede podle DOMU napříč celým dokumentem, ne podle rodiče a ne podle
   * referencí jednotlivých modalů. */
  function sweepOverlays(reason) {
    var n = 0;
    try {
      var list = document.querySelectorAll('.ads-modal-ov, #modal-root .modal-overlay');
      for (var i = 0; i < list.length; i++) { list[i].remove(); n++; }
      // Wizard: sahej na něj JEN když sám tvrdí, že je zavřený (jinak bych ho zabil za běhu).
      var wr = document.getElementById('wizard-root');
      var wizOpen = !!(window.ADSWizard && window.ADSWizard.isOpen && window.ADSWizard.isOpen());
      if (wr && wr.className && !wizOpen) { wr.className = ''; wr.innerHTML = ''; n++; }
      if (!wizOpen) {
        document.documentElement.classList.remove('ads-modal-open');
        if (document.documentElement.style.overflow === 'hidden') document.documentElement.style.overflow = '';
      }
    } catch (_) { /* nic — úklid nesmí shodit zbytek */ }
    if (n) {
      // Reference musí spadnout s DOM, jinak by closeTrendModal() dál věřil, že něco visí.
      try { if (trendModal && trendModal.inst && trendModal.inst.dispose) trendModal.inst.dispose(); } catch (_) { }
      trendModal = null;
      earDetailOv = null;
      try { console.warn('[ads] uklizeno ' + n + ' viselých overlayů (' + (reason || '?') + ')'); } catch (_) { }
    }
    return n;
  }

  function closeTrendModal() {
    if (!trendModal) return;
    var t = trendModal;
    trendModal = null;
    try { if (t.inst && typeof t.inst.dispose === 'function') t.inst.dispose(); } catch (_) { }
    document.removeEventListener('keydown', t.onKey);
    if (t.ov && t.ov.parentNode) t.ov.remove();
  }

  // Délka okna ve dnech (from/to jsou 'YYYY-MM-DD').
  function windowDays(from, to) {
    var a = Date.parse(from), b = Date.parse(to);
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.round((b - a) / 86400000) + 1;
  }
  /* ⚠️ SLOVNÍK (FEEDBACK-3 R1/R2) — tenhle pruh mluví o DOZRÁVÁNÍ TRŽBY (stáří dat),
   * NE o „zralosti". Slovo „zralost" je od iterace 3 REZERVOVANÉ pro Filipovu veličinu
   * (pct_call × pct_schuzek = kolik % tržby je reálné) a má vlastní sloupec i kachlík
   * v tomhle modalu. Kdyby tu zůstalo v obou významech, čte Filip v jednom okně dvě různá
   * čísla se stejným názvem — přesně ten zmatek, který A1 řeší.
   *
   * ⚠️ ČÍSLA JSOU Z config.php `MATURITY_CURVE['rings']`, ne z hlavy. Původní text tu recitoval
   * starou křivku „8 týdnů" (0–6 d = 6 % … 56+ d = 100 %), kterou ale config.php sám označuje
   * za ❌ NEPOUŽÍVAT: vznikla porovnáváním RŮZNÝCH kohort (sezónnost + kvalita kreativ)
   * a podhodnocovala čerstvá data ~3×. Přeměřeno 16. 7. na BQ `Trzby_a_schuzky`
   * (5 592 schůzek / 41,5 mil. Kč) lagem UVNITŘ kohorty → hranice tvrdých dat je 14 DNÍ.
   * Modal proto tvrdil pravý opak toho, co má nástroj v configu.
   *
   * Okno ≤ 14 dní → nedozrálá je CELÁ křivka. Okno > 14 dní → artefakt jen na pravém konci. */
  function maturityNoteHTML(from, to) {
    var n = windowDays(from, to);
    var whole = (n == null) || (n <= 14);
    var body = whole
      ? '<b>Celá tahle křivka je z nedozrálé tržby — klesající pravý konec je dozrávání, ne propad výkonu.</b> ' +
        (n != null ? 'Okno má ' + fmtInt(n) + ' dní, ale tržba dozrává ~14 dní. ' : 'Tržba dozrává ~14 dní. ')
      : '<b>Posledních ~14 dní křivky je z nedozrálé tržby — klesající pravý konec je dozrávání, ne propad výkonu.</b> ';
    return '<div class="tm-warn" role="note">' +
      '<span class="tm-warn-i" aria-hidden="true">⚠️</span>' +
      '<span>' + body +
      'Kolik tržby je už vidět podle stáří leadu: 0 d = 30 % · 1 d = 50 % · 3 d = 71 % · 7 d = 84 % · 13 d = 91 % · 14+ d = 100 %. ' +
      'Čerstvé dny vypadají VŽDY hůř — podle pravého konce křivky nekillovat. ' +
      '<i>(Tohle je stáří dat. Kachlík „Zralost" níž je něco jiného: kolik % tržby je reálné a kolik dopočet.)</i></span>' +
      '</div>';
  }

  function openTrendModal(d) {
    if (!d) return;
    var creative = String((d && d.creative) || '').trim();
    if (!creative) { if (ADS.toast) ADS.toast('Řádek nemá kód kreativy — trend nejde načíst.', 'warn'); return; }

    closeTrendModal();   // druhý klik nesmí nechat viset starý graf (leak ECharts instance)

    var s = st();
    var tab = d._tab || s.tab || 'rings';
    var from = s.from, to = s.to;

    var ov = document.createElement('div');
    ov.className = 'ads-modal-ov ads-trend-ov';
    ov.innerHTML =
      '<div class="ads-modal ads-trend-modal" role="dialog" aria-modal="true" aria-label="Graf trendu kreativy">' +
      '<div class="tm-head">' +
      '<div class="tm-head-l">' +
      '<div class="tm-title">📈 <span class="tm-code">' + esc(creative) + '</span>' +
      (d.funnel ? '<span class="chip chip-funnel" title="' + esc(d.funnel) + '">' + esc(d.funnel) + '</span>' : '') +
      '</div>' +
      '<div class="tm-sub">' + esc(tab === 'earrings' ? 'Náušnice' : 'Prsteny') +
      ' · <span class="tm-range">' + esc(fmtDate(from)) + ' – ' + esc(fmtDate(to)) + '</span></div>' +
      '</div>' +
      /* ★ G8 — VLASTNÍ OBDOBÍ GRAFU KREATIVY. Filip: „chtěl bych tam mít možnost, aby jsem
       * v rámci toho grafu tý kreativy, i když nahoře mám v tom hlavním dashboardu třeba
       * třicet dnů, abych si mohl vybrat, že u tý kreativy se dívám na delší dobu, že si
       * budu moct sám přepínat jiný období ještě v tom grafu tý jednotlivý otevřený kreativy…
       * Jako zásadní věc teda u toho grafu, aby tam šlo upravovat to období."
       * Nemění GLOBÁLNÍ picker schválně — je to zoom do jedné kreativy, ne přenastavení
       * celého dashboardu. Po zavření modalu je nahoře pořád to, co tam bylo. */
      '<div class="tm-per" role="group" aria-label="Období grafu">' +
        TM_PERIODS.map(function (p) {
          return '<button type="button" class="tm-p" data-d="' + p.d + '">' + esc(p.t) + '</button>';
        }).join('') +
      '</div>' +
      '<button class="tm-x" type="button" title="Zavřít (Esc)" aria-label="Zavřít">×</button>' +
      '</div>' +
      '<div class="tm-mnote">' + maturityNoteHTML(from, to) + '</div>' +
      // F7/C3 — přepínač optimalizací/eventů (plní se až po načtení, viz loadOpts níž)
      '<div class="tm-opt" hidden></div>' +
      '<div class="tm-chart"></div>' +
      '<div class="tm-mt">' + metricTilesHTML(metricItems(d)) + '</div>' +
      '<div class="tm-note">Graf i <b>dlaždice s metrikami se mění podle zvoleného období</b> — ' +
      'přepínač nahoře přepočítá obojí (Filip 20. 7.). Číslo z řádku tabulky uvidíš, když necháš okno ' +
      'na tom z horní lišty.</div>' +
      '</div>';
    document.body.appendChild(ov);

    function onKey(e) { if (e.key === 'Escape') closeTrendModal(); }
    /* ⚠️ F7/A5 — referenci nastavit HNED po appendChild, PŘED drátováním.
     * Když dřív cokoli mezi appendChild a přiřazením `trendModal` hodilo výjimku
     * (chybějící .tm-x apod.), overlay zůstal v DOM, ale closeTrendModal() ho už nikdy
     * nenašel (`if (!trendModal) return`) → neviditelná vrstva přes celou stránku
     * a „nejde nic rozkliknout". Teď je zavíratelný od první chvíle. */
    trendModal = { ov: ov, inst: null, onKey: onKey };
    document.addEventListener('keydown', onKey);
    try {
      ov.querySelector('.tm-x').onclick = closeTrendModal;
      ov.addEventListener('click', function (e) { if (e.target === ov) closeTrendModal(); });
    } catch (e) {
      try { console.warn('[ads] trend modal: drátování zavírání selhalo', e); } catch (_) { }
    }
    setTimeout(function () { try { ov.querySelector('.tm-x').focus(); } catch (_) { } }, 30);

    // Graf až TEĎ, když je mount v DOM (ECharts potřebuje nenulové rozměry).
    var host = ov.querySelector('.tm-chart');

    /* Filip 20. 7.: přepínač okna má měnit i DLAŽDICE, ne jen graf. Refetchneme metriky
     * kreativy za nové okno a překreslíme kachlíky. Cache per okno, ať přepínání nesekáme. */
    var _tileCache = {};
    // F7/C3: aktuálně vybraná optimalizace ('' = všechny dohromady) + poslední okno grafu.
    // Drží se tady, ne v modulu: platí jen pro tenhle otevřený modal.
    var curEvent = '', curFrom = from, curTo = to;
    function renderTiles(row) {
      var mt = ov.querySelector('.tm-mt');
      if (mt) { mt.innerHTML = metricTilesHTML(metricItems(row || d)); mt.classList.remove('is-loading'); }
    }
    function refreshTiles(fromISO, toISO) {
      var mt = ov.querySelector('.tm-mt');
      if (!mt) return;
      var key = fromISO + '|' + toISO + '|' + curEvent;   // F7/C3: event do klíče
      if (_tileCache[key]) { renderTiles(_tileCache[key]); return; }
      mt.classList.add('is-loading');
      var pars = { from: fromISO, to: toISO, tab: tab };
      if (curEvent) pars.event = curEvent;                 // F7/C3
      ADS.api('creatives', pars).then(function (rows) {
        if (!trendModal || trendModal.ov !== ov) return;   // modal už zavřený → zahoď
        var row = (Array.isArray(rows) ? rows : []).filter(function (r) { return r.creative === creative; })[0];
        if (row) {
          // normalizuj (přidá _zralost/_cpa/_paid/_roas…), ať metricItems má správná pole
          if (tab === 'earrings') normalizeEarrings([row]); else normalizeRings([row]);
          _tileCache[key] = row;
        }
        renderTiles(row);
      }).catch(function () { if (mt) mt.classList.remove('is-loading'); });
    }
    if (!ADS.miniTrend || typeof ADS.miniTrend !== 'function') {
      // charts.js se nenačetl / spadl → radši čitelná hláška než věčné „Načítám…".
      host.innerHTML = '<div class="tm-err">Graf trendu není dostupný — modul grafů (charts.js) se nenačetl.</div>';
      return;
    }

    /* G8: překreslení grafu na jiné období. `days = 0` → celá historie TOHOTO TABU.
     * ⚠️ „Celá historie" NENÍ ADS.BQ_RANGE: to je rozsah PRSTENŮ z BigQuery (~197 dní).
     *    Náušnice v BQ vůbec nejsou (jedou z Ninoxu, kampaň od 3. 7.) → ptát se u nich
     *    na 197 dní je lež. Proto `alltimeDays(tab)`, která to řeší per tab (viz #22). */
    /* ===========================================================================
     * F7/C3 — ROZPAD KREATIVY PODLE OPTIMALIZACÍ (eventů)
     * ---------------------------------------------------------------------------
     * Filip 23. 7.: „chtěl bych si to rozdělit podle eventů a optimalizací, abych viděl
     * a mohl si vyfiltrovat ten graf a ty čísla (…) jak se vyvíjí z pohledu ROAS, třeba CPL
     * (…) Uděláš to nějak pěkně UXově, aby to bylo přehledné?"
     *
     * DVĚ VRSTVY, protože každá odpovídá na jinou otázku:
     *   1. TABULKA = „která optimalizace je lepší?" → všechny naráz vedle sebe, hned vidět.
     *   2. CHIPY   = „jak se TAHLE vyvíjí v čase?" → filtr, který přepne graf i dlaždice.
     * Kdyby byly jen chipy, srovnání by znamenalo proklikat šest stavů a pamatovat si čísla.
     *
     * ⚠️ Když má kreativa jen JEDNU optimalizaci, blok se vůbec nezobrazí — přepínač
     *    s jedinou volbou je jen šum.
     * ⚠️ „optimalizace" == `event` z BigQuery (lead_event). Meta optimization goal ad-setu
     *    se zatím nikam nestahuje (FEEDBACK-7, pre-flight Q2). Popisek to říká narovinu.
     * ⚠️ Náušnice eventy NEMAJÍ (SPEC §0C) → blok se u nich nestaví vůbec. */
    var _optCache = {};
    function optRowsHTML(list, total) {
      return '<table class="tmo-tbl"><thead><tr>' +
          '<th>Optimalizace</th><th>Spend</th><th>Leady</th><th>CPL</th><th>CPA</th>' +
          '<th>ROAS real</th><th>ROAS model</th></tr></thead><tbody>' +
        list.map(function (e) {
          var t = e.totals || {};
          var sh = total > 0 ? Math.round((num(t.spend) || 0) / total * 100) : 0;
          return '<tr data-ev="' + esc(e.event) + '"' + (curEvent === e.event ? ' class="is-on"' : '') + '>' +
            '<td class="tmo-n"><span class="tmo-bar" style="--w:' + sh + '%"></span>' + esc(e.event || '—') + '</td>' +
            '<td>' + fmtMoney(t.spend) + '</td>' +
            '<td>' + fmtInt(t.leads) + '</td>' +
            '<td>' + costOrDash(t.cpl, t.leads) + '</td>' +
            '<td>' + costOrDash(t.cpa != null ? t.cpa : t.cps, t.bookings) + '</td>' +
            '<td>' + fmtRoas(t.roas_real) + '</td>' +
            '<td class="tmo-rm">' + fmtRoas(t.roas_model) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }
    function renderOpts(list) {
      var box = ov.querySelector('.tm-opt');
      if (!box) return;
      // < 2 optimalizace → není co přepínat ani srovnávat
      if (!list || list.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
      var total = list.reduce(function (a, e) { return a + (num((e.totals || {}).spend) || 0); }, 0);
      box.innerHTML =
        '<div class="tmo-head"><b>🎯 Podle optimalizace</b>' +
          '<span class="tmo-hint">event z BigQuery (lead_event) — podle čeho se kampaň optimalizovala. ' +
          'Klik = graf i dlaždice nahoře se přepočítají jen na tuhle optimalizaci.</span></div>' +
        '<div class="tmo-chips">' +
          '<button type="button" class="tmo-c' + (curEvent === '' ? ' is-on' : '') + '" data-ev="">Vše</button>' +
          list.map(function (e) {
            var sh = total > 0 ? Math.round((num((e.totals || {}).spend) || 0) / total * 100) : 0;
            return '<button type="button" class="tmo-c' + (curEvent === e.event ? ' is-on' : '') + '" ' +
              'data-ev="' + esc(e.event) + '" title="' + esc(e.event) + '">' + esc(e.event || '—') +
              '<i>' + sh + ' %</i></button>';
          }).join('') +
        '</div>' + optRowsHTML(list, total);
      box.hidden = false;
    }
    function loadOpts(fromISO, toISO) {
      if (tab === 'earrings') return;              // náušnice eventy nemají
      var key = fromISO + '|' + toISO;
      if (_optCache[key]) { renderOpts(_optCache[key]); return; }
      ADS.api('event_trend', {
        creative: creative, tab: tab, from: fromISO, to: toISO, granularity: 'week'
      }).then(function (r) {
        if (!trendModal || trendModal.ov !== ov) return;         // modal už zavřený
        var list = (r && r.events) || [];
        list = list.filter(function (e) { return num((e.totals || {}).spend) > 0; });
        _optCache[key] = list;
        renderOpts(list);
      }).catch(function (err) {
        // Rozpad je doplněk — graf i dlaždice fungují bez něj, tak jen tiše nic.
        console.warn('[tables] rozpad podle optimalizací se nenačetl', err);
      });
    }

    function drawTrend(days) {
      var f = from, t = todayISO();
      var draw = function (fromISO) {
        curFrom = fromISO; curTo = t;              // F7/C3
        var lbl = ov.querySelector('.tm-range');
        if (lbl) lbl.textContent = fmtDate(fromISO) + ' – ' + fmtDate(t);
        var mn = ov.querySelector('.tm-mnote');
        if (mn) mn.innerHTML = maturityNoteHTML(fromISO, t);   // zralost se s oknem MĚNÍ
        [].forEach.call(ov.querySelectorAll('.tm-p'), function (b) {
          b.classList.toggle('is-on', parseInt(b.dataset.d, 10) === days);
        });
        drawChart();
        refreshTiles(fromISO, t);   // dlaždice se mění s oknem (Filip 20. 7.)
        loadOpts(fromISO, t);       // F7/C3 — rozpad podle optimalizací za stejné okno
      };
      if (days > 0) { draw(isoShift(t, -(days - 1))); return; }
      // celá historie — u náušnic je to async (odvozuje se z dat)
      host.innerHTML = '<div class="acx-mini"><div class="acx-mini-msg"><span class="acx-spin"></span>Načítám celou historii…</div></div>';
      alltimeDays(tab).then(function (d) {
        var n = (d === 'max' || !isFinite(d)) ? 400 : (parseInt(d, 10) || 400);
        draw(isoShift(t, -(n - 1)));
      });
    }

    /* F7/C3: kreslení grafu vytažené zvlášť — volá ho jak změna OKNA (drawTrend),
     * tak změna OPTIMALIZACE (setEvent). Dřív bylo inline v draw(), takže přepnutí
     * eventu by znamenalo zopakovat celý blok. */
    function drawChart() {
      if (trendModal.inst && trendModal.inst.dispose) { try { trendModal.inst.dispose(); } catch (_) {} }
      try {
        trendModal.inst = ADS.miniTrend(host, {
          creative: creative, tab: tab, from: curFrom, to: curTo, event: curEvent
        });
      } catch (err) {
        console.error('[tables] miniTrend selhal:', err);
        host.innerHTML = '<div class="tm-err">Graf trendu se nepodařilo vykreslit: ' + esc(errMsg(err)) + '</div>';
      }
    }
    function setEvent(ev) {
      if (curEvent === ev) return;
      curEvent = ev || '';
      var box = ov.querySelector('.tm-opt');
      if (box) {
        [].forEach.call(box.querySelectorAll('.tmo-c'), function (b) {
          b.classList.toggle('is-on', (b.getAttribute('data-ev') || '') === curEvent);
        });
        [].forEach.call(box.querySelectorAll('.tmo-tbl tbody tr'), function (r) {
          r.classList.toggle('is-on', (r.getAttribute('data-ev') || '') === curEvent);
        });
      }
      // titulek nese vybranou optimalizaci, ať je po zavření chipů jasné, co se kouká
      var sub = ov.querySelector('.tm-sub');
      if (sub) {
        var old = sub.querySelector('.tm-evlbl');
        if (old) old.remove();
        if (curEvent) {
          var sp = document.createElement('span');
          sp.className = 'tm-evlbl';
          sp.textContent = ' · 🎯 ' + curEvent;
          sub.appendChild(sp);
        }
      }
      drawChart();
      refreshTiles(curFrom, curTo);
    }
    ov.querySelector('.tm-opt').addEventListener('click', function (e) {
      var c = e.target.closest('.tmo-c');
      if (c) { setEvent(c.getAttribute('data-ev') || ''); return; }
      var r = e.target.closest('.tmo-tbl tbody tr');
      // klik na už vybraný řádek = zpět na „Vše" (nejde se jinak odkliknout myší v tabulce)
      if (r) setEvent((r.getAttribute('data-ev') || '') === curEvent ? '' : (r.getAttribute('data-ev') || ''));
    });

    ov.querySelector('.tm-per').addEventListener('click', function (e) {
      var b = e.target.closest('.tm-p');
      if (b) drawTrend(parseInt(b.dataset.d, 10));
    });

    // Start: období z horní lišty → graf sedí na řádek, ze kterého Filip klikl.
    var startDays = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
    var isPreset = TM_PERIODS.some(function (p) { return p.d === startDays; });
    if (isPreset) { drawTrend(startDays); }
    else {
      // Vlastní rozsah z pickeru (nesedí na preset) → nakresli ho, žádné tlačítko aktivní.
      var mn0 = ov.querySelector('.tm-mnote');
      if (mn0) mn0.innerHTML = maturityNoteHTML(from, to);
      curFrom = from; curTo = to;   // F7/C3 — i tahle cesta musí okno zaznamenat
      drawChart();
      refreshTiles(from, to);   // vlastní rozsah z pickeru → dlaždice taky
      loadOpts(from, to);       // F7/C3
    }
  }

  function toggleExpand(row) {
    var d = row.getData(); d._expanded = !d._expanded; row.reformat();
  }
  // FEEDBACK M1: klik na řádek → GRAF TRENDU té kreativy. Rozbalení jednotlivých reklam
  // zůstává na šipce (I1 ji proto zvětšuje) — jinak by se obě akce praly o tentýž klik.
  /* ★★ F8/A3 — „PORVÉ TO JDE, PAK PÁRKRÁT ZMĚNÍM ŘAZENÍ A ŘÁDEK UŽ NEJDE ROZKLIKNOUT"
   * (Filip 10. 8., padá i v anonymním okně → není to cache ani osiřelý overlay)
   * =================================================================================
   * PŘÍČINA JE V TABULATORU, ne u nás. Jeho `rowClick`/`cellClick` NEJSOU listenery na
   * řádku — je to JEDEN delegovaný listener na tabulce, který si ke kliknutému <div>
   * musí teprve DOHLEDAT objekt řádku (vendor, `InteractionModule.bindComponents`):
   *
   *     i = this.table.rowManager.getVisibleRows(true).find(e => e.getElement() === r)
   *
   * Když se ten `find` netrefí, vendor **NEVYHODÍ CHYBU — prostě nic nedispatchne.**
   * Navenek: klikáš a nic. A protože buňka se dohledává AŽ PŘES nalezený řádek
   * (`o.row.findCell(r)`), padá tím zároveň i klik na náhled a na šipku rozkliku —
   * přesně ta trojice, kterou Filip hlásí, a přesně proto vždycky všechny tři naráz,
   * zatímco hlavička (ta se hledá jinudy, `findColumn`) dál funguje.
   * K rozejití DOM ↔ evidence řádků stačí přeskládání tabulky = řazení. Odtud
   * „poprvé to jde a po pár přeřazeních ne".
   *
   * OPRAVA: na tohle dohledávání se přestaneme spoléhat. Objekt řádku si při každém
   * vykreslení PŘILEPÍME NA ELEMENT (`el._adsRow` v rowFormatteru — ten běží na každý
   * render, takže nemůže zestárnout) a klik obsloužíme vlastní delegací. Ta se ptá jen
   * DOMu, takže ji vnitřní evidence Tabulatoru nemá jak rozbít.
   *
   * ⚠️ PROTO JSOU `cellClick` U `_preview`, `_exp`, `_flag`, `_kill` A `t.on('rowClick')`
   *    ZRUŠENÉ. Kdyby se sem vrátily, akce se budou dít DVAKRÁT (a zase mizet).
   *    Sub-tabulka v rozkliku (.ads-subwrap) má vlastní obsluhu → tu přeskakujeme. */
  function wireRowClicks(tblEl) {
    if (!tblEl || tblEl._adsRowClicks) return;
    tblEl._adsRowClicks = true;
    tblEl.addEventListener('click', safe('Rozklik řádku', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.ads-subwrap')) return;            // rozbalené reklamy si klik řeší samy
      var rowEl = t.closest('.tabulator-row');
      if (!rowEl || !tblEl.contains(rowEl)) return;
      var row = rowEl._adsRow;
      if (!row) return;                                  // hlavička, patička, sumární řádek
      var d = row.getData();
      if (!d) return;

      if (t.closest('.c-exp'))  { toggleExpand(row); return; }
      if (t.closest('.c-prev') || t.closest('.c-flag')) { openRowDetail(d, previewAdBig(d)); return; }
      if (t.closest('.c-trend') || t.closest('.c-decay')) { openTrendModal(d); return; }
      if (t.closest('.c-kill')) {
        if (!t.closest('.btn-kill')) return;
        // spinner v tlačítku držíme přes DOM buňky (dřív ho dodával cellClick přes cell komponentu)
        var kc = t.closest('.c-kill');
        killCreativeCore(row, function (on) {
          if (on) {
            var btn = kc.querySelector('.btn-kill');
            if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.innerHTML = '<span class="spin"></span>'; }
          } else { try { row.reformat(); } catch (_) { } }
        });
        return;
      }
      if (t.closest('a') || t.closest('button')) return; // odkazy a vlastní tlačítka nechat být

      // Náušnice: klik na řádek → DETAIL (Filip). Trend zůstává na ikonce trendu (.c-trend).
      if (d._tab === 'earrings') { openRowDetail(d, previewAdBig(d)); return; }
      openTrendModal(d);
    }));
  }

  /* ------------------------------------------------------------------ *
   *  Normalizace dat (odvozená pole)
   * ------------------------------------------------------------------ */
  function normalizeRings(rows) {
    rows.forEach(function (d) {
      d._tab = 'rings';
      d._burned = burned(d);
      d._created = createdOf(d);
      d._cpa = cpaOf(d);                 // D3: CPA (server `cpa`, fallback na historický `cps`)
      if (!(num(d.bookings) > 0)) d._cpa = null;   // bez rezervací CPA neexistuje → null (řadí se dolů)
      d._pct_call = pctCallOf(d);        // D4
      d._pct_schuzek = pctSchuzekOf(d);  // D4
      d._zralost = zralostOf(d);         // A1/A3/A4 (server `zralost`, jinak pct_call × pct_schuzek)
      // F: kontrakt je `valuable_leads` (viz present_row). `vleads` je jen interní název
      // v agregaci api.php — kdyby se někdy dostal ven, ať sloupec nemlčí.
      if (d.valuable_leads == null && d.vleads != null) d.valuable_leads = d.vleads;
    });
    return rows;
  }
  function normalizeEarrings(rows) {
    rows.forEach(function (d) {
      d._tab = 'earrings';
      d._demands = num(d.demands); if (d._demands == null) d._demands = num(d.leads) || 0;
      d._reservations = num(d.reservations); if (d._reservations == null) d._reservations = num(d.bookings) || 0;
      d._paid = num(d.revenue_paid); if (d._paid == null) d._paid = num(d.revenue_real) || 0;
      d._createdRev = num(d.revenue_created) || 0;
      d._roasPaid = (d.roas_real != null) ? num(d.roas_real) : (num(d.spend) ? d._paid / num(d.spend) : null);
      d._roasTotal = (d.roas_created != null) ? num(d.roas_created) : (num(d.spend) ? d._createdRev / num(d.spend) : null);
      d._roasCalc = num(d.roas_model);
      // K1: „CPL nezajímá → řídit se Lookerem = CPA = cena za rezervaci (spend / rezervace)".
      // api.php pro náušnice počítá přesně tohle (cps = spend / reservations) → bereme `cpa`,
      // fallback `cps`, a když by nedorazily ani ty, dopočet ze spendu a rezervací.
      d._cpa = cpaOf(d);
      if (d._cpa == null) d._cpa = (d._reservations > 0 && num(d.spend) != null) ? num(d.spend) / d._reservations : null;
      // Bez rezervací CPA NEEXISTUJE → null (ne 0). Server posílá 0 přes sdiv → jinak by se
      // řadilo jako nejlevnější a při vzestupném řazení lezlo NAHORU (Filip: „bez CPA dolů").
      if (!(d._reservations > 0)) d._cpa = null;
      d._pct_call = pctCallOf(d);
      // Náušnice nemají schůzky (passed = null) → % rezervací se v jejich tabulkách neukazuje.
      d._pct_schuzek = null;
      // A1: u náušnic dělí model JEN call_rate → zralost = pct_call (viz zralostOf).
      d._zralost = zralostOf(d);
      // Náušnice: kill/winners kotví server na ROAS ZAPLACENO (SPEC §5) → spálené peníze
      // počítáme ze stejného ROASu, ne z ROAS_model (ten je u náušnic „dopočet z celkem").
      // H3: server `burned` má přednost; fallback jede proti break-evenu (plošně 2,0
      // i pro náušnice — Filip 16. 7.), ne proti 1,0.
      d._burned = burnedOf(d, d._roasPaid);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ *
   *  Náušnicové sloupce (zůstávají z původní verze — registr colDef() je volá)
   * ------------------------------------------------------------------ */
  var EAR_TIP_PAID = 'tržba ze ZAPLACENÝCH objednávek (Ninox „analytics_zaplaceno") — rozhodovací metrika náušnic: kotví se na ni kill i winners.';
  var EAR_TIP_CREATED = 'tržba ze VŠECH vytvořených objednávek (i nezaplacených) — Ninox „analytics_celkem".';

  /* FEEDBACK K2 — poptávky vs rezervace NEJSOU totéž (ověřeno: 43 poptávek vs 47 rezervací,
   * 2 lidé objednali 3 páry). Rozdíl je malý, ale reálný → držíme oba sloupce a v hlavičce
   * říkáme proč, ať se Filip znovu neptá. Rezervace = hlavní (jmenovatel CPA). */
  function colDemands() {
    return Object.assign({
      title: 'Poptávky', field: '_demands', hozAlign: 'right', sorter: 'number', width: 106, cssClass: 'c-num',
      formatter: function (cell) { var v = num(cell.getValue()); return v == null ? '—' : fmtInt(v); }
    }, bcSum(fmtInt));
  }
  function colReservations() {
    return Object.assign({
      title: 'Rezervace', field: '_reservations', hozAlign: 'right', sorter: 'number', width: 114, cssClass: 'c-num',
      formatter: function (cell) { var v = num(cell.getValue()); return v == null ? '—' : fmtInt(v); }
    }, bcSum(fmtInt));
  }

  /* ================================================================== *
   *  KONSOLIDACE — JEDNA TABULKA NA TAB + VIEWS
   * ================================================================== *
   * Dřív: 5 mountů × 5 instancí Tabulatoru, každá s vlastním fetchem, vlastními
   * sloupci a vlastní perzistencí. Odtud většina nekonzistencí (13 vs 15 winnerů,
   * hinty jen v části tabulek, „tlačítko Uložit není vidět" jen v jedné sekci…).
   * Dnes: 1 mount na tab, 1 instance, view = filtr + řazení + sloupce + režim.
   */

  var TAB_MOUNT = { rings: 'creatives-rings', earrings: 'creatives-earrings' };
  function mountIdOf(tab) { return TAB_MOUNT[tab] || TAB_MOUNT.rings; }
  function getMount(id) { return (ADS.el && ADS.el('#' + id)) || document.getElementById(id); }
  function st() { return ADS.state || {}; }
  function tabOf() { return st().tab === 'earrings' ? 'earrings' : 'rings'; }

  var tables = {};        // mountId -> Tabulator
  var renderTokens = {};  // tab -> int (stale-guard: přišlo novější období → zahoď staré)
  var applying = {};      // tab -> bool (guard: programová změna != uživatelova změna)
  var applyTimer = {};

  /* --- NÁLEZ #21: Tabulator „Table Not Initialized" -------------------------
   * Tabulator v6 staví tabulku ASYNCHRONNĚ → setFilter/replaceData hned po
   * `new Tabulator(...)` spadnou pod stůl a vysypou 20+ varování. Práci nad
   * tabulkou proto frontujeme, dokud nepřijde `tableBuilt`. (KONSOLIDACE varuje
   * přesně před tímhle: „při přepínání view počkat na tableBuilt".)
   */
  var tableBuilt = {}, builtQueue = {};
  function isBuilt(mountId) {
    var t = tables[mountId];
    if (!t) return false;
    if (tableBuilt[mountId]) return true;
    if (t.initialized === true) { tableBuilt[mountId] = true; return true; }
    return false;
  }
  function whenBuilt(mountId, fn) {
    if (!tables[mountId]) return;
    if (isBuilt(mountId)) { fn(tables[mountId]); return; }
    (builtQueue[mountId] = builtQueue[mountId] || []).push(fn);
  }
  function flushBuilt(mountId) {
    tableBuilt[mountId] = true;
    var q = builtQueue[mountId] || [];
    builtQueue[mountId] = [];
    q.forEach(function (fn) { try { fn(tables[mountId]); } catch (e) { console.error('[tables] tableBuilt callback selhal:', e); } });
  }

  /* ------------------------------------------------------------------ *
   *  Období / all-time rozsah  (#22: all-time MUSÍ být tab-aware)
   * ------------------------------------------------------------------ */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isoShift(iso, days) {
    var t = Date.parse(String(iso) + 'T00:00:00Z');
    if (!isFinite(t)) return iso;
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
  }
  /* ADS.BQ_RANGE je rozsah PRSTENŮ z BigQuery (~197 dní od 2025-12-31). Náušnice v BQ
   * VŮBEC NEJSOU — jedou z Ninox share view a kampaň běží od 3. 7. 2026 (~14 dní).
   * Ptát se u nich na „197 dní" je lež. Rozsah proto odvozujeme z dat (první den
   * s nenulovým spendem) a cachujeme na session. */
  function bqAlltimeDays() {
    var r = ADS.BQ_RANGE;
    if (r && r.min && r.max) { var d = windowDays(r.min, r.max); if (d && d > 0) return d; }
    return 197;
  }
  function earringsRangeFromConfig() {
    var r = ADS.EARRINGS_RANGE || ADS.EAR_RANGE || (ADS.RANGES && ADS.RANGES.earrings) || null;
    return (r && r.min && r.max) ? r : null;
  }
  var earDaysPromise = null;
  function earringsAlltimeDays() {
    if (earDaysPromise) return earDaysPromise;
    var cfg = earringsRangeFromConfig();
    if (cfg) {
      var dc = windowDays(cfg.min, cfg.max);
      earDaysPromise = Promise.resolve((dc && dc > 0) ? dc : null);
      return earDaysPromise;
    }
    var r = ADS.BQ_RANGE || {};
    var to = r.max || todayISO();
    var from = r.min || isoShift(to, -196);
    earDaysPromise = Promise.resolve(
      ADS.api('timeseries', { tab: 'earrings', metric: 'spend', split: 'funnel', from: from, to: to })
    ).then(function (res) {
      var dates = (res && res.dates) || [], series = (res && res.series) || [], first = -1;
      for (var i = 0; i < dates.length && first < 0; i++) {
        for (var s = 0; s < series.length; s++) {
          var v = num((series[s].data || [])[i]);
          if (v && v > 0) { first = i; break; }
        }
      }
      if (first < 0) return null;
      var d = windowDays(dates[first], dates[dates.length - 1]);
      return (d && d > 0) ? d : null;
    }).catch(function (err) {
      console.warn('[tables] rozsah náušnic se nepodařilo odvodit z dat:', err);
      return null;
    });
    return earDaysPromise;
  }
  /* G8 — období grafu v rozkliku kreativy. `d` = dní zpět, 0 = celá historie tabu.
   * Filip: „chtěl bych, abych si mohl vybrat, že u tý kreativy se dívám na delší dobu…
   * Jako zásadní věc teda u toho grafu, aby tam šlo upravovat to období."
   * 14 tu SCHVÁLNĚ NENÍ (vyhozeno z hlavního pickeru, N4) — u JEDNÉ kreativy je navíc
   * 14 dní skoro vždy nedozrálých (tržba dozrává ~3 týdny) a graf by lhal. */
  var TM_PERIODS = [
    { d: 30,  t: '30 dní' },
    { d: 60,  t: '60 dní' },
    { d: 90,  t: '90 dní' },
    { d: 180, t: '180 dní' },
    { d: 0,   t: 'Celá historie' }
  ];

  function alltimeDays(tab) {
    if (tab === 'earrings') return earringsAlltimeDays().then(function (d) { return d || 'max'; });
    return Promise.resolve(bqAlltimeDays());
  }

  /* ------------------------------------------------------------------ *
   *  DATA: cache per (tab, období, segment)
   * ------------------------------------------------------------------ *
   * Přepnutí view NESMÍ znamenat nový fetch — Filip mezi záložkami přeskakuje.
   * Segmenty se proto tahají PARALELNĚ (kvůli počtům v záložkách je stejně
   * potřebujeme všechny) a drží se v cache. Je to stejný objem, jaký dosud
   * padal na 5 sekcí, jen jednou a s okamžitým přepínáním.
   *
   * ⚠️ POČET = DÉLKA SERVEROVÉ ODPOVĚDI. Nikdy nedopočítávat z `all` — server má
   *    u killu navíc podmínku „má běžící reklamu" (34 kandidátů, ale 9 živých)
   *    a `overview.totals.kill_count` proto s ?segment=kill NESEDÍ. Změřeno 16. 7.
   */
  var dataCache = {};
  var cacheEpoch = 0;
  function segKey(tab, seg) {
    var s = st();
    return seg === 'alltime'
      ? [tab, 'alltime', cacheEpoch].join('|')
      : [tab, s.from, s.to, seg, cacheEpoch].join('|');
  }
  function fetchSegment(tab, seg) {
    var k = segKey(tab, seg);
    if (dataCache[k]) return dataCache[k];
    var p;
    if (seg === 'alltime') {
      p = alltimeDays(tab).then(function (days) { return ADS.api('alltime', { tab: tab, days: days }); });
    } else {
      p = Promise.resolve(ADS.api('creatives', { from: st().from, to: st().to, tab: tab, segment: seg }));
    }
    p = p.then(function (raw) {
      var rows = Array.isArray(raw) ? raw : (raw && raw.rows) ? raw.rows : (raw && raw.data) ? raw.data : [];
      rows = rows.filter(Boolean);
      (tab === 'earrings' ? normalizeEarrings : normalizeRings)(rows);
      return rows;
    });
    dataCache[k] = p;
    // Chybu do cache nezacementovat — po „Zkusit znovu" se to má fakt zkusit znovu.
    p.catch(function () { if (dataCache[k] === p) delete dataCache[k]; });
    return p;
  }
  function dropCache() { dataCache = {}; cacheEpoch++; }

  /* Uživatelské filtry view (NAD serverovým segmentem).
   * ⚠️ Tohle NENÍ predikát segmentu — ten patří serveru a FE ho nikdy nepočítá.
   *    Tohle jsou Filipovy vlastní filtry („Zásnubní, ROAS < 2, spend > 5k"),
   *    které na serveru neexistují a nikdy nemůžou přepsat, co je winner/kill. */
  /* T6: `filters.funnel` je nově POLE. Starší uložená views (a Filipova prefs na serveru)
   * ho mají jako STRING → normalizuj, ať se po nasazení nikomu nerozbije uložený view. */
  function funnelList(f) {
    if (!f || !f.funnel) return null;
    var a = Array.isArray(f.funnel) ? f.funnel : [f.funnel];
    return a.length ? a : null;
  }

  /* ★ F8/C — ŽIVÝ PŘEPÍNAČ „JEN AKTIVNÍ" (Filip 10. 8.: „chci checkbox Jen aktivní,
   * který přepíše nastavení filtru; předvolený bude podle view, ale jde ho přepsat").
   * `actOnly` je VOLITELNÝ třetí argument: `undefined` = řiď se view (tak to volají počty
   * v záložkách, aby ukazovaly stav VIEW, ne můj momentální překlik), `true/false` =
   * překlik z lišty pro právě vykreslovaný pohled. Do view se to NEUKLÁDÁ — stejná
   * kategorie jako chipy funnelů a hledání, aby Filipovi nesvítilo „neuloženo". */
  function applyViewFilters(rows, view, actOnly) {
    var f = (view && view.filters) || {};
    var fl = funnelList(f);
    var wantActive = (actOnly === undefined) ? !!f.active_only : !!actOnly;
    if (!fl && f.roas_max == null && f.roas_min == null && f.spend_min == null && !wantActive && !f.decay) return rows;
    return rows.filter(function (d) {
      // Nepřiřazené kreativy nesou funnel '' i '---' → normalizuj na '---', ať sedí s checkboxem.
      if (fl && fl.indexOf((d.funnel && d.funnel !== '') ? d.funnel : '---') < 0) return false;
      // „Jen aktivní" (Filip): nech jen kreativy, které reálně běží (runningOf === true).
      // Neznámý stav (null) se schová — filtr slibuje „aktivní", ne „možná aktivní".
      if (wantActive && runningOf(d) !== true) return false;
      // „Zhoršují se / umírají" — decay warn nebo dying (CPA vylétla vs vlastní start).
      if (f.decay && !(d.decay && (d.decay.level === 'warn' || d.decay.level === 'dying'))) return false;
      var r = num(d._tab === 'earrings' ? d._roasPaid : d.roas_model);
      if (f.roas_max != null && !(r != null && r < f.roas_max)) return false;
      if (f.roas_min != null && !(r != null && r >= f.roas_min)) return false;
      if (f.spend_min != null && !((num(d.spend) || 0) >= f.spend_min)) return false;
      return true;
    });
  }

  /* ================================================================== *
   *  REGISTR SLOUPCŮ — jediné místo, kde `key` → definice
   * ================================================================== *
   * `key` == Tabulator `field` → uložený layout se páruje 1:1 a je dopředu
   * kompatibilní: sloupec, který v uloženém view chybí (přidali jsme ho později),
   * se doplní z defaultu na konec místo aby zmizel.
   */
  function colDef(key, tab) {
    switch (key) {
      case '_state': return colState();      // T9 — běží/pauznuto, první sloupec
      case '_exp': return colExpand();
      case '_preview': return colPreview();
      case 'creative': return colCreative();
      case 'funnel': return colFunnel();
      case 'kill_reason': return {
        // N7: krátký pill; detail + „proč" je v pop-upu po najetí (killReasonHTML).
        // tooltip:false — jinak by přes náš pop-up lezl ještě nativní tooltip Tabulatoru
        // s celým dlouhým textem (dvojitá informace přes sebe).
        // Šířka 180 NENÍ od oka: nejdelší pill je „ROAS pod break-even" (19 znaků) a při
        // 150 px se usekával na „ROAS pod break-…" — přesně to, co N7 měl odstranit.
        // 180 = text + padding pilulky + očičko vpravo. Změřeno v prohlížeči.
        title: 'Důvod', field: 'kill_reason', width: 180, minWidth: 130, cssClass: 'c-reason', tooltip: false,
        formatter: function (c) { return killReasonHTML(c.getData()); }
      };
      case '_burned': return colBurned(tab === 'earrings' ? 'ROAS zaplaceno' : 'ROAS model');
      case 'scale_ready': return {
        // 17. 8. 2026 — sloupec „Scale" nahrazen badgem PODVYŽIVENÁ.
        // Důvod (Filip): jediná škálovací páka je PŘESUN do hlavní kampaně, rozpočet se
        // ručně nepřilévá → „unese škálování" nebyla akce, na kterou jde kliknout.
        // Field zůstává 'scale_ready' kvůli uloženým pohledům uživatelů; data čte ze `starved`.
        title: 'Podvyživená', field: 'scale_ready', width: 108, cssClass: 'c-scale',
        headerSort: true,
        sorter: function (a, b, aRow, bRow) {
          return (bRow.getData().starved ? 1 : 0) - (aRow.getData().starved ? 1 : 0);
        },
        formatter: function (c) { return starvedBadgeHTML(c.getData()); }
      };
      case '_created': return {
        // G1: datum je HOLÉ a řaditelné; „čekáme na data" má vlastní sloupec vedle.
        title: 'Vytvořeno', field: '_created', width: 100, sorter: 'string', cssClass: 'c-created',
        formatter: function (c) { return '<span class="cdate">' + fmtDate(c.getValue()) + '</span>'; }
      };
      case '_age': return colAge();   // T10 — „Běží od" (první běh kódu + kolik dní)
      case 'maturity': return {
        title: 'Stav dat', field: 'maturity', width: 132, sorter: 'string', cssClass: 'c-mat',
        formatter: function (c) { return maturityBadgeHTML(c.getData()); }
      };
      case 'spend_pct': return colSpendPct();
      case 'spend': return colMoney('Spend', 'spend', 84);
      case 'leads': return colInt('Leadů', 'leads', 70);
      case 'new_leads': return colNewLeads();
      case 'selected_leads': return colSelected();
      case 'valuable_leads': return colVLeads();
      case 'bookings': return colInt('Rezervace', 'bookings', 90);
      case '_cpa': return colCpa(tab);
      case 'cpl': return colCplRings();
      case '_pct_call': return colPctCall();
      case '_pct_schuzek': return colPctSchuzek();
      case 'revenue_real': return colRevenue('Tržba real', 'revenue_real', 100);
      case 'revenue_model': return colRevenueModel();
      case 'roas_real': return colRoasPlain('ROAS real', 'roas_real', 84);
      case 'roas_model': return colRoasModel();
      case '_zralost': return colZralost();
      case 'trend_cps': return colTrend();
      case '_decay': return colDecay();
      case '_kill': return colKill();
      case '_flag': return colFlag();      // F7/D7 (defaultně skrytý)
      // --- náušnice ---
      case '_demands': return colDemands();
      case '_reservations': return colReservations();
      case '_paid': return colRevenue('Tržba zaplaceno', '_paid', 112, EAR_TIP_PAID);
      case '_createdRev': return colRevenue('Tržba celkem', '_createdRev', 104, EAR_TIP_CREATED);
      case '_roasPaid': return colRoasModel('_roasPaid', 'ROAS zaplaceno');
      case '_roasTotal': return colRoasPlain('ROAS celkem', '_roasTotal', 92);
      case '_roasCalc': return colRoasPlain('ROAS model', '_roasCalc', 96);
      case 'dopocet_pct': return {
        title: '% dopočet', field: 'dopocet_pct', width: 96, sorter: 'number', cssClass: 'c-dop',
        formatter: function (c) { return dopocetBadgeHTML(c.getData()); }
      };
    }
    return null;
  }

  /* ⚠️ POŘADÍ SLOUPCŮ JE FILIPOVO, DODRŽET PŘESNĚ (FEEDBACK-3 F1):
   *   náhled · kreativa · funnel · % spendu · spend · leadů · rezervace · CPA · CPL ·
   *   % hovorů · % rezervací · tržba nyní · tržba dopočet (model) · ROAS real · ROAS model
   * ZRALOST (A3/A4) je na konci, hned za ROAS model — Filip ji chce „VŠUDE, kde se
   * porovnává ROAS", a tohle je jediné místo, kde sedí vedle OBOU ROAS sloupců.
   * New leads / VLeads (F) jdou hned za „Leadů" (patří do rodiny leadů), ale DEFAULTNĚ
   * SKRYTÉ — tabulka má i bez nich 16 sloupců. V pruhu „Skryté" jsou na jeden klik. */
  var RING_METRICS = ['spend_pct', 'spend', 'leads', 'new_leads', 'valuable_leads', 'selected_leads', 'bookings',
                      '_cpa', 'cpl', '_pct_call', '_pct_schuzek',
                      'revenue_real', 'revenue_model', 'roas_real', 'roas_model', '_zralost'];
  // Náušnice: CPL je PRYČ (K1 — Filipa nezajímá, řídíme se Lookerem = CPA za rezervaci).
  var EAR_METRICS = ['spend_pct', 'spend', '_demands', '_reservations', '_cpa',
                     '_paid', '_createdRev', '_roasPaid', '_roasTotal', '_zralost'];
  // F7/D7: `_flag` je defaultně skrytý — většina kreativ poznámku nemá a tabulka je široká.
  var DEFAULT_HIDDEN = { new_leads: true, valuable_leads: true, _flag: true };

  function defaultColumnKeys(view) {
    var seg = view.segment;
    if (view.tab === 'earrings') {
      // T9: šipka (rozbalení) je úplně vlevo, ikona běží/pauza AŽ VEDLE ní (Filip 17. 7.:
      // „vlevo bych dal tu šipku a tady tu ikonku bych dal až vedle").
      var eh = ['_exp', '_state', '_preview', 'creative'];
      if (seg === 'kill') eh = eh.concat(['kill_reason', '_burned']);
      else if (seg === 'winners') eh = eh.concat(['scale_ready']);
      // Filip 18. 7.: u NÁUŠNIC NEuvádíme modelovaný ROAS ani modelovanou tržbu (nemáme
      // schůzky → dopočet by byl výmysl). Jen ROAS celkem/zaplaceno + tržba celkem/zaplaceno.
      // Proto se `_roasCalc` (ROAS model) ani `dopocet_pct` u náušnic NEPŘIDÁVAJÍ.
      var em = EAR_METRICS.slice();
      return eh.concat(em, ['_decay', '_flag', '_kill']);   // F7/D7
    }
    var h = ['_exp', '_state', '_preview', 'creative', 'funnel'];
    if (seg === 'kill') h = h.concat(['kill_reason', '_burned']);
    else if (seg === 'winners') h = h.concat(['scale_ready']);
    else if (seg === 'new') h = h.concat(['_age', '_created', 'maturity']);   // T10 „Běží od"
    // Kill tlačítko NEDÁVÁME do „Nejnovější" a „All-time": v jednom se čeká na data
    // a ve druhém se koukáme do historie kvůli inspiraci — killovat tam nedává smysl
    // (a je to zároveň dnešní chování, které Filip odsouhlasil).
    // F7/D7: `_flag` je ve VŠECH segmentech (i „Nejnovější"/„All-time", kde Kill nedává
    // smysl) — poznámka „tuhle hlídat" má cenu právě u čerstvých a u historických.
    var tail = (seg === 'new' || seg === 'alltime') ? ['_decay', '_flag'] : ['_decay', '_flag', '_kill'];
    return h.concat(RING_METRICS, tail);
  }

  /* Sestavení sloupců pro view: uložený layout (klíč/šířka/viditelnost) + doplnění
   * nových sloupců z defaultu na konec (dopředná kompatibilita uložených views). */
  function resolveColumns(view) {
    var tab = view.tab;
    var dflt = defaultColumnKeys(view);
    var spec = (Array.isArray(view.columns) && view.columns.length) ? view.columns : null;
    var keys, meta = {};
    if (spec) {
      keys = [];
      spec.forEach(function (c) { if (colDef(c.key, tab)) { keys.push(c.key); meta[c.key] = c; } });
      dflt.forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    } else {
      keys = dflt;
    }
    // Normalizace (Filip: „kolečko běží/pauza je jako poslední"): služební sloupce VŽDY
    // vepředu ve správném pořadí — šipka (rozbalení) · stav (běží/pauza) · náhled — i když
    // uložené view dědí staré pořadí. Migrace bez sáhnutí do DB (přepíše se při příštím uložení).
    var SERVICE_ORDER = ['_exp', '_state', '_preview'];
    var lead = SERVICE_ORDER.filter(function (k) { return keys.indexOf(k) > -1; });
    if (lead.length) {
      keys = lead.concat(keys.filter(function (k) { return SERVICE_ORDER.indexOf(k) < 0; }));
    }
    var out = [];
    keys.forEach(function (k) {
      var def = colDef(k, tab);
      if (!def) return;
      var m = meta[k];
      if (m) {
        if (m.w) def.width = m.w;
        def.visible = m.visible !== false;
      } else {
        def.visible = !DEFAULT_HIDDEN[k];
      }
      out.push(def);
    });
    return decorateHeaders(out);
  }

  // Aktuální stav sloupců z tabulky → do view (klíč/šířka/viditelnost).
  function currentColumns(tab) {
    var t = tables[mountIdOf(tab)];
    if (!t || typeof t.getColumnLayout !== 'function') return null;
    try {
      return t.getColumnLayout().filter(function (c) { return c && c.field; }).map(function (c) {
        var o = { key: c.field, visible: c.visible !== false };
        var w = num(c.width);
        if (w != null && w > 0) o.w = Math.round(w);
        return o;
      });
    } catch (e) { console.warn('[tables] getColumnLayout selhal:', e); return null; }
  }
  function persistColumns(tab) {
    if (applying[tab]) return;                 // programová přestavba != Filipova změna
    var cols = currentColumns(tab);
    if (!cols || !cols.length) return;
    ADS.views.patch(tab, { columns: cols });
    realignSubrows(mountIdOf(tab));            // C2: rozbalené pruhy musí sednout na novou mřížku
    renderHiddenBar(tab);
  }
  function persistSort(tab) {
    if (applying[tab]) return;
    var t = tables[mountIdOf(tab)];
    if (!t || typeof t.getSorters !== 'function') return;
    var s;
    try { s = t.getSorters() || []; } catch (_) { return; }
    if (!s.length) return;
    ADS.views.patch(tab, {
      sort: s.map(function (x) {
        return { col: (x.field || (x.column && x.column.getField && x.column.getField())), dir: x.dir === 'asc' ? 'asc' : 'desc' };
      }).filter(function (x) { return !!x.col; })
    });
  }

  /* C2: pruh metrik v rozbalených řádcích přebírá šířky sloupců parenta → po každé
   * změně mřížky ho musíme překreslit, jinak přestane lícovat. */
  function realignSubrows(mountId) {
    var t = tables[mountId];
    if (!t || typeof t.getRows !== 'function') return;
    try {
      t.getRows().forEach(function (r) {
        if (!r.getData()._expanded) return;
        var holder = r.getElement().querySelector(':scope > .ads-subwrap');
        if (!holder) return;
        var old = holder.querySelector(':scope > .sub-align');
        if (!old) return;
        var html = subAlignedStripHTML(r.getData(), r);
        if (!html) return;
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        holder.replaceChild(tmp.firstChild, old);
      });
    } catch (e) { console.warn('[tables] realign rozbalených řádků selhal:', e); }
  }

  /* ================================================================== *
   *  S1: SKRÝVÁNÍ SLOUPCŮ (očičko) + PRUH SKRYTÝCH
   * ================================================================== *
   * Filip: „očičko v hlavičce = skrýt; nahoře seznam skrytých → klik = vrátit.
   * Tím si u všech tabulek můžu upravovat počty sloupců — to bude geniální."
   * Viditelnost je součást view (spolu se šířkou a pořadím) → uloží se s ním.
   */
  function hideCol(tab, field) {
    var t = tables[mountIdOf(tab)];
    if (!t) return;
    try { t.hideColumn(field); } catch (e) { console.warn('[tables] hideColumn selhal:', e); return; }
    persistColumns(tab);
    renderHiddenBar(tab);
  }
  function showCol(tab, field) {
    var t = tables[mountIdOf(tab)];
    if (!t) return;
    try { t.showColumn(field); } catch (e) { console.warn('[tables] showColumn selhal:', e); return; }
    persistColumns(tab);
    renderHiddenBar(tab);
  }
  function renderHiddenBar(tab) {
    var mount = getMount(mountIdOf(tab));
    if (!mount) return;
    var box = mount.querySelector('.ads-hidden');
    if (!box) return;
    var t = tables[mountIdOf(tab)];
    if (!t || !isBuilt(mountIdOf(tab))) { box.hidden = true; box.innerHTML = ''; return; }
    var hid = [];
    try {
      t.getColumns().forEach(function (c) {
        if (c.isVisible()) return;
        var d = c.getDefinition();
        if (!d || !d.title) return;               // sloupce bez názvu (rozklik) se neskrývají
        hid.push({ f: c.getField(), t: d.title });
      });
    } catch (e) { box.hidden = true; return; }

    /* ★ F8/C — lišta se od 10. 8. ukazuje VŽDY, i když není nic skryté: bydlí v ní
     * přepínač „Jen aktivní". Kdyby se schovávala jako dřív (jen při skrytých sloupcích),
     * neměl by ho Filip jak vypnout. */
    var view = (ADS.views.active && ADS.views.active(tab)) || null;
    var on = effActiveOnly(tab, view);
    var fromView = !!(((view || {}).filters) || {}).active_only;
    var ovr = (actOnlyOv[tab] !== undefined) && (on !== fromView);
    var chk = '<label class="hc-act' + (ovr ? ' is-ov' : '') + '" ' +
      'title="Nechá v tabulce jen kreativy, kterým reálně běží aspoň jedna reklama.\n' +
      'Výchozí stav bere z filtru tohohle view (teď: ' + (fromView ? 'zapnuto' : 'vypnuto') + ') — ' +
      'tímhle přepínačem ho přebiješ jen pro tenhle pohled, do view se nic neuloží.">' +
      '<input type="checkbox" data-actonly="1"' + (on ? ' checked' : '') + '> Jen aktivní' +
      (ovr ? '<i class="hc-ov" title="Přebito proti nastavení view">•</i>' : '') +
      '</label>';

    var chips = !hid.length ? '' :
      '<span class="hc-lbl" title="Sloupce, které jsi skryl(a) pravým klikem v hlavičce. Klikni = vrátit zpátky.">' +
      '👁 Skryté sloupce:</span>' +
      hid.map(function (h) {
        return '<button class="hc-chip" type="button" data-show="' + esc(h.f) + '" ' +
          'title="Vrátit sloupec ' + esc(h.t) + ' zpátky do tabulky">' + esc(h.t) + ' <i>+</i></button>';
      }).join('') +
      (hid.length > 1 ? '<button class="hc-all" type="button" data-show-all="1" title="Vrátí do tabulky všechny skryté sloupce">vrátit vše</button>' : '');

    box.innerHTML = chk + (chips ? '<span class="hc-sep"></span>' + chips : '');
    box.hidden = false;
  }
  /* F7/A4 — počítadlo vedle hledání: „12 z 857". Bez něj u prázdného výsledku nepoznáš,
   * jestli filtr nic nenašel, nebo se rozbila data. Ukazuje se jen když nějaký filtr běží. */
  function renderSearchCount(tab, t, sel, terms) {
    var mount = getMount(mountIdOf(tab));
    if (!mount) return;
    var el = mount.querySelector('.asb-cnt');
    if (!el) return;
    var active = (sel && sel.length) || (terms && terms.length);
    if (!active) { el.hidden = true; el.textContent = ''; return; }
    try {
      var shown = t.getRows('active').length, all = t.getRows().length;
      el.textContent = fmtInt(shown) + ' z ' + fmtInt(all);
      el.classList.toggle('is-empty', shown === 0);
      el.hidden = false;
    } catch (_) { el.hidden = true; }
  }

  function wireSearchBar(mount, tab) {
    var box = mount.querySelector('.ads-searchbar');
    if (!box || box._wired) return;
    box._wired = true;
    var input = box.querySelector('.asb-in');
    var clear = box.querySelector('.asb-x');
    if (!input) return;
    // hodnota přežije překreslení tabulky (přepnutí view v rámci tabu) — do view se
    // NEUKLÁDÁ schválně, je to živý filtr jako chipy funnelů, ne nastavení pohledu
    if (searchQ[tab]) input.value = searchQ[tab];
    function run() {
      searchQ[tab] = input.value || '';
      if (clear) clear.hidden = !searchQ[tab];
      box.classList.toggle('is-on', !!searchQ[tab]);
      applyFunnelFilter(tab);          // jeden predikát pro chipy i hledání
    }
    // „při každém stisknutí znaku" — input pokryje i vložení myší a mazání křížkem prohlížeče
    input.addEventListener('input', run);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; run(); input.blur(); }
    });
    if (clear) clear.addEventListener('click', function () { input.value = ''; run(); input.focus(); });
  }

  function wireHiddenBar(mount, tab) {
    var box = mount.querySelector('.ads-hidden');
    if (!box || box._wired) return;
    box._wired = true;
    // ★ F8/C — překlik „Jen aktivní": přepíše nastavení view jen pro tenhle pohled.
    box.addEventListener('change', function (e) {
      var cb = e.target.closest && e.target.closest('[data-actonly]');
      if (!cb) return;
      actOnlyOv[tab] = !!cb.checked;
      renderTab(tab);          // data jsou v cache → překreslí se i počty, součty a patička
    });
    box.addEventListener('click', function (e) {
      var all = e.target.closest('[data-show-all]');
      if (all) {
        var t = tables[mountIdOf(tab)];
        if (!t) return;
        try { t.getColumns().forEach(function (c) { if (!c.isVisible() && (c.getDefinition() || {}).title) c.show(); }); }
        catch (err) { console.warn('[tables] „vrátit vše" selhalo:', err); }
        persistColumns(tab); renderHiddenBar(tab);
        return;
      }
      var b = e.target.closest('[data-show]');
      if (b) showCol(tab, b.getAttribute('data-show'));
    });
  }
  /* T7: PRAVÝ KLIK na hlavičku → skrýt sloupec (nahradilo očičko).
   * capture=true: Tabulator si na .tabulator-col drží vlastní handlery — tímhle je
   * předběhneme, jinak by pravý klik zároveň přehodil řazení.
   * ⚠️ Sub-tabulka v rozkliku (.ads-subwrap) menu NEDOSTÁVÁ: nemá pruh skrytých sloupců,
   * kterým by se sloupec vrátil, a `hideCol` míří na HLAVNÍ tabulku tabu → skryl by se
   * úplně jiný sloupec, než na který uživatel klikl. */
  /* ================================================================== *
   *  T7 + T11: KONTEXTOVÉ MENU (pravý klik)
   * ================================================================== *
   * Jeden sdílený engine pro obě menu (hlavička = skrýt sloupec · řádek kreativy =
   * kill / funnel / odkazy). Vlastní, ne Tabulatorovo `rowContextMenu`: potřebujeme
   * disablované položky S VYSVĚTLENÍM (T11 — odkazy, které server ještě neposílá),
   * což vestavěné menu neumí, a stejný vzhled na hlavičce i na řádku.
   *
   * `items`: [{label, icon?, run?, disabled?, hint?, sep?}]
   *   disabled + hint → položka je vidět, ale nejde kliknout a řekne PROČ.
   *   Nikdy ji neschováváme: „ta položka tam není" se čte jako rozbitý nástroj,
   *   „ta položka je šedá, protože Meta ještě nedodala odkaz" se čte jako stav.
   */
  var ctxMenu = null;
  function closeCtxMenu() {
    if (!ctxMenu) return;
    var m = ctxMenu; ctxMenu = null;
    document.removeEventListener('keydown', m._onKey, true);
    if (m.parentNode) m.remove();
  }
  var CTX_ICONS = {
    hide: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    show: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>',
    kill: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>',
    funnel: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.6 5.4V13L6.6 11.4V8.4L2 3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3.5h3.5V7M12.2 3.8 7.4 8.6M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ig: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.2" cy="4.8" r=".9" fill="currentColor"/></svg>',
    fb: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 14V8.6h1.8l.3-2.1H9.6V5.1c0-.6.2-1 1-1h1.1V2.2C11.5 2.1 10.9 2 10.1 2 8.5 2 7.4 3 7.4 4.8v1.7H5.6v2.1h1.8V14h2.2Z" fill="currentColor"/></svg>'
  };
  function openCtxMenu(x, y, items) {
    closeCtxMenu();
    var m = document.createElement('div');
    m.className = 'ads-ctx';
    m.setAttribute('role', 'menu');
    m.innerHTML = (items || []).map(function (it, i) {
      if (it.sep) return '<div class="ctx-sep" role="separator"></div>';
      var ico = CTX_ICONS[it.icon] || '';
      return '<button class="ctx-i' + (it.disabled ? ' is-off' : '') + '" type="button" role="menuitem" data-i="' + i + '"' +
        (it.disabled ? ' disabled aria-disabled="true"' : '') +
        (it.hint ? ' title="' + esc(it.hint) + '"' : '') + '>' +
        '<span class="ctx-ico" aria-hidden="true">' + ico + '</span>' +
        '<span class="ctx-tx">' + esc(it.label) + (it.disabled && it.hint ? '<i class="ctx-why">' + esc(it.hint) + '</i>' : '') + '</span>' +
        '</button>';
    }).join('');
    document.body.appendChild(m);
    // Změř až V DOM (šířka závisí na nejdelší položce) a teprve pak umísti, ať menu
    // nikdy nevyleze z okna — u řádků dole v tabulce se to jinak stane vždycky.
    var mw = m.offsetWidth, mh = m.offsetHeight;
    var left = x, top = y;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, x - mw);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    m.style.left = left + 'px'; m.style.top = top + 'px';
    m.addEventListener('click', function (e) {
      var b = e.target.closest('.ctx-i');
      if (!b || b.disabled) return;
      var it = items[+b.getAttribute('data-i')];
      closeCtxMenu();
      if (it && typeof it.run === 'function') it.run();
    });
    m._onKey = function (e) { if (e.key === 'Escape') closeCtxMenu(); };
    document.addEventListener('keydown', m._onKey, true);
    ctxMenu = m;
    requestAnimationFrame(function () { if (ctxMenu === m) m.classList.add('show'); });
  }
  // Zavírání: jeden globální listener (menu se otevírá i zavírá napříč tabulkami).
  function wireCtxClose() {
    if (document._adsCtxCloseWired) return;
    document._adsCtxCloseWired = true;
    document.addEventListener('mousedown', function (e) {
      if (ctxMenu && !e.target.closest('.ads-ctx')) closeCtxMenu();
    }, true);
    window.addEventListener('scroll', closeCtxMenu, true);
    window.addEventListener('resize', closeCtxMenu);
  }

  /* T11: odkazy na reklamu. Server je zatím NEPOSÍLÁ všechny (na `media_type`,
   * `instagram_permalink` a `effective_object_story_id` dělá paralelně jiný agent —
   * viz FEEDBACK-6 „Chybí sloupce v ads_meta").
   * ⚠️ ŽÁDNOU URL SI NEVYMÝŠLÍME. Když pole není, položka je disablovaná a řekne proč.
   * FB odkaz se skládá z `effective_object_story_id` = „{page_id}_{post_id}" → to není
   * odhad, ale ověřený recept z FEEDBACK-6 (ad 120247354441980781, 16. 7.). */
  function igLinkOf(a) { return (a && (a.instagram_permalink || a.ig)) || ''; }
  function fbLinkOf(a) {
    if (!a) return '';
    if (a.fb_permalink || a.fb) return a.fb_permalink || a.fb;
    var sid = a.effective_object_story_id || a.story_id || '';
    var m = String(sid).match(/^(\d+)_(\d+)$/);
    return m ? ('https://www.facebook.com/' + m[1] + '/posts/' + m[2]) : '';
  }
  function openUrl(u) { window.open(u, '_blank', 'noopener'); }

  function rowCtxItems(row, tab) {
    var d = row.getData();
    var a = previewAd(d);
    var items = [];

    // --- Kill (stávající cesta: killCreativeFlow → killConfirm → performKill) ---
    var ids = activeAdIds(d);
    items.push(d._killed
      ? { label: 'Kill', icon: 'kill', disabled: true, hint: 'kreativa je už vypnutá' }
      : (!ids.length
        ? { label: 'Kill', icon: 'kill', disabled: true, hint: 'žádná aktivní reklama k vypnutí' }
        : { label: 'Kill kreativu (' + ids.length + ' reklam' + (ids.length === 1 ? 'a' : 'y') + ')', icon: 'kill', run: function () { killCreativeRow(row); } }));

    // --- F1/T11: přiřazení funnelu (api.php `set_funnel`, retro na celou historii) ---
    if (tab === 'earrings') {
      items.push({ label: 'Přiřadit k funnelu', icon: 'funnel', disabled: true, hint: 'náušnice funnely nerozlišují' });
    } else if (d.creative === '---') {
      // api.php to stejně odmítne (400) — radši to řekneme rovnou, než po kliku.
      items.push({ label: 'Přiřadit k funnelu', icon: 'funnel', disabled: true, hint: '„---" je agregát netrackovaných leadů z víc funnelů, ne kreativa' });
    } else {
      items.push({ label: 'Přiřadit k funnelu…', icon: 'funnel', run: function () { openFunnelModal(row); } });
    }

    items.push({ sep: true });

    // --- odkazy ---
    var am = a.adsmanager_link || '';
    items.push(am
      ? { label: 'Otevřít v Ads Manageru', icon: 'link', run: function () { openUrl(am); } }
      : { label: 'Otevřít v Ads Manageru', icon: 'link', disabled: true, hint: 'reklama nemá ad_id — odkaz nejde složit' });

    var ig = igLinkOf(a);
    items.push(ig
      ? { label: 'Preview na Instagramu', icon: 'ig', run: function () { openUrl(ig); } }
      : { label: 'Preview na Instagramu', icon: 'ig', disabled: true, hint: 'server zatím neposílá instagram_permalink' });

    var fb = fbLinkOf(a);
    items.push(fb
      ? { label: 'Preview na Facebooku', icon: 'fb', run: function () { openUrl(fb); } }
      : { label: 'Preview na Facebooku', icon: 'fb', disabled: true, hint: 'server zatím neposílá effective_object_story_id' });

    return items;
  }
  function rowOfElement(el, tab) {
    var t = tables[mountIdOf(tab)];
    if (!t || !t.getRows) return null;
    var found = null;
    try {
      t.getRows().forEach(function (r) {
        if (found) return;
        var re = r.getElement && r.getElement();
        if (re === el) found = r;
      });
    } catch (e) { console.warn('[tables] dohledání řádku selhalo:', e); }
    return found;
  }
  function wireRowMenu() {
    if (document._adsRowMenuWired) return;
    document._adsRowMenuWired = true;
    document.addEventListener('contextmenu', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('.tabulator-col')) return;      // hlavičku řeší wireColMenu
      if (e.target.closest('.ads-subwrap')) return;        // rozklik jednotlivých reklam
      var rowEl = e.target.closest('.tabulator-row');
      if (!rowEl) return;
      if (rowEl.classList.contains('tabulator-calcs')) return;   // T8: patička není kreativa
      var mount = rowEl.closest('.ads-sec');
      if (!mount) return;
      var tab = (mount.id === TAB_MOUNT.earrings) ? 'earrings' : 'rings';
      var row = rowOfElement(rowEl, tab);
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, rowCtxItems(row, tab));
    }, true);
  }

  /* F1/T11: modal „přiřadit k funnelu".
   * Volá STÁVAJÍCÍ endpoint `POST ?action=set_funnel {creative, funnel, note}` (api.php).
   * Funnel musí být ze seznamu známých funnelů — server jiný odmítne (400) a osiřelý
   * kbelík by stejně nikdo neuviděl ve filtrech. Proto <select>, ne volný text. */
  function openFunnelModal(row) { openFunnelModalData(row.getData()); }
  // F1-top / F1-newest-rmb: datová varianta, ať jde vyvolat i z detailu (newest.js) a
  // z right-clicku v Nejnovějších přes ADS.assignFunnel(rowData), ne jen z Tabulator řádku.
  function openFunnelModalData(d) {
    if (!d) return;
    if (d._tab === 'earrings') { if (ADS.toast) ADS.toast('Náušnice funnely nerozlišují.', 'info'); return; }
    if (d.creative === '---') { if (ADS.toast) ADS.toast('„---" je agregát netrackovaných leadů, ne kreativa — funnel mu přiřadit nejde.', 'info'); return; }
    var list = (Array.isArray(ADS.FUNNELS) ? ADS.FUNNELS : []).filter(function (f) { return f && f !== '---'; });
    if (!list.length) {
      if (ADS.toast) ADS.toast('Seznam funnelů se nenačetl — zkus obnovit stránku.', 'warn');
      return;
    }
    var cur = d.funnel || '';
    var ov = document.createElement('div');
    ov.className = 'ads-modal-ov';
    ov.innerHTML =
      '<div class="ads-modal ads-funnel-modal" role="dialog" aria-modal="true">' +
      '<div class="am-title">🎯 Přiřadit funnel</div>' +
      '<div class="am-sub">Kreativa <b>' + esc(d.creative || '') + '</b>' +
      (cur ? ' · teď: <b>' + esc(cur) + '</b>' : ' · teď: <b>bez funnelu</b>') + '</div>' +
      '<label class="am-reason">Funnel' +
      '<select class="fm-sel">' + list.map(function (f) {
        return '<option value="' + esc(f) + '"' + (f === cur ? ' selected' : '') + '>' + esc(f) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="am-reason">Poznámka <span class="am-opt">(volitelné — proč)</span>' +
      '<textarea rows="2" placeholder="např. kód nesedí, ale leady chodí do Maledivy"></textarea></label>' +
      '<div class="fm-note">Platí <b>retroaktivně na celou historii</b> téhle kreativy a přebije atribuci z dat.</div>' +
      '<div class="am-actions">' +
      '<button class="btn-ghost am-cancel" type="button">Zrušit</button>' +
      '<button class="btn-primary am-ok" type="button">Přiřadit</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    var sel = ov.querySelector('.fm-sel'), ta = ov.querySelector('textarea'), ok = ov.querySelector('.am-ok');
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.querySelector('.am-cancel').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    ok.onclick = async function () {
      var f = sel.value;
      ok.disabled = true; ok.innerHTML = '<span class="spin"></span>';
      try {
        await ADS.api('set_funnel', { creative: d.creative, funnel: f, note: ta.value.trim() }, { method: 'POST' });
        close();
        if (ADS.toast) ADS.toast('„' + d.creative + '" → ' + f + ' ✓ (platí na celou historii)', 'success');
        // Funnel mění atribuci tržby → čísla v tabulce už nejsou aktuální. Radši
        // přenačíst ze serveru, než lokálně přepsat jedno pole a tvářit se, že sedí.
        dropCache();
        renderTab(tabOf());
      } catch (err) {
        ok.disabled = false; ok.textContent = 'Přiřadit';
        if (ADS.toast) ADS.toast('Přiřazení selhalo: ' + errMsg(err), 'error');
      }
    };
    setTimeout(function () { sel.focus(); }, 30);
  }

  function colOfHeader(el, tab) {
    var t = tables[mountIdOf(tab)];
    if (!t || !t.getColumns) return null;
    var found = null;
    try {
      t.getColumns().forEach(function (c) {
        if (found) return;
        var ce = c.getElement && c.getElement();
        if (ce && (ce === el || ce.contains(el))) found = c;
      });
    } catch (e) { console.warn('[tables] dohledání sloupce selhalo:', e); }
    return found;
  }
  function wireColMenu() {
    if (document._adsColMenuWired) return;
    document._adsColMenuWired = true;
    document.addEventListener('contextmenu', function (e) {
      if (!e.target.closest) return;
      var head = e.target.closest('.tabulator-col');
      if (!head) return;
      if (e.target.closest('.ads-subwrap')) return;      // rozklik → menu nedáváme
      var mount = head.closest('.ads-sec');
      if (!mount) return;
      var tab = (mount.id === TAB_MOUNT.earrings) ? 'earrings' : 'rings';
      var col = colOfHeader(head, tab);
      if (!col) return;
      var def = col.getDefinition() || {};
      // Sloupce BEZ názvu (rozklik `_exp`) skrýt nejdou: nemají jak se ukázat v pruhu
      // skrytých → uživatel by si je nevrátil. F7/A3: Kill (`_kill`) UŽ název má,
      // takže se skrývat i vracet dá jako každý jiný sloupec.
      if (!def.title) return;
      e.preventDefault();
      e.stopPropagation();
      var items = [{
        label: 'Skrýt sloupec „' + def.title + '"',
        icon: 'hide',
        run: function () { hideCol(tab, col.getField()); }
      }];
      var hiddenCnt = 0;
      try {
        tables[mountIdOf(tab)].getColumns().forEach(function (c) {
          var d = c.getDefinition();
          if (!c.isVisible() && d && d.title) hiddenCnt++;
        });
      } catch (_) { }
      if (hiddenCnt) {
        items.push({
          label: 'Vrátit všechny skryté (' + hiddenCnt + ')',
          icon: 'show',
          run: function () {
            var t = tables[mountIdOf(tab)];
            if (!t) return;
            try { t.getColumns().forEach(function (c) { if (!c.isVisible() && (c.getDefinition() || {}).title) c.show(); }); }
            catch (err) { console.warn('[tables] „vrátit vše" selhalo:', err); }
            persistColumns(tab); renderHiddenBar(tab);
          }
        });
      }
      openCtxMenu(e.clientX, e.clientY, items);
    }, true);
  }

  /* ================================================================== *
   *  SCAFFOLD + PŘESTAVBA DOM
   * ================================================================== */
  var SEC_META = {
    rings: { sec: 'creatives', ico: '📋', title: 'Kreativy', host: 'rings-view', drop: ['kill', 'winners', 'topspenders', 'newest', 'alltime'] },
    earrings: { sec: 'ear-creatives', ico: '💎', title: 'Náušnice', host: 'earrings-root', drop: ['ear-kill', 'ear-winners', 'ear-table'] }
  };

  /* index.html má pořád 5 (resp. 3) samostatných .sec sekcí. Přestavíme je SAMI —
   * index.html je cizí soubor a shell si ho zrovna přepisuje kvůli sidebaru.
   * Běží to synchronně při parse tables.js, tedy JEŠTĚ PŘED inline skriptem na dně
   * index.html, který sbalovací sekce teprve zapojuje → uvidí už náš strom.
   *
   * ⚠️ #newest NEMAŽEME — jen ho zaparkujeme do těla nové sekce. Dlaždice do něj dál
   *    renderuje newest.js (vlastní modul, vlastní fetch) a my ho jen odkrýváme,
   *    když je aktivní view v režimu dlaždic. Kdyby se smazal, dlaždice zmizí.
   * ⚠️ .sec[data-sec=charts] / [ear-charts] se NEDOTÝKÁME (patří charts.js).
   */
  function restructureDOM() {
    Object.keys(SEC_META).forEach(function (tab) {
      var m = SEC_META[tab];
      var host = document.getElementById(m.host);
      if (!host) { console.warn('[tables] kontejner #' + m.host + ' neexistuje — sekci nestavím.'); return; }
      if (document.getElementById(mountIdOf(tab))) return;    // už postaveno

      var sec = document.createElement('section');
      sec.className = 'sec';
      sec.setAttribute('data-sec', m.sec);
      // Jediná tabulka na tab → musí být VIDĚT hned. (Ostatní .sec jsou defaultně
      // sbalené; nový data-sec = nový klíč v localStorage → default se fakt uplatní.)
      sec.setAttribute('data-open-default', '1');
      sec.innerHTML =
        '<h2 class="sec-h">' +
        '<button class="sec-head" type="button" aria-expanded="false" aria-controls="secbody-' + m.sec + '">' +
        '<span class="sec-chev" aria-hidden="true"></span>' +
        '<span class="sec-ico" aria-hidden="true">' + m.ico + '</span>' +
        '<span class="sec-title">' + esc(m.title) + '</span>' +
        '<span class="sec-count" data-sec-count hidden></span>' +
        '<span class="sec-sub" data-sec-sub></span>' +
        '</button></h2>' +
        '<div class="sec-body" id="secbody-' + m.sec + '">' +
        // Legenda pravidel (Filip 15. 8.): statick\u00e1 verze v index.html sed\u011bla v .sec[data-sec=kill],
        // kterou restructureDOM() zahazuje \u2014 proto ji Filip nikdy nevid\u011bl. Pat\u0159\u00ed SEM.
        '<button class="kill-legend-link" type="button">\u2139\ufe0f Legenda: \u017eivotn\u00ed cyklus a kill pravidla</button>' +
        '<section id="' + mountIdOf(tab) + '" class="section" aria-label="' + esc(m.title) + '"></section>' +
        '</div>';
      host.insertBefore(sec, host.firstChild);

      var body = sec.querySelector('.sec-body');
      if (tab === 'rings') {
        var nw = document.getElementById('newest');
        if (nw) { nw.hidden = true; nw.classList.add('ads-tiles-host'); body.appendChild(nw); }
      }
      m.drop.forEach(function (name) {
        var old = host.querySelector('.sec[data-sec="' + name + '"]');
        if (old) old.remove();
      });
    });
  }

  function ensureScaffold(mount, tab) {
    mount.classList.add('ads-sec');
    if (mount.querySelector('.ads-viewbar')) return;
    mount.innerHTML =
      // Skrytý zdroj pravdy pro zrcadlení do hlavičky .sec (index.html to čte přes
      // MutationObserver). Uvnitř .sec je display:none — NEODSTRAŇOVAT.
      '<div class="ads-sec-head">' +
      '<div class="ash-l"><span class="ash-emoji">' + SEC_META[tab].ico + '</span>' +
      '<span class="ash-title">' + esc(SEC_META[tab].title) + '</span>' +
      '<span class="ash-count"></span></div>' +
      '<div class="ash-r"><span class="ash-sub"></span></div>' +
      '</div>' +
      '<div class="ads-viewbar"></div>' +        // views.js: záložky + počty + uložit
      '<div class="ads-toolbar"><div class="ads-funnels" hidden></div></div>' +
      // F7/A4: hledání v tabulce — VLEVO od pruhu skrytých sloupců, stejný jazyk jako chipy.
      '<div class="ads-searchbar">' +
        '<span class="asb-wrap">' +
          '<span class="asb-ico" aria-hidden="true">🔎</span>' +
          '<input class="asb-in" type="search" autocomplete="off" spellcheck="false" ' +
            'placeholder="Hledat kreativu nebo funnel…" aria-label="Hledat v tabulce">' +
          '<button class="asb-x" type="button" hidden title="Vymazat hledání" aria-label="Vymazat">×</button>' +
        '</span>' +
        '<span class="asb-cnt" hidden></span>' +
      '</div>' +
      '<div class="ads-hidden" hidden></div>' +  // S1: pruh skrytých sloupců
      '<div class="ads-status" style="display:none"></div>' +
      '<div class="ads-empty" hidden></div>' +   // prázdné view (náušnice „Na kill" = běžně 0)
      '<div class="ads-tbl"></div>' +
      '<div class="ads-foot" hidden></div>';     // T8: sumární/průměrový řádek
    // Obal do try/catch: kdyby renderBar (views.js) throwl, nesmí to shodit zbytek
    // scaffoldu (funnels/hidden-bar/tabulku). Jeden mrtvý řádek záložek je snesitelný,
    // celý mrtvý dashboard ne.
    try { ADS.views.renderBar(mount.querySelector('.ads-viewbar'), tab); }
    catch (e) { console.error('[tables] renderBar selhal:', e); }
    wireHiddenBar(mount, tab);
    wireSearchBar(mount, tab);       // F7/A4
  }

  function setCount(mount, text) { var c = mount.querySelector('.ash-count'); if (c) c.textContent = text || ''; }
  function setSub(mount, text) { var c = mount.querySelector('.ash-sub'); if (c) c.textContent = text || ''; }
  function setStatus(mount, state, retry) {
    var s = mount.querySelector('.ads-status'); if (!s) return;
    if (state === 'loading') { s.innerHTML = '<span class="ld"><span class="spin"></span> Načítám…</span>'; s.style.display = 'block'; }
    else if (state === 'error') {
      s.innerHTML = '<span class="err">Chyba načtení. </span>';
      var b = document.createElement('button'); b.className = 'btn-ghost sm'; b.textContent = 'Zkusit znovu';
      b.onclick = retry; s.appendChild(b); s.style.display = 'block';
    } else { s.style.display = 'none'; s.innerHTML = ''; }
  }

  /* --- D1: chipy funnelů nad tabulkou (Vše + funnely) ----------------------------------
   * Ukazujeme JEN funnely, které v načtených řádcích reálně jsou (chip s nulou by vedl
   * na prázdnou tabulku). Je to ŽIVÝ, dočasný filtr — do view se neukládá, aby se Filipovi
   * po jednom kouknutí nerozsvítilo „neuloženo". Trvalý filtr funnelu má view v `filters`.
   */
  var funnelSel = {};
  /* ★ F8/C — překlik „Jen aktivní" per tab. `undefined` = řídí se view (výchozí stav
   * checkboxu = to, co má view ve filtrech), `true/false` = Filip to přebil ručně.
   * Resetuje se při přepnutí view — jiný pohled = jiná výchozí volba. */
  var actOnlyOv = {};
  function effActiveOnly(tab, view) {
    if (actOnlyOv[tab] === undefined) return !!(((view || {}).filters) || {}).active_only;
    return !!actOnlyOv[tab];
  }
  /* T6: poslední vykreslené řádky per tab — patička se z nich přepočítá při změně
     funnel filtru, aniž by se sahalo na server (data už máme). */
  var lastRows = {};
  /* ★ T6 — FUNNEL = MULTIPLE SELECT. Filip (17. 7., podruhé): „u toho funnelu bych chtěl,
   * abych si to mohl zaškrtat ty funnely. Teď tam můžu vybrat jenom jeden, ale já bych chtěl,
   * abych si mohl vybrat klidně tři z těch všech nebo všechny kromě jednoho a tak dále.
   * To platí i pro všechny ostatní místa, kde si ty funnely vybírám, například v těch grafech."
   *
   * `funnelSel[tab]` je proto POLE (dřív string). Prázdné pole = VŠE — ne „nic":
   * kdyby odkliknutí posledního funnelu ukázalo prázdnou tabulku, vypadalo by to jako bug.
   * Filtruje se funkcí (ne `setFilter('funnel','=',x)`), protože Tabulator nemá „in".
   */
  /* F7/A4 — HLEDÁNÍ V TABULCE (Filip 23. 7.: „políčko na hledání ve stejném designu.
   * A bude to při každém stisknutí znaku vyhledávat a refrešovat").
   * Hledá se přes kód kreativy, funnel a název kampaně; diakritika se ignoruje,
   * takže „snubni" najde i „Snubní". Mezerou oddělené výrazy platí SOUČASNĚ (AND).
   *
   * ⚠️ MUSÍ SE SKLÁDAT S FUNNEL CHIPY. Tabulator má jen JEDEN programový filtr a
   * setFilter() ten předchozí NAHRADÍ — dvě samostatná volání by se navzájem přebíjela
   * (zapsal bych do hledání a chipy funnelů by přestaly platit). Proto jeden predikát. */
  var searchQ = {};
  function normTxt(v) {
    var s2 = String(v == null ? '' : v).toLowerCase();
    try { s2 = s2.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* starý prohlížeč */ }
    return s2;
  }
  function rowMatchesSearch(d, terms) {
    if (!terms.length) return true;
    var hay = normTxt(d.creative) + ' ' + normTxt(d.funnel) + ' ' + normTxt(d.campaign_name);
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
    return true;
  }
  function applyFunnelFilter(tab) {
    var id = mountIdOf(tab);
    if (!tables[id]) return;
    whenBuilt(id, function (t) {
      if (!t || !t.setFilter) return;
      var sel = funnelSel[tab] || [];
      var terms = normTxt(searchQ[tab] || '').split(/\s+/).filter(Boolean);
      try {
        if (sel.length || terms.length) {
          t.setFilter(function (d) {
            if (sel.length && sel.indexOf(d.funnel) < 0) return false;
            return rowMatchesSearch(d, terms);
          });
        } else t.clearFilter(true);
      } catch (e) { console.warn('[tables] filtr tabulky selhal:', e); }
      renderSearchCount(tab, t, sel, terms);
    });
    // T8: sumární řádek je teď Tabulator bottomCalc — setFilter výš ho přepočítá sám
    // (calc běží nad filtrovanými řádky). Starou patičku `.ads-foot` už neplníme.
  }
  /* P1-G — řazení funnelů dle POČTU reklam (desc), „—"/„---" vždy nakonec.
   * Sdílené pořadí publikujeme na ADS.funnelOrderHint, ať ho graf (charts.js) použije
   * taky (počty tam nejsou v scope). */
  function isBlankFunnel(f) { return !f || f === '—' || f === '---'; }
  function sortFunnelsByCount(list, counts) {
    return list.slice().sort(function (a, b) {
      var ba = isBlankFunnel(a), bb = isBlankFunnel(b);
      if (ba !== bb) return ba ? 1 : -1;                 // blank/--- nakonec
      return (counts[b] || 0) - (counts[a] || 0) ||      // víc reklam výš
             String(a).localeCompare(String(b), 'cs');
    });
  }
  // Memo počtů funnelů pro custom sorter sloupce (volá se v komparátoru mnohokrát).
  var _funCountMemo = { n: -1, map: {} };
  function funnelGroupCounts(table) {
    var data = (table && table.getData) ? table.getData() : [];
    if (data.length !== _funCountMemo.n) {
      var m = {};
      data.forEach(function (r) { var f = r.funnel || '—'; m[f] = (m[f] || 0) + 1; });
      _funCountMemo = { n: data.length, map: m };
    }
    return _funCountMemo.map;
  }

  function buildFunnelChips(mount, tab, rows) {
    var box = mount.querySelector('.ads-funnels');
    if (!box) return;
    if (tab === 'earrings') { box.hidden = true; box.innerHTML = ''; return; }   // náušnice funnely nemají
    var counts = {};
    rows.forEach(function (r) { var f = r.funnel || '—'; counts[f] = (counts[f] || 0) + 1; });
    var list = (Array.isArray(ADS.FUNNELS) ? ADS.FUNNELS : []).filter(function (f) { return counts[f]; });
    Object.keys(counts).forEach(function (f) { if (list.indexOf(f) < 0) list.push(f); });
    list = sortFunnelsByCount(list, counts);             // P1-G: dle počtu, blank nakonec
    ADS.funnelOrderHint = list.slice();                  // sdílené pořadí pro graf (charts.js)
    if (list.length < 2) { box.hidden = true; box.innerHTML = ''; funnelSel[tab] = []; return; }
    // T6: stav je POLE. Funnel, který v datech zmizel (jiné období), z výběru vyhoď.
    if (!Array.isArray(funnelSel[tab])) funnelSel[tab] = [];
    funnelSel[tab] = funnelSel[tab].filter(function (f) { return list.indexOf(f) > -1; });
    var sel = funnelSel[tab];
    var all = sel.length === 0;   // prázdný výběr = VŠE
    var shown = all ? rows.length : rows.filter(function (r) { return sel.indexOf(r.funnel) > -1; }).length;

    var html = '<span class="fch-lbl">Funnel:</span>' +
      '<button class="fchip' + (all ? ' is-on' : '') + '" type="button" data-f="" ' +
      'title="Zrušit výběr — ukázat všechny funnely">Vše <b>' + rows.length + '</b></button>';
    list.forEach(function (f) {
      var on = sel.indexOf(f) > -1;
      html += '<button class="fchip fchip-multi' + (on ? ' is-on' : '') + '" type="button" data-f="' + esc(f) + '" ' +
        'title="' + esc(f) + (on ? ' — klikni pro odebrání' : ' — klikni pro přidání') + '">' +
        '<span class="fchk" aria-hidden="true"></span>' +
        '<span class="fchip-txt">' + esc(f) + '</span> <b>' + counts[f] + '</b></button>';
    });
    // Kolik je vybráno — bez toho není při 3 z 8 poznat, že je filtr aktivní (chipy jsou malé).
    if (!all) {
      html += '<span class="fch-sum">' + sel.length + ' z ' + list.length +
              ' · <b>' + shown + '</b> kreativ</span>';
    }
    box.innerHTML = html;
    box.hidden = false;
    box.onclick = function (e) {
      var b = e.target.closest('.fchip'); if (!b) return;
      var f = b.getAttribute('data-f') || '';
      if (f === '') {
        funnelSel[tab] = [];                       // „Vše" = zrušit výběr
      } else {
        var i = funnelSel[tab].indexOf(f);
        // Ctrl/⌘ + klik = JEN tenhle (rychlá cesta k „chci vidět jenom snubní")
        if (e.metaKey || e.ctrlKey) funnelSel[tab] = [f];
        else if (i > -1) funnelSel[tab].splice(i, 1);
        else funnelSel[tab].push(f);
      }
      applyFunnelFilter(tab);
      buildFunnelChips(mount, tab, rows);          // překresli stavy + počet vybraných
    };
  }

  /* ================================================================== *
   *  DLAŽDICE (režim view)
   * ================================================================== *
   * Dlaždice vlastní newest.js (fetchuje si `segment=new` sám a umí pásma
   * Hvězdy/Potenciální/Průměr/Špatné). My je jen ODKRÝVÁME — tím je vyloučené,
   * aby dlaždice a tabulka ukazovaly jiná čísla (přesně tenhle rozpor nás 16. 7. kousl).
   * Kdyby newest.js časem nabídl ADS.renderTiles(el, rows, opts), použijeme ho
   * přednostně a #newest necháme schovaný — kontrakt je připravený.
   */
  function tilesHost(tab) {
    var mount = getMount(mountIdOf(tab));
    return mount ? mount.parentNode.querySelector('#newest') : null;
  }
  function showTiles(tab, view, rows) {
    var mount = getMount(mountIdOf(tab));
    var host = tilesHost(tab);
    var own = mount.querySelector('.ads-tiles-own');
    if (typeof ADS.renderTiles === 'function') {
      if (host) host.hidden = true;
      if (!own) {
        own = document.createElement('div');
        own.className = 'ads-tiles-own';
        mount.appendChild(own);
      }
      own.hidden = false;
      try { ADS.renderTiles(own, rows, { tab: tab, view: view.id }); return true; }
      catch (e) { console.error('[tables] ADS.renderTiles selhal → padám na #newest:', e); own.hidden = true; }
    }
    if (own) own.hidden = true;
    if (host) { host.hidden = false; return true; }
    return false;
  }
  function hideTiles(tab) {
    var host = tilesHost(tab);
    if (host) host.hidden = true;
    var mount = getMount(mountIdOf(tab));
    var own = mount && mount.querySelector('.ads-tiles-own');
    if (own) own.hidden = true;
  }

  /* ================================================================== *
   *  SHRNUTÍ DO HLAVIČKY SEKCE
   * ================================================================== */
  /* PRÁZDNÉ VIEW — musí něco ŘÍCT, ne jen zmizet.
   * Náušnice startují na „Na kill (0)" (žádný kandidát = dobrá zpráva) → bez tohohle by
   * Filip po přepnutí tabu koukal na prázdné bílé místo a hádal, jestli se to rozbilo.
   * Prázdno u kill listu NENÍ chyba, je to výsledek — tak ať to tak i vypadá. */
  function emptyHTML(view) {
    var seg = view.segment;
    if (seg === 'kill') {
      return '<span class="ae-i">✅</span><b>Žádný kill kandidát.</b>' +
        '<span>V tomhle období neprošla žádná běžící kreativa přes kill vrstvy — není co vypínat. ' +
        'Počet v záložce („Na kill 0") je ze serveru, ne z prázdné tabulky.</span>';
    }
    if (seg === 'winners') {
      return '<span class="ae-i">🟢</span><b>Žádný winner v tomhle období.</b>' +
        '<span>Winner = ROAS model nad prahem a dost rezervací. Zkus delší období — tržba dozrává týdny, ' +
        'takže v krátkém okně jich je vždycky míň.</span>';
    }
    return '<span class="ae-i">📭</span><b>Za tohle období tu nejsou žádná data.</b>' +
      '<span>Zkus jiné období nebo jiný filtr v tomhle view.</span>';
  }
  function setEmpty(mount, view, on) {
    var box = mount.querySelector('.ads-empty');
    if (!box) return;
    mount.classList.toggle('is-empty', !!on);
    if (!on) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = emptyHTML(view);
    box.hidden = false;
  }

  function summaryFor(view, rows) {
    var n = rows.length;
    if (view.segment === 'kill') {
      return n + ' ' + plural(n, 'kandidát', 'kandidáti', 'kandidátů') +
        ' · spálené ' + fmtMoney(sum(rows, function (r) { return r._burned; }));
    }
    var money = (view.tab === 'earrings')
      ? ' · zaplaceno ' + fmtMoney(sum(rows, function (r) { return r._paid; }))
      : ' · spend ' + fmtMoney(sum(rows, function (r) { return r.spend; }));
    return n + ' ' + plural(n, 'kreativa', 'kreativy', 'kreativ') + money;
  }
  function plural(n, one, few, many) { return n === 1 ? one : (n >= 2 && n <= 4 ? few : many); }

  /* ================================================================== *
   *  RENDER
   * ================================================================== */
  /* ★ F8/B1 — „KLIKNU NA HLAVIČKU A NEŘADÍ TO VŮBEC" (Filip 10. 8.)
   * ---------------------------------------------------------------------------------
   * NAMĚŘENO, NE ODHADNUTO. Tabulator má `movableColumns:true` (E3 — přehazování sloupců
   * tažením). Jeho modul `moveColumn` spouští přesun ČASOVAČEM: na `mousedown` nastartuje
   * `setTimeout(startMove, checkPeriod)` s checkPeriod = 250 ms (napevno ve vendoru).
   * `startMove()` pak sloupec VYNDÁ Z DOMU (`parentNode.removeChild`) a nahradí ho
   * placeholderem; zpátky ho vrátí až `endMove()` na mouseup.
   *
   * Jenže řazení visí na `click` — a prohlížeč `click` NEVYSTŘELÍ, když prvek mezi
   * mousedown a mouseup zmizí z dokumentu. Ověřeno sondou v Chrome: mousedown →
   * detach → reattach na mouseup → žádný click. Takže:
   *
   *   ⇒ KAŽDÝ stisk hlavičky delší než 250 ms = žádné řazení. Nic víc v tom není.
   *
   * Proto je to „někdy": rychlé cvaknutí projde, normální lidský stisk (a hlavně trackpad)
   * často ne. Přesně Filipovo „kliknu a nic".
   *
   * OPRAVA: přesun sloupce se nesmí spouštět ČASEM, ale POHYBEM. Časovač vypneme
   * (checkPeriod prakticky do nekonečna + jistotní clearTimeout na mouseup) a `startMove`
   * si zavoláme sami, až kurzor ujede >8 px do strany. Držení na místě tak sloupcem
   * nehne a klik vždycky doletí → seřadí. Tažení funguje dál, jen se rozjede okamžitě
   * po pohybu místo po čtvrt vteřině čekání.
   *
   * ⚠️ `.tabulator-col-resize-handle` VYNECHÁVÁME — tažení za okraj je změna šířky (E2),
   * ne přesun; bez téhle výjimky by se resize změnil v přesun sloupce. */
  function tameColumnDrag(t, tblEl) {
    var mc = t && t.modules && t.modules.moveColumn;
    if (!mc || mc._nkTamed) return;
    mc._nkTamed = true;
    mc.checkPeriod = 1e7;            // časovač už přesun nespustí (jen visí a je zrušen na mouseup)

    var down = null;
    function colObj(field) {
      try {
        var c = t.getColumn(field);
        if (c && c._getSelf) return c._getSelf();
      } catch (_) { }
      try { return t.columnManager.findColumn(field) || null; } catch (_) { return null; }
    }
    tblEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.tabulator-col-resize-handle')) return;     // resize ≠ přesun
      var colEl = e.target.closest('.tabulator-col');
      var hdr = tblEl.querySelector('.tabulator-header');
      if (!colEl || !hdr || !hdr.contains(colEl)) return;
      var f = colEl.getAttribute('tabulator-field');
      if (!f) return;
      down = { x: e.pageX, field: f };
    }, true);
    document.addEventListener('mousemove', function (e) {
      if (!down || mc.moving) return;
      if (Math.abs(e.pageX - down.x) < 8) return;                       // držení na místě = klik, ne tah
      var col = colObj(down.field);
      down = null;
      if (!col) return;
      try { mc.startMove(e, col); } catch (err) { console.warn('[tables] startMove selhal:', err); }
    }, true);
    document.addEventListener('mouseup', function () {
      down = null;
      // Pojistka: kdyby vendorový časovač přece jen běžel, ať nevystřelí za dvě hodiny.
      if (mc.checkTimeout) { try { clearTimeout(mc.checkTimeout); } catch (_) { } mc.checkTimeout = false; }
    }, true);
  }

  /* ★ F8/B2 — „ŠIPKA UKAZUJE NAHORU A ŘADÍ OD NEJVYŠŠÍCH" (Filip 10. 8.)
   * ---------------------------------------------------------------------------------
   * Vendor kreslí NEAKTIVNÍM sloupcům úplně stejnou šipku NAHORU jako seřazenému
   * vzestupně — liší se jen odstínem šedé (#bbb vs #666) na 6px trojúhelníku. Na tabulce
   * s 20 sloupci je tedy 19 šipek nahoru a jedna „taky nahoru, ale trochu tmavší".
   * Zvýraznění, které to mělo řešit (F7/A1), NEFUNGOVALO: vendorový selektor má o jednu
   * třídu vyšší specificitu, takže naše accent barva prohrávala a nikdy se nevykreslila
   * (změřeno v prohlížeči — aktivní šipka měla furt rgb(102,102,102)).
   *
   * Řádek se tedy může řadit sestupně a Filip u vedlejšího sloupce čte šipku nahoru.
   * Odsud „řadí to obráceně".
   *
   * OPRAVA je trojí a je v CSS níž + tady:
   *   1. neaktivní šipky skoro zmizí (ukážou se až na hover) → nahoře svítí JEN ta pravá,
   *   2. aktivní šipka dostane accent barvu selektorem, který vendor přebije,
   *   3. při víc sorterech dostane každý sloupec pořadové číslo. Tabulator totiž bere
   *      jako PRIMÁRNÍ POSLEDNÍ sorter (viz views.js) — bez čísla vypadají dvě šipky
   *      rovnocenně a tabulka „nesedí ani na jednu".
   */
  function markSorters(t) {
    try {
      var el = t && t.element;
      if (!el) return;
      var cols = el.querySelectorAll('.tabulator-header .tabulator-col');
      for (var i = 0; i < cols.length; i++) cols[i].removeAttribute('data-sortidx');
      var s = (t.getSorters && t.getSorters()) || [];
      if (s.length < 2) return;
      // getSorters() drží pořadí sortListu; Tabulator řadí od KONCE → poslední = primární.
      for (var j = 0; j < s.length; j++) {
        var f = s[j].field || (s[j].column && s[j].column.getField && s[j].column.getField());
        if (!f) continue;
        var c = el.querySelector('.tabulator-header .tabulator-col[tabulator-field="' + (window.CSS && CSS.escape ? CSS.escape(f) : f) + '"]');
        if (c) c.setAttribute('data-sortidx', String(s.length - j));   // 1 = primární
      }
    } catch (e) { console.warn('[tables] markSorters selhal:', e); }
  }

  function sortersFor(view, cols) {
    var fields = {};
    (cols || []).forEach(function (c) { if (c.field) fields[c.field] = 1; });
    return (view.sort || [])
      .filter(function (s) { return fields[s.col]; })      // sorter na neexistující sloupec = výjimka
      .map(function (s) { return { column: s.col, dir: s.dir }; });
  }

  function mountTable(tab, mount, rows, view) {
    var id = mountIdOf(tab);
    var tblEl = mount.querySelector('.ads-tbl');
    var cols = resolveColumns(view);
    var sorters = sortersFor(view, cols);

    /* T8 — sumární řádek je teď Tabulator bottomCalc (per sloupec, zarovnaný pod gridem,
     * respektuje funnel filtr i stránkování=celý dataset). Starou slitou patičku
     * `.ads-foot` (footerHTML) už neplníme — necháváme ji skrytou. */
    lastRows[tab] = rows;
    var footEl = mount.querySelector('.ads-foot');
    if (footEl) { footEl.innerHTML = ''; footEl.hidden = true; }

    if (tables[id]) {
      whenBuilt(id, function (t) {
        applying[tab] = true;
        try {
          t.setColumns(cols);
          // T5: respektuj konkrétní pageSize (10/20/50/100). null = VŠE (true).
          // Fallback na paginate kryje legacy view bez pole pageSize.
          t.setPageSize(view.pageSize == null ? (view.paginate ? 20 : true) : view.pageSize);
          t.setData(rows).then(function () {
            if (sorters.length) { try { t.setSort(sorters); } catch (e) { console.warn('[tables] setSort selhal:', e); } }
            releaseApplying(tab);
            renderHiddenBar(tab);
            markSorters(t);
          }).catch(function (e) { console.error('[tables] setData selhal:', e); releaseApplying(tab); });
        } catch (e) {
          console.error('[tables] přepnutí view selhalo:', e);
          releaseApplying(tab);
        }
      });
      mount.classList.toggle('no-pag', !view.paginate);
      return;
    }

    tblEl.innerHTML = '';
    applying[tab] = true;
    var cfg = {
      data: rows,
      columns: cols,
      layout: 'fitColumns',
      index: 'creative',
      reactiveData: false,
      movableColumns: true,          // E3: přehazování pořadí tažením hlavičky
      renderVertical: 'basic',
      placeholder: 'Žádná data.',
      // E2: `resizable:true` per sloupec (v6 nemá globální `resizableColumns`).
      // E1: headerWordWrap → dvouslovné popisky se zalomí místo useknutí.
      // alignEmptyValues:'bottom' — prázdné/„—" hodnoty (CPA bez rezervací, funnel „---"…)
      // jdou VŽDY dolů, ať řadím vzestupně nebo sestupně (Filip: nechci je nahoře).
      columnDefaults: { headerHozAlign: 'left', resizable: true, tooltip: true, headerWordWrap: true, alignEmptyValues: 'bottom' },
      initialSort: sorters,
      rowFormatter: expandableRowFormatter,
      locale: 'cs',
      langs: TAB_LANGS,
      // Stránkování je ZAPNUTÉ vždy (v6 ho za běhu přidat nejde) a per view se jen
      // přepíná velikost stránky. „Na kill" má setPageSize(true) = vše na jedné
      // stránce + CSS .no-pag schová footer → chová se přesně jako dřív BEZ stránkování.
      pagination: true,
      paginationMode: 'local',
      paginationSize: view.pageSize == null ? (view.paginate ? 20 : true) : view.pageSize,
      // Filip: „řádkování dej dolů do lišty" → nativní výběr počtu řádků v DOLNÍ patičce
      // Tabulatoru (Řádků: 10/20/50/100/Vše). Perzistuje se přes pageSizeChanged níž.
      paginationSizeSelector: [10, 20, 50, 100, true],
      paginationCounter: 'rows',
      // T8: sumární řádek (bottomCalc na sloupcích). `true` = počítá nad CELÝM
      // (filtrovaným) datasetem, ne jen nad aktuální stránkou — „Σ spend" napříč
      // všemi kreativami je užitečné číslo, „Σ prvních 20 řádků" ne.
      columnCalcs: true
    };
    var t = new window.Tabulator(tblEl, cfg);
    // ★ F8/A3 — klik na řádek NEjede přes Tabulatorí rowClick (rozejde se mu evidence
    // řádků po přeřazení a přestane dispatchovat). Vlastní delegace, viz wireRowClicks.
    wireRowClicks(tblEl);
    tables[id] = t;
    tableBuilt[id] = false;
    builtQueue[id] = [];
    t.on('tableBuilt', function () {
      flushBuilt(id);
      releaseApplying(tab);
      renderHiddenBar(tab);
      tameColumnDrag(t, tblEl);   // ★ F8/B1 — bez tohohle půlka kliků na hlavičku neseřadí
      markSorters(t);
    });
    t.on('columnResized', function () { persistColumns(tab); });          // E2
    t.on('columnMoved', function () { persistColumns(tab); });            // E3
    t.on('columnVisibilityChanged', function () { renderHiddenBar(tab); }); // S1
    t.on('dataSorted', function () { persistSort(tab); markSorters(t); });
    // Změna počtu řádků v dolní liště → ulož do view (pamatuje se). Guard proti smyčce:
    // patch → applyPageSize → setPageSize by mohlo znovu vystřelit pageSizeChanged.
    t.on('pageSizeChanged', function (size) {
      var ps = (size === true) ? null : num(size);
      var av = (ADS.views.active && ADS.views.active(tab)) || null;
      if (av && av.pageSize === ps) return;                 // beze změny → neškrábej
      applying[tab] = true;                                 // ozvěnu setPageSize ignoruj
      if (ADS.views.patch) ADS.views.patch(tab, { pageSize: ps });
      releaseApplying(tab);
    });
    mount.classList.toggle('no-pag', !view.paginate);
  }
  // Guard musí přežít ASYNCHRONNÍ ozvěnu: setColumns/setData/setSort dopočítají layout
  // a vystřelí columnResized/dataSorted, které NEJSOU od uživatele. S 0 ms se ozvěna
  // trefila AŽ ZA guard a označila view jako „neuložené", aniž by kdokoli na něco sáhl.
  function releaseApplying(tab) {
    clearTimeout(applyTimer[tab]);
    applyTimer[tab] = setTimeout(function () { applying[tab] = false; }, 300);
  }

  function renderTab(tab) {
    var mount = getMount(mountIdOf(tab));
    if (!mount) return;
    ensureScaffold(mount, tab);

    var view = ADS.views.active(tab);
    if (!view) return;
    var token = (renderTokens[tab] = (renderTokens[tab] || 0) + 1);

    // 1) POČTY DO ZÁLOŽEK — každý segment jednou, i když ho sdílí víc views.
    var segs = {};
    ADS.views.list(tab).forEach(function (v) { (segs[v.segment] = segs[v.segment] || []).push(v); });
    Object.keys(segs).forEach(function (seg) {
      fetchSegment(tab, seg).then(function (rows) {
        if (token !== renderTokens[tab]) return;
        var out = {};
        segs[seg].forEach(function (v) { out[v.id] = applyViewFilters(rows, v).length; });
        ADS.views.setCounts(tab, out);
      }).catch(function (err) {
        console.warn('[tables] počet pro segment ' + seg + ' selhal:', errMsg(err));
      });
    });

    // 2) DATA AKTIVNÍHO VIEW
    setStatus(mount, 'loading');
    fetchSegment(tab, view.segment).then(function (all) {
      if (token !== renderTokens[tab]) return;                  // mezitím přišlo jiné období/view
      // ★ F8/C — aktivní pohled respektuje překlik „Jen aktivní" z lišty (počty v záložkách
      // výš schválně NE: ty mají ukazovat stav VIEW, ne můj momentální překlik).
      var rows = applyViewFilters(all, view, effActiveOnly(tab, view));
      setStatus(mount, 'ok');
      setCount(mount, summaryFor(view, rows));
      setSub(mount, view.name + (view.sub ? ' · ' + view.sub : ''));

      setEmpty(mount, view, view.mode !== 'tiles' && rows.length === 0);

      if (view.mode === 'tiles') {
        // Tabulku i její ovládání schovej — dlaždice mají vlastní řazení i pásma.
        mount.classList.add('is-tiles');
        if (!showTiles(tab, view, rows)) {
          // Dlaždice nemá kdo vykreslit (newest.js chybí a ADS.renderTiles taky)
          // → radši poctivě tabulka než prázdné místo.
          mount.classList.remove('is-tiles');
          console.warn('[tables] dlaždice nejsou k dispozici → padám na tabulku.');
          mountTable(tab, mount, rows, view);
          buildFunnelChips(mount, tab, rows);
          applyFunnelFilter(tab);
        }
        return;
      }
      mount.classList.remove('is-tiles');
      hideTiles(tab);
      mountTable(tab, mount, rows, view);
      buildFunnelChips(mount, tab, rows);
      applyFunnelFilter(tab);
    }).catch(function (err) {
      if (token !== renderTokens[tab]) return;
      setStatus(mount, 'error', function () { dropCache(); renderTab(tab); });
      setCount(mount, '');
      console.error('[tables] ' + tab + '/' + view.segment + ' fetch selhal:', err);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Registrace
   * ------------------------------------------------------------------ */
  restructureDOM();

  // onReady = start + změna období + změna tabu + refresh + zavření wizardu.
  // F1-top / F1-newest-rmb: přiřazení funnelu jde vyvolat i odjinud (detail v newest.js,
  // right-click v Nejnovějších) — přes ADS.assignFunnel(rowData).
  ADS.assignFunnel = openFunnelModalData;

  ADS.onReady(function () {
    // Views musí být načtené dřív, než se ptáme na aktivní view (prefs jdou ze serveru).
    ADS.views.ready.then(function () { renderTab(tabOf()); });
  });

  // Přepnutí view / uložení / smazání → překresli jen dotčený tab.
  ADS.views.onChange(function (e) {
    if (!e || !e.tab) return;
    // 'patch' = drobná změna aktivního view (dřív jen sloupce). Filip: stránkování „nefunguje" —
    // protože pageSize se mění taky přes patch a my jsme tu vraceli early. Teď na patch
    // aplikujeme pageSize (bez full re-renderu), zbytek patch ignorujeme.
    if (e.reason === 'patch') { applyPageSize(e.tab, e.view); return; }
    // ★ F8/C — jiný view = jiná výchozí volba „Jen aktivní" → zahoď můj překlik.
    if (e.reason === 'active') actOnlyOv[e.tab] = undefined;
    renderTab(e.tab);
  });

  // Aplikuj pageSize aktivního view na živou tabulku (10/20/50/100 nebo null = vše).
  function applyPageSize(tab, view) {
    var id = mountIdOf(tab);
    var v = view || (ADS.views.active && ADS.views.active(tab));
    if (!tables[id] || !v) return;
    whenBuilt(id, function (t) {
      try { t.setPageSize(v.pageSize == null ? (v.paginate ? 20 : true) : v.pageSize); }
      catch (err) { console.warn('[tables] setPageSize selhal:', err); }
    });
    var mount = getMount(id);
    if (mount) mount.classList.toggle('no-pag', v.pageSize == null && !v.paginate);
  }

  if (ADS.bus && typeof ADS.bus.addEventListener === 'function') {
    /* F7/A5: přepnutí tabu/období nechávalo otevřené modaly viset → uklidit.
     * Musí to být PŘED ostatními listenery: kdyby překreslení spadlo, overlay je už pryč. */
    ADS.bus.addEventListener('tabchange',    function () { sweepOverlays('tabchange'); });
    ADS.bus.addEventListener('periodchange', function () { sweepOverlays('periodchange'); });
    /* F7/D7 — flagy se nekreslí z dat řádku, ale ze sdíleného storu (ADS.flags), takže
     * po jejich změně musí buňky přeformátovat někdo zvenčí. reformat() jen překreslí
     * obsah — NEsahá na data, filtr ani řazení, takže se pod rukama nic nepřeskládá. */
    ADS.bus.addEventListener('flagschange', function () {
      Object.keys(tables).forEach(function (id) {
        if (!isBuilt(id)) return;
        try { tables[id].getRows().forEach(function (r) { r.reformat(); }); } catch (_) { }
      });
    });
    /* F7/A5 — POSLEDNÍ POJISTKA. Osiřelý overlay nemá vlastní Escape handler (jeho modal
     * o něm už neví), takže by ho neuklidilo nic a jediná cesta ven by byl reload.
     * Živé modaly si Escape obsluhují samy a tenhle sweep je jen dorovná — outcome je
     * v obou případech „zavřít". */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') sweepOverlays('escape');
    });
    /* ★ F8/A2 — SAMOOPRAVNÝ HLÍDAČ PŘEKRYTÍ (Filip 10. 8.: „velmi často nejde kliknout
     * na řádek ani na náhled ani na šipku rozkliku").
     *
     * Escape pomůže jen tomu, kdo ví, že má zmáčknout Escape. Tenhle hlídač to vyřeší
     * sám: při KAŽDÉM stisku nad tabulkou se podívá, co je reálně nahoře v místě kurzoru.
     * Když to není prvek z tabulky, ale osiřelá vrstva (modal, jehož obsah už neexistuje),
     * vrstvu zahodí a klik ZOPAKUJE — Filip tak ani nepozná, že se něco dělo.
     * Když nahoře leží něco, co neumíme zařadit, aspoň to VYPÍŠE do konzole s identitou
     * prvku. Doteď byl výsledek v obou případech stejný: ticho a mrtvá tabulka.
     *
     * capture=true a `pointerdown`: musí to proběhnout dřív, než klik dorazí kamkoli. */
    document.addEventListener('pointerdown', function (e) {
      var sec = e.target && e.target.closest && e.target.closest('.ads-sec');
      // Klik dorazil do tabulky → nic neřešíme. Řeší se jen klik, který do ní NEDORAZIL.
      if (sec) return;
      var blocker = e.target && e.target.closest && e.target.closest('.ads-modal-ov, .modal-overlay, .hw-overlay');
      if (!blocker) return;
      // Živý modal poznáme podle toho, že v sobě má obsah (panel). Prázdná vrstva = mrtvola.
      var alive = !!blocker.querySelector('.ads-modal, .modal, .hw-panel');
      if (alive) return;
      // Je pod tou vrstvou vůbec tabulka? Když ne, není co zachraňovat.
      blocker.style.pointerEvents = 'none';
      var below = document.elementFromPoint(e.clientX, e.clientY);
      blocker.style.pointerEvents = '';
      console.warn('[ads] klik trefil OSIŘELOU vrstvu (' + blocker.className + ') — uklízím a opakuji klik');
      sweepOverlays('stray-blocker');
      if (below && below.closest && below.closest('.ads-sec')) {
        var opt = { bubbles: true, cancelable: true, view: window, clientX: e.clientX, clientY: e.clientY };
        below.dispatchEvent(new MouseEvent('mousedown', opt));
        below.dispatchEvent(new MouseEvent('mouseup', opt));
        below.dispatchEvent(new MouseEvent('click', opt));
      }
    }, true);
    ADS.bus.addEventListener('killed', onKilledEvent);
    // Po killu/refreshi jsou data v cache zastaralá. Řádek v tabulce si přepíšeme živě
    // (onKilledEvent), ale příští přepnutí view musí sáhnout na server.
    ADS.bus.addEventListener('killed', dropCache);
    ADS.bus.addEventListener('refreshed', dropCache);
  }

  injectStyles();
  wireHints();      // F2: delegované listenery pro hinty hlaviček (jednou za stránku)
  /* T7/T11: očičko v hlavičce je pryč (wireEyes s ním). Nahradila ho tahle trojice —
   * BEZ ní by pravý klik nedělal nic a Filip by neměl JAK skrýt sloupec ani killnout
   * z menu. ⚠️ `wireEyes()` tu do 17. 7. zůstal viset jako volání funkce, která už
   * neexistovala → ReferenceError uprostřed main() shodil zbytek inicializace. */
  wireColMenu();    // T7: pravý klik na hlavičku → skrýt sloupec
  wireRowMenu();    // T11: pravý klik na řádek → kill / funnel / odkazy
  wireCtxClose();   // zavírání obou menu (klik jinam, scroll, resize, Esc)


  /* ================================================================== *
   *  STYLY (light, krémově-bílá/šedá, žádná zlatá)
   * ================================================================== */
  function injectStyles() {
    if (document.getElementById('ads-tables-css')) return;
    var css = `
.ads-sec{
  --at-bg:#ffffff; --at-cream:#faf8f4; --at-cream2:#f4f1ea;
  --at-ln:#eceae3; --at-ln2:#f2f0ea; --at-tx:#2c2b28; --at-mut:#8d897f;
  --at-hover:#faf7f1; --at-shadow:0 1px 2px rgba(30,25,15,.05),0 1px 3px rgba(30,25,15,.04);
  --at-radius:12px;
  margin:0 0 26px; color:var(--at-tx);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.ads-sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 2px 10px}
.ads-sec-head .ash-l{display:flex;align-items:baseline;gap:9px;min-width:0}
.ads-sec-head .ash-emoji{font-size:16px;line-height:1}
.ads-sec-head .ash-title{font-size:16px;font-weight:700;letter-spacing:-.01em}
.ads-sec-head .ash-count{font-size:12.5px;color:var(--at-mut);font-weight:500;white-space:nowrap}
.ads-sec-head .ash-r{display:flex;align-items:center;gap:12px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.ads-sec-head .ash-sub{font-size:12px;color:var(--at-mut);font-style:italic}

/* --- D3/C1: PRUH OVLÁDÁNÍ nad tabulkou -----------------------------------------------
   Chipy funnelů. ⚠️ MUSÍ zůstat MIMO „.ads-sec-head" — shell má v styles.css
   „.sec .ads-sec-head{display:none}" (nadpis se zrcadlí do hlavičky sbalovací sekce),
   takže cokoli uvnitř té hlavičky je pro Filipa neviditelné. Přesně tam colbar dřív byl
   → „tlačítko není vidět".
   ⚠️ Uložení rozložení sloupců už tady NENÍ: po konsolidaci je rozložení VLASTNOST VIEW
   a ukládá se tlačítkem „💾 Uložit view" v řádku záložek (views.js). */
.ads-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.ads-toolbar:empty,.ads-sec.is-tiles .ads-toolbar{display:none}
@media(max-width:900px){.ads-sec-head .ash-sub{display:none}}

/* --- S1: PRUH SKRYTÝCH SLOUPCŮ -------------------------------------------------------
   Filip: „očičko v hlavičce = skrýt; nahoře seznam skrytých → klik = vrátit."
   Pruh je vidět JEN když něco skryté je → za normálu nezabírá ani pixel. Zároveň je to
   jediné místo, kde je vidět, že „New leads" a „VLeads" vůbec existují (jsou defaultně
   skryté, aby se tabulka nenafoukla na 18 sloupců). */
/* --- F7/A4: HLEDÁNÍ V TABULCE ---------------------------------------------------------
   Filip: „přidat vlevo od Skryté sloupce ještě políčko na hledání ve stejném designu."
   Proto stejná kostra jako pruh skrytých sloupců (krémové pozadí, 10px rádius, stejná
   výška prvků 26px) — jen plná linka místo čárkované, ať se pozná aktivní vstup od
   pasivního výpisu. Píše se do něj → vizuálně o stupeň „živější".
   ⚠️ Pole nesmí být uvnitř .ads-hidden — ten se schovává (hidden), když nic není skryté. */
.ads-searchbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px;
  padding:7px 10px;background:var(--at-cream);border:1px solid var(--at-ln);border-radius:10px}
.ads-sec.is-tiles .ads-searchbar{display:none}
.ads-searchbar .asb-wrap{position:relative;display:inline-flex;align-items:center;flex:0 1 320px;min-width:190px}
.ads-searchbar .asb-ico{position:absolute;left:9px;font-size:11.5px;line-height:1;pointer-events:none;opacity:.6}
.ads-searchbar .asb-in{width:100%;height:26px;padding:0 26px 0 27px;background:#fff;color:var(--at-tx);
  border:1px solid var(--at-ln);border-radius:999px;font-family:inherit;font-size:11.5px;font-weight:600;
  line-height:1;-webkit-appearance:none;appearance:none;transition:border-color .12s,box-shadow .12s}
.ads-searchbar .asb-in::placeholder{color:var(--at-mut);font-weight:500}
.ads-searchbar .asb-in:focus{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16)}
/* nativní křížek Safari/Chrome pryč — máme vlastní, ať sedí do jazyka zbytku */
.ads-searchbar .asb-in::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.ads-searchbar .asb-x{position:absolute;right:5px;width:18px;height:18px;padding:0;display:flex;
  align-items:center;justify-content:center;background:transparent;border:0;border-radius:999px;
  color:#a86a78;font-family:inherit;font-size:15px;font-weight:700;line-height:1;cursor:pointer}
.ads-searchbar .asb-x:hover{background:#f2e6e8}
.ads-searchbar .asb-x[hidden]{display:none}
.ads-searchbar.is-on .asb-in{border-color:#c9a9b0;background:#fff}
.ads-searchbar .asb-cnt{font-size:11px;font-weight:700;color:var(--at-mut);white-space:nowrap}
.ads-searchbar .asb-cnt.is-empty{color:#a3413a}
/* --- F7/D7: sloupec Flag (poznámky ke kreativě) --- */
.ads-sec .tabulator .tabulator-cell.c-flag{justify-content:center;cursor:pointer}
.fl-none{color:var(--at-mut);opacity:.5}
.fl-on{display:inline-flex;align-items:center;gap:2px;font-size:13px;line-height:1;cursor:help}
.fl-on i{font-style:normal;font-size:10px;font-weight:800;color:#a86a78;
  background:#f7ecee;border-radius:999px;padding:1px 4px;line-height:1}
.ads-searchbar .asb-cnt[hidden]{display:none}

.ads-hidden{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px;
  padding:7px 10px;background:var(--at-cream);border:1px dashed var(--at-ln);border-radius:10px}
.ads-hidden[hidden]{display:none}
.ads-sec.is-tiles .ads-hidden{display:none}
/* ★ F8/C — přepínač „Jen aktivní" bydlí v téhle liště, takže lišta se od 10. 8. ukazuje
   i bez skrytých sloupců. Pravidlo „.ads-sec.is-empty .ads-hidden{display:none}" muselo
   pryč (je níž zrušené): kdyby filtr vyprázdnil tabulku, neměl by ho Filip jak vypnout. */
.ads-hidden .hc-act{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;
  letter-spacing:.02em;color:var(--at-tx);cursor:pointer;user-select:none;white-space:nowrap}
.ads-hidden .hc-act input{width:14px;height:14px;margin:0;accent-color:#a86a78;cursor:pointer}
.ads-hidden .hc-act.is-ov{color:#8d5563}
.ads-hidden .hc-act .hc-ov{font-style:normal;font-size:14px;line-height:1;color:#a86a78}
.ads-hidden .hc-sep{width:1px;height:16px;background:var(--at-ln);margin:0 4px}
.ads-hidden .hc-lbl{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:var(--at-mut);margin-right:2px;white-space:nowrap;cursor:help}
.ads-hidden .hc-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;margin:0;
  background:#fff;color:var(--at-mut);border:1px solid var(--at-ln);border-radius:999px;
  font-family:inherit;font-size:11.5px;font-weight:600;line-height:1;cursor:pointer;
  -webkit-appearance:none;appearance:none;white-space:nowrap;
  transition:background .12s,border-color .12s,color .12s}
.ads-hidden .hc-chip:hover{background:#fff;border-color:#c9a9b0;color:var(--at-tx)}
.ads-hidden .hc-chip:focus-visible{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16)}
.ads-hidden .hc-chip i{font-style:normal;font-size:13px;font-weight:700;color:#a86a78;line-height:1}
.ads-hidden .hc-all{margin-left:2px;padding:0 8px;height:26px;background:transparent;border:0;
  color:#a86a78;font-family:inherit;font-size:11.5px;font-weight:700;cursor:pointer;text-decoration:underline;
  text-underline-offset:2px}
.ads-hidden .hc-all:hover{color:#8d5563}

/* C1: CHIPY FUNNELU jsou v LINKOVANE public/css/tables.css (napevno barvy) — chipy v grafu
   ziji mimo .ads-sec, kde byly promenne --at-, takze jim mizelo pozadi. Tady schvalne NEJSOU,
   at injektovany blok neprebije linkovany. */
.ads-status{padding:10px 2px;font-size:13px}
.ads-status .ld{color:var(--at-mut);display:inline-flex;align-items:center;gap:8px}
.ads-status .err{color:#c0392b;font-weight:600}
.ads-sec .empty,.sub-empty{padding:16px;color:var(--at-mut);font-size:13px;background:var(--at-cream);border:1px dashed var(--at-ln);border-radius:10px}
/* POZOR: Tabulator přidá třídu .tabulator PŘÍMO na mount element (.ads-tbl / .ads-sub-tbl).
   Selektory proto kotvíme na .ads-sec (skutečný předek) — ".ads-tbl .tabulator" by nikdy nesedlo. */

/* --- spinner --- */
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(0,0,0,.15);border-top-color:#c0392b;border-radius:50%;animation:ads-spin .7s linear infinite;vertical-align:-2px}
@keyframes ads-spin{to{transform:rotate(360deg)}}

/* --- Tabulator light override --- */
.ads-sec .tabulator{background:var(--at-bg);border:1px solid var(--at-ln);border-radius:var(--at-radius);font-size:13px;overflow:hidden;box-shadow:var(--at-shadow)}

/* ⚠️ C2 — „container má fixní výšku, po rozkliknutí detailu se nezvětší" ---------------
   PŘÍČINA (dohledaná ve zdrojáku vendoru + změřená v prohlížeči, ne odhad):
   „renderVertical:'basic'" NEZNAMENÁ, že Tabulator nechá výšku na pokoji — basic renderer
   má „verticalFillMode = "fill"", takže RowManager.adjustTableSize() nastaví
   „.tabulator-tableholder" INLINE PIXELOVOU výšku:
       this.element.style.height = this.table.element.clientHeight - headerH + "px";
   Naměřeno na živé kill tabulce: holder dostal „height:222px". Po rozkliknutí řádku
   narostl obsah (.tabulator-table) 212 → 438 px, ale holder zůstal na 222 px a má
   „overflow-y:auto" → detail se ZAVŘEL DO 222px SCROLLOVACÍHO OKÝNKA a „.sec" se
   nezvětšila (387 px před i po). Přesně to, co Filip popisuje.
   ŘEŠENÍ: „height:auto !important" — pravidlo se „!important" ve stylopisu přebije inline
   styl vendoru, takže se s ním nemusíme prát v JS. Ověřeno: „.sec" 387 → 613 px, detail
   se nikde neořízne, vnitřní svislý scroll zmizel (scrollHeight == clientHeight).
   Bezpečné i na výkon: basic renderer stejně kreslí VŠECHNY řádky, takže vnitřní svislý
   scroll nic neušetřil — jen schovával obsah. Nekonečná smyčka nehrozí: adjustTableSize()
   porovnává clientHeight před/po a ten se díky !important nemění → žádný redraw navíc.
   ⚠️ Vodorovný scroll NECHÁVÁME (overflow-x) — tabulka má po F1 16 sloupců a musí jít
   posouvat do stran. */
.ads-sec .tabulator .tabulator-tableholder{height:auto !important;max-height:none !important}
.ads-sec .tabulator .tabulator-header{background:var(--at-cream);border-bottom:1px solid var(--at-ln);color:var(--at-mut)}
.ads-sec .tabulator .tabulator-header .tabulator-col{background:transparent;border-right:1px solid transparent}
.ads-sec .tabulator .tabulator-header .tabulator-col .tabulator-col-content{padding:9px 10px}
/* E1: menší font + prostrkání = ~8 % šířky hlavičky zadarmo.
   ZALOMENÍ hlaviček NEŘEŠÍME tady, ale přes headerWordWrap:true v columnDefaults —
   vendor si pak sám přidá .tabulator-col-title-wrap (white-space:normal).
   ⚠️ Nesnaž se nowrap/ellipsis přebít odsud: vendorový selektor
   .tabulator .tabulator-header .tabulator-col .tabulator-col-content .tabulator-col-title
   má 5 tříd a jakýkoli rozumný selektor odsud prohraje na specificitě (ověřeno — zalomení
   se neprojevilo, dokud jsem nepoužil nativní option). */
.ads-sec .tabulator .tabulator-header .tabulator-col-title{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.02em;line-height:1.22}
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover{background:var(--at-cream2)}
/* --- F7/A1: podle kterého sloupce se řadí ---------------------------------------------
   Vendor kreslí šipku šedou (#666 aktivní / #bbb nečinná) a hlavičku nijak neodliší →
   po přeřazení nešlo poznat, podle čeho tabulka jede. Tabulator sám dává na seřazený
   .tabulator-col atribut aria-sort=ascending|descending, takže stačí navěsit se na něj.
   Šipka = CSS trojúhelník (border-bottom-color = barva), proto se barví border, ne fill.
   4 třídy + atribut přebijí vendor bez !important. */
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"],
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="descending"]{background:var(--accent-weak)}
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .tabulator-col-title,
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .tabulator-col-title{color:var(--accent-700);font-weight:700}
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .tabulator-col-sorter .tabulator-arrow{border-bottom-color:var(--accent)}
/* sestupně: vendor šipku otáčí přes border-top → obarvit obě strany, ať to sedne v obou směrech */
.ads-sec .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .tabulator-col-sorter .tabulator-arrow{border-top-color:var(--accent);border-bottom-color:var(--accent)}
/* ★ F8/B2 — DVĚ PŘEDCHOZÍ PRAVIDLA SAMA NESTAČILA (změřeno 10. 8.: aktivní šipka měla
   dál rgb(102,102,102)). Vendorový selektor
   .tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=…]
     .tabulator-col-content .tabulator-col-sorter .tabulator-arrow
   má 8 tříd, náš 7 → vendor vyhrál na specificitě a accent se nikdy nevykreslil.
   Tady dorovnáváme cestu přes .tabulator-col-content (stejná délka) + .tabulator-sortable
   a k tomu !important, ať to nemůže znovu tiše vyhnít při upgradu vendoru.
   ⚠️ NEMAZAT ani „nezjednodušovat" — pravidla výš jsou bez tohohle mrtvá. */
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort="ascending"] .tabulator-col-content .tabulator-col-sorter .tabulator-arrow{
  border-bottom-color:var(--accent) !important}
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort="descending"] .tabulator-col-content .tabulator-col-sorter .tabulator-arrow{
  border-top-color:var(--accent) !important}
/* Neaktivní sloupce: vendor jim kreslí ÚPLNĚ STEJNOU šipku nahoru jako vzestupnému řazení
   (jen světlejší šedou). Devatenáct šipek nahoru + jedna „taky nahoru" = nedá se poznat,
   podle čeho tabulka jede. Ztlumíme je skoro k nule a ukážeme až na hover té hlavičky. */
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort="none"] .tabulator-col-sorter .tabulator-arrow{opacity:.16;transition:opacity .12s}
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort="none"]:hover .tabulator-col-sorter .tabulator-arrow{opacity:.75}
/* Víc sorterů najednou: Tabulator bere jako PRIMÁRNÍ POSLEDNÍ v seznamu (views.js), takže
   bez pořadového čísla vypadají dvě šipky rovnocenně a tabulka „nesedí ani na jednu". */
.ads-sec .tabulator .tabulator-header .tabulator-col[data-sortidx]{position:relative}
.ads-sec .tabulator .tabulator-header .tabulator-col[data-sortidx]::after{
  content:attr(data-sortidx);position:absolute;right:3px;top:2px;z-index:2;pointer-events:none;
  font-size:8.5px;font-weight:800;line-height:1;color:var(--accent)}
/* Řádek zůstává BLOKOVÝ (Tabulator default) — appendnutý .ads-subwrap tak spadne
   sám na nový řádek. Flex-wrap na řádku NEPOUŽÍVAT: zalomil by poslední buňku (Kill). */
.ads-sec .tabulator .tabulator-row{background:var(--at-bg);border-bottom:1px solid var(--at-ln2);height:auto !important}
.ads-sec .tabulator .tabulator-row.tabulator-row-even{background:var(--at-bg)}
.ads-sec .tabulator .tabulator-row:hover{background:var(--at-hover)}
/* inline-flex = drží inline tok buněk (jako default inline-block) + umí centrovat obsah */
.ads-sec .tabulator .tabulator-row .tabulator-cell{border-right:none;padding:7px 10px;display:inline-flex;align-items:center;vertical-align:middle;min-height:52px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ads-sec .tabulator .tabulator-row .tabulator-cell.c-num,.ads-sec .tabulator .tabulator-cell.c-sem{font-variant-numeric:tabular-nums;justify-content:flex-end}
.ads-sec .tabulator .tabulator-cell.c-trend,.ads-sec .tabulator .tabulator-cell.c-exp,.ads-sec .tabulator .tabulator-cell.c-kill{justify-content:center}
.ads-sec .tabulator .tabulator-cell.c-scale,.ads-sec .tabulator .tabulator-cell.c-dop,.ads-sec .tabulator .tabulator-cell.c-bar{justify-content:flex-start}
.ads-sec .tabulator .tabulator-row.is-killed{opacity:.55;background:var(--at-cream2)}
.ads-sec .tabulator .tabulator-row.is-killed:hover{background:var(--at-cream2)}
/* E2: úchyt pro změnu šířky — Tabulator ho kreslí průhledný (jen kurzor ew-resize),
   takže tu funkci nikdo nenajde. Podbarvíme ho na hoveru.
   ⚠️ Handle NENÍ dítě .tabulator-col — Tabulator ho vkládá jako SOUROZENCE hned za něj
   (element.after(handle)) do .tabulator-headers. Descendant selektor přes .tabulator-col
   by NIKDY nesedl (ověřeno v prohlížeči i ve zdrojáku vendoru).
   ⚠️ Šířku NEPŘEPISOVAT: vendor má vyváženou matematiku margin-left/-right:-3px + width:6px
   (a :last-of-type width:3px) — jiná šířka posune mřížku.
   ⚠️⚠️ TENHLE BLOK JE JS TEMPLATE LITERÁL (backtick string) → uvnitř NESMÍ být zpětný
   apostrof ANI V KOMENTÁŘI, jinak literál skončí a soubor přestane parsovat.
   Kód uváděj bez uvozovek nebo v „českých". Guard: tools/csscheck.py */
.ads-sec .tabulator .tabulator-header .tabulator-col-resize-handle:hover{background:#c9a9b0;opacity:.5;border-radius:2px}
/* E3: tažená hlavička ať je vidět (Tabulator jinak posune jen ducha) */
.ads-sec .tabulator .tabulator-header .tabulator-col.tabulator-moving{background:var(--at-cream2);border:1px solid #c9a9b0;box-shadow:0 6px 18px rgba(30,25,15,.16)}

/* --- E5: stránkování („vypadá jak Windows XP") ---------------------------------------
   Příčina: footer si držel čistě vendorový vzhled tabulator.min.css — hranaté šedé
   knoflíky s 3D rámečkem. Tady ho přebíjíme (4 třídy > 3 vendorové) na stejný jazyk
   jako zbytek: bílé pilulky, aktivní stránka plná tmavá, kompaktní výška. */
.ads-sec .tabulator .tabulator-footer{background:var(--at-cream);border-top:1px solid var(--at-ln);color:var(--at-mut);padding:0;font-family:inherit}
.ads-sec .tabulator .tabulator-footer .tabulator-footer-contents{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:7px 10px;margin:0}
.ads-sec .tabulator .tabulator-footer .tabulator-page-counter{margin:0;font-size:11.5px;font-weight:500;color:var(--at-mut)}
.ads-sec .tabulator .tabulator-footer .tabulator-paginator{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:1;color:var(--at-mut);font-size:12px;text-align:right}
.ads-sec .tabulator .tabulator-footer .tabulator-paginator label{margin:0 3px 0 0;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--at-mut)}
.ads-sec .tabulator .tabulator-footer .tabulator-pages{display:flex;align-items:center;gap:4px;margin:0}
.ads-sec .tabulator .tabulator-footer .tabulator-page{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:28px;height:28px;padding:0 8px;margin:0;border:1px solid var(--at-ln);border-radius:8px;background:#fff;color:var(--at-tx);font-family:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;transition:background .12s,border-color .12s,color .12s,opacity .12s}
/* pozor: vendor má překlep „:not(disabled)" (matchuje vždy) → tady správně „:not(:disabled)" */
.ads-sec .tabulator .tabulator-footer .tabulator-page:not(:disabled):hover{background:var(--at-cream2);border-color:#ddd8cc;color:var(--at-tx);opacity:1}
.ads-sec .tabulator .tabulator-footer .tabulator-page.active{background:var(--at-tx);border-color:var(--at-tx);color:#fff}
.ads-sec .tabulator .tabulator-footer .tabulator-page.active:hover{background:var(--at-tx);border-color:var(--at-tx);color:#fff}
.ads-sec .tabulator .tabulator-footer .tabulator-page:disabled{opacity:.35;cursor:default;background:#fff}
.ads-sec .tabulator .tabulator-footer .tabulator-page:focus-visible{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16)}
.ads-sec .tabulator .tabulator-footer .tabulator-page-size{height:28px;margin:0 0 0 4px;padding:0 6px;border:1px solid var(--at-ln);border-radius:8px;background:#fff;color:var(--at-tx);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}
@media(max-width:640px){
  .ads-sec .tabulator .tabulator-footer .tabulator-footer-contents{justify-content:center}
  .ads-sec .tabulator .tabulator-footer .tabulator-paginator{justify-content:center}
}

/* --- Náhled ---
   N3 (Filip): „list view = malé stačí, ale o 30 % větší, nízká kvalita OK."
   → 38 → 50 px (+31,6 %). Řádek se tím nezvedne: buňka má min-height 52 px, takže
   náhled doteď zbytečně plaval v prázdnu. Sub-náhled v rozkliku 30 → 39 px (+30 %).
   Sloupec „Náhled" (70 px) obě velikosti pobere i s paddingem (2×10 px). */
.prev{display:flex;align-items:center;gap:9px;min-width:0}
.prev-img{width:50px;height:50px;border-radius:8px;object-fit:cover;background:var(--at-cream2);flex:0 0 auto;border:1px solid var(--at-ln);cursor:zoom-in}
.prev-img.sm{width:39px;height:39px;border-radius:6px}
.prev-img.noimg{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--at-mut);text-transform:uppercase}
.prev-copy{font-size:12.5px;color:var(--at-tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prev-copy.sm{font-size:12px;color:var(--at-mut)}
.c-prev{cursor:pointer}

/* --- hover pop-up --- */
/* F1: „hover preview 2× větší" → 220 → 440 px.
   ⚠️ Když sáhneš na rozměr, sáhni i na pw/ph v showHover() — z nich se počítá překlopení
   pop-upu u pravého/spodního okraje. */
.ads-thumb-pop{position:fixed;z-index:9999;display:none;padding:5px;background:#fff;border:1px solid var(--at-ln,#eceae3);border-radius:12px;box-shadow:0 8px 28px rgba(30,25,15,.18);opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s;pointer-events:none}
.ads-thumb-pop.show{opacity:1;transform:translateY(0)}
.ads-thumb-pop img{display:block;width:440px;height:440px;object-fit:cover;border-radius:8px}

/* --- kreativa + chip --- */
.c-cr{gap:7px}
.cr-code{font-weight:600;font-size:12.5px;letter-spacing:-.01em;margin-right:7px}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;line-height:1.5;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.chip-funnel{background:#eef2f7;color:#4a6178;border:1px solid #e0e7ef}
.chip.scale{background:#e7f6ec;color:#1b7a3d;border:1px solid #d0ecd9}
.chip.scale .scale-q{color:#9a6b14;font-weight:800;cursor:help}
.chip.fresh{background:#eef4fb;color:#3f6fa0;border:1px solid #dde8f4}
.chip.wait{background:#fbf3e6;color:#9a6b14;border:1px solid #f1e3c8}
.chip.dop-ok{background:#eef4f0;color:#4a7358;border:1px solid #dde9e1}
.chip.dop-warn{background:#fdeae6;color:#b5451d;border:1px solid #f6d5c9;font-weight:700}
.chip.layer-1{background:#fdeaea;color:#c0392b;border:1px solid #f6d3d0}
.chip.layer-2{background:#fdf1e6;color:#b5651d;border:1px solid #f4dcc4}
.chip.layer-3{background:#fbeef2;color:#a83a6b;border:1px solid #f1d6e0}
.chip.layer-4{background:#f3eefa;color:#6b46a8;border:1px solid #e4d9f2}
.chip.layer-5{background:#fdeaea;color:#c0392b;border:1px solid #f6d3d0}
.chip.layer-6{background:#fdf1e6;color:#b5651d;border:1px solid #f4dcc4}
.dec-pill{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:700;padding:2px 7px;border-radius:999px;cursor:help;font-variant-numeric:tabular-nums}
.dec-pill.dec-ok{background:#eef4f0;color:#4a7358;border:1px solid #dde9e1}
.dec-pill.dec-warn{background:#fdf1e6;color:#b5651d;border:1px solid #f4dcc4}
.dec-pill.dec-dying{background:#fdeaea;color:#c0392b;border:1px solid #f6d3d0}
.tm-mt.is-loading{opacity:.4;transition:opacity .15s}
.chip.layer-0{background:#f0eeea;color:#7a756c;border:1px solid #e4e0d8}
.muted{color:var(--at-mut)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--at-mut)}

/* --- F2: hint na hlavičce sloupce („ⓘ") + vlastní pop-up ------------------------------
   „.th-tip" dřív NEMĚLA ANI ŘÁDEK CSS → „ⓘ" bylo holé kurzívové písmenko, na kterém nebyl
   ani kurzor. Teď: decentní marker, který zesílí na hoveru, + okamžitý čitelný pop-up. */
.th-tip{display:inline-flex;align-items:baseline;gap:3px;cursor:help;white-space:normal}
.th-tip .th-i{font-style:normal;font-size:10px;line-height:1;color:#c2bcae;transition:color .12s;flex:0 0 auto}
.th-tip:hover .th-i{color:#a86a78}
.ads-hint-pop{position:fixed;z-index:10001;display:none;max-width:340px;
  padding:9px 11px;background:#2c2b28;color:#f6f4ef;border-radius:9px;
  box-shadow:0 8px 26px rgba(30,25,15,.28);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:12px;font-weight:450;line-height:1.5;letter-spacing:0;text-transform:none;
  opacity:0;transform:translateY(3px);transition:opacity .1s,transform .1s;pointer-events:none;white-space:normal}
.ads-hint-pop.show{opacity:1;transform:translateY(0)}

/* --- N7: bohatá varianta pop-upu (sloupec „Důvod") ------------------------------------
   Filip: „ne zas overkill, pár řádků" → nadpis · vrstva · serverový text s čísly ·
   jedna věta proč. Nic víc. */
.ads-hint-pop.rich{max-width:400px;padding:11px 13px;display:flex;flex-direction:column;gap:5px}
.ads-hint-pop.rich .rp-h{font-size:13px;font-weight:750;letter-spacing:-.01em}
.ads-hint-pop.rich .rp-l{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#b3aca0}
.ads-hint-pop.rich .rp-d{margin-top:3px;padding:6px 8px;background:rgba(255,255,255,.08);border-radius:6px;
  font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;color:#fff}
.ads-hint-pop.rich .rp-w{font-size:11.5px;line-height:1.5;color:#ddd8cd}
.ads-hint-pop.rich .rp-m{font-size:11px;line-height:1.5;color:#c6bfb2}
.ads-hint-pop.rich .rp-m i{color:#a09a8e}
.ads-hint-pop.rich .rp-c{margin-top:2px;font-size:10.5px;color:#a09a8e}
.kill-pill{cursor:help}

/* --- S1: OČIČKO V HLAVIČCE -----------------------------------------------------------
   Za normálu je jen naznačené (opacity .28) — hlavička nesmí vypadat jako rozsypaný čaj.
   Na hoveru hlavičky zesílí, na hoveru sebe sama zčervená. Klik NEŘADÍ (handler má
   capture + stopPropagation, viz wireEyes). */
.th-wrap{display:inline-flex;align-items:center;gap:5px;width:100%;min-width:0}
.th-plain{min-width:0;overflow:hidden;text-overflow:ellipsis}
.th-eye{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:19px;height:19px;padding:0;margin:0 0 0 auto;border:0;border-radius:5px;background:transparent;
  color:#b3aca0;cursor:pointer;opacity:.28;-webkit-appearance:none;appearance:none;
  transition:opacity .12s,color .12s,background .12s}
.th-eye svg{width:13px;height:13px;display:block}
.tabulator-col:hover .th-eye{opacity:.85}
.th-eye:hover{opacity:1;color:#c0392b;background:rgba(192,57,43,.1)}
.th-eye:focus-visible{outline:none;opacity:1;box-shadow:0 0 0 2px rgba(168,106,120,.4)}

/* --- Režim view: dlaždice / bez stránkování ------------------------------------------
   „no-pag" = view s vypnutým stránkováním (Na kill). Tabulator umí setPageSize(true)
   = všechno na jedné stránce, ale footer by pak ukazoval osamocené „‹ 1 ›" — schováme ho,
   ať to vypadá přesně jako dřív BEZ stránkování.
   „is-tiles" = režim dlaždic → tabulka a její ovládání jsou pryč, dlaždice si vlastní
   pásma i řazení řeší samy (newest.js). */
.ads-sec.no-pag .tabulator .tabulator-footer{display:none}
.ads-sec.is-tiles .ads-tbl{display:none}
.ads-tiles-host[hidden],.ads-tiles-own[hidden]{display:none}

/* Prázdné view — výsledek, ne chyba (náušnice běžně startují na „Na kill 0"). */
.ads-sec.is-empty .ads-tbl{display:none}
/* ★ F8/C — lištu při prázdném view UŽ NESCHOVÁVÁME (dřív tu bylo
   „.ads-sec.is-empty .ads-hidden{display:none}"). Je v ní přepínač „Jen aktivní" a když
   právě on tabulku vyprázdní, musí zůstat na obrazovce, jinak se nedá vypnout. */
.ads-empty{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;
  padding:34px 22px;background:var(--at-cream);border:1px dashed var(--at-ln);border-radius:var(--at-radius)}
.ads-empty[hidden]{display:none}
.ads-empty .ae-i{font-size:23px;line-height:1.1;margin-bottom:2px}
.ads-empty b{font-size:14px;font-weight:700;color:var(--at-tx)}
.ads-empty span:not(.ae-i){max-width:520px;font-size:12.5px;line-height:1.55;color:var(--at-mut)}

/* --- A3: ZRALOST — barevný kroužek + procento -----------------------------------------
   Kroužek = conic-gradient donut (maska vykrojí střed). Filip tabulku skenuje očima,
   ne čte procenta řádek po řádku → barva a výplň musí být čitelná na první pohled.
   Pásma: < 25 % červená · 25–50 % oranžová · 50–75 % žlutá · > 75 % zelená. */
.zr{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.zr-ring{flex:0 0 auto;width:16px;height:16px;border-radius:50%;
  background:conic-gradient(currentColor calc(var(--zp,0) * 1%), var(--zr-track,#eceae3) 0);
  -webkit-mask:radial-gradient(farthest-side,transparent 56%,#000 58%);
          mask:radial-gradient(farthest-side,transparent 56%,#000 58%)}
.zr-v{font-size:12px;font-weight:700}
.zr-red{color:#c0392b}
.zr-orange{color:#b56a1d}
.zr-yellow{color:#a98c15}
.zr-green{color:#177a3a}
.zr-none{color:var(--at-mut)}
.zr-red .zr-v{color:#c0392b}
.zr-orange .zr-v{color:#b56a1d}
.zr-yellow .zr-v{color:#8a7212}
.zr-green .zr-v{color:#177a3a}

/* --- D2: počet rezervací v závorce u CPA („4 004 Kč (2)") --- */
.c-cpa .cnt{margin-left:4px;font-size:11px;font-weight:600;color:var(--at-mut);cursor:help}

/* --- semafor buňka --- */
.c-sem{font-weight:700;font-variant-numeric:tabular-nums}
.c-sem .sem-val{display:inline-block}
.tabulator-cell.sem-green{background:#e6f6ec;color:#177a3a}
.tabulator-cell.sem-lgreen{background:#eef7e3;color:#4c7a17}
.tabulator-cell.sem-yellow{background:#fdf6e0;color:#957c15}
.tabulator-cell.sem-orange{background:#fdeede;color:#b56a1d}
.tabulator-cell.sem-red{background:#fdeae7;color:#c0392b}
.tabulator-cell.sem-none{color:var(--at-mut)}

/* --- trend --- */
.trend{font-size:13px;font-weight:700;line-height:1}
.trend.t-up{color:#c0392b}
.trend.t-down{color:#177a3a}
.trend.t-flat{color:#a8a49a}

/* --- % spendu bar --- */
.bar{position:relative;width:100%;height:16px;background:var(--at-cream2);border-radius:6px;overflow:hidden}
.bar-fill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#c9a9b0,#a86a78);border-radius:6px}
.bar-lbl{position:absolute;right:6px;top:0;line-height:16px;font-size:10.5px;font-weight:700;color:#5a5550}

/* --- created --- */
.cdate{font-size:12px;color:var(--at-tx);font-variant-numeric:tabular-nums}

/* --- chevron / expand (C1: „šipky jsou šeredné") ---
   Dřív: „.chev-btn" neměla ŽÁDNÉ pravidlo → defaultní systémové tlačítko se šedým rámečkem
   a glyfem „▸", který každý font kreslí jinak. Teď: SVG (ostré v každém zoomu) v ploše
   30×30 s hover/active/focus stavem a plynulou rotací. */
.c-exp{cursor:pointer}
/* Buňka se šipkou má užší padding, aby se do 40px sloupce vešla celá 30px plocha tlačítka
   (s default paddingem 10px zbylo jen 20px a flex tlačítko zmáčkl na 20×30 — ověřeno měřením). */
.ads-sec .tabulator .tabulator-row .tabulator-cell.c-exp{padding-left:5px;padding-right:5px}
.chev-btn{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:30px;height:30px;padding:0;margin:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--at-mut);cursor:pointer;font-family:inherit;-webkit-appearance:none;appearance:none;transition:background .13s,color .13s,border-color .13s,transform .08s}
.chev-btn:hover{background:var(--at-cream2);border-color:var(--at-ln);color:var(--at-tx)}
.chev-btn:active{transform:scale(.93)}
.chev-btn:focus-visible{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.16);color:var(--at-tx)}
.chev-btn.open{background:var(--at-cream2);border-color:var(--at-ln);color:var(--at-tx)}
.chev-btn .chev{display:block;width:15px;height:15px;transition:transform .18s cubic-bezier(.4,0,.2,1);transform:rotate(0deg)}
.chev-btn.open .chev{transform:rotate(90deg)}

/* --- kill button --- */
.btn-kill{background:#fff;color:#c0392b;border:1px solid #edc9c4;border-radius:8px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;transition:background .12s,border-color .12s;font-family:inherit}
.btn-kill:hover{background:#fdeae7;border-color:#e0a9a2}
.btn-kill.sm{padding:3px 9px;font-size:11px}
.btn-kill.loading{cursor:progress;min-width:34px}
.btn-kill:disabled{opacity:.75}
.tag-off{display:inline-block;font-size:11px;font-weight:700;color:#8d897f;background:var(--at-cream2);border:1px solid var(--at-ln);border-radius:999px;padding:3px 10px}

/* --- status chip (sub) --- */
.st{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.st-on{background:#e6f6ec;color:#177a3a}
.st-off{background:#f0eeea;color:#8d897f}
.st-mid{background:#fbf3e6;color:#9a6b14}
.am-link{color:#3f6fa0;font-size:12px;font-weight:600;text-decoration:none}
.am-link:hover{text-decoration:underline}

/* --- rozklik (C2) ---
   ⚠️ „.ads-subwrap" má NULOVÝ horizontální padding SCHVÁLNĚ: „.sub-align" v něm kopíruje
   mřížku parent tabulky (šířky bere z column.getWidth()) a jakýkoli padding by čísla
   posunul mimo jejich hlavičku. Odsazení nese až „.sub-body". */
.ads-subwrap{display:block;width:100%;box-sizing:border-box;padding:0 0 4px;background:var(--at-cream);border-top:1px solid var(--at-ln)}
.ads-subwrap .sub-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px 8px 44px}
.ads-subwrap .sub-head-l{display:flex;align-items:center;gap:9px;min-width:0}
.ads-subwrap .sub-h-code{font-size:12.5px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}

/* Pruh metrik za celou kreativu — LÍCUJE se sloupci parenta (šířky se nastavují inline z JS). */
.sub-align{display:flex;align-items:stretch;width:100%;box-sizing:border-box;background:#fff;border-top:1px solid var(--at-ln);border-bottom:1px solid var(--at-ln)}
.sub-align .sas-c{flex:0 0 auto;box-sizing:border-box;padding:9px 10px;display:flex;align-items:center;min-width:0;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub-align .sas-c.r{justify-content:flex-end}
.sub-align .sas-v{font-weight:700;color:var(--at-tx);font-variant-numeric:tabular-nums}
.sub-align .sas-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--at-mut)}

.ads-subwrap .sub-body{padding:10px 14px 10px 44px}
.ads-subwrap .sub-note{font-size:11.5px;line-height:1.5;color:var(--at-mut);margin:0 0 8px}
.ads-subwrap .sub-note b{color:var(--at-tx);font-weight:600}
/* Fallback, když mřížku parenta nejde přečíst — kachlíky aspoň v ŘÁDKU, ne pod sebou. */
.ads-subwrap .sub-mt{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;padding:10px 14px}
.ads-subwrap .sub-mt .mt{background:#fff;border:1px solid var(--at-ln);border-radius:9px;padding:7px 9px;display:flex;flex-direction:column;gap:2px;min-width:0}
.ads-subwrap .sub-mt .mt span{font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:var(--at-mut);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ads-subwrap .sub-mt .mt b{font-size:13px;font-variant-numeric:tabular-nums}
.ads-subwrap .sub-zero-tog{margin-top:8px}

/* --- sub-tabulka --- */
.ads-subwrap .tabulator{box-shadow:none;border:1px solid var(--at-ln);border-radius:10px;font-size:12px}
.ads-subwrap .tabulator .tabulator-header{background:#fbf9f5}
.ads-subwrap .tabulator .tabulator-row .tabulator-cell{min-height:42px}

/* --- confirm modal --- */
.ads-modal-ov{position:fixed;inset:0;z-index:10000;background:rgba(40,34,24,.34);display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;overscroll-behavior:contain;animation:ads-fade .12s ease}
@keyframes ads-fade{from{opacity:0}to{opacity:1}}
/* max-height + vlastní scroll: vysoký modal (graf trendu) se drží ve viewportu a scrolluje uvnitř, ne pozadí */
.ads-modal{width:100%;max-width:440px;max-height:calc(100vh - 40px);overflow-y:auto;overscroll-behavior:contain;background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(30,25,15,.28);padding:22px 22px 18px;font-family:inherit;color:#2c2b28;animation:ads-pop .14s ease}
@keyframes ads-pop{from{transform:scale(.97);opacity:.6}to{transform:scale(1);opacity:1}}
.ads-modal .am-title{font-size:16px;font-weight:700;letter-spacing:-.01em}
.ads-modal .am-sub{margin-top:4px;font-size:12.5px;color:#8d897f}
.ads-modal .am-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}
.ads-modal .am-metrics .mt{background:#faf8f4;border:1px solid #eceae3;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.ads-modal .am-metrics .mt span{font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;color:#8d897f;font-weight:600}
.ads-modal .am-metrics .mt b{font-size:14px;font-variant-numeric:tabular-nums}
.ads-modal .am-reason{display:block;font-size:12px;font-weight:600;color:#6b675f;margin-top:4px}
.ads-modal .am-reason .am-opt{font-weight:400;color:#a8a49a}
.ads-modal .am-reason textarea{display:block;width:100%;box-sizing:border-box;margin-top:5px;border:1px solid #e6e3db;border-radius:9px;padding:8px 10px;font-family:inherit;font-size:13px;resize:vertical;color:#2c2b28}
.ads-modal .am-reason textarea:focus{outline:none;border-color:#c9a9b0;box-shadow:0 0 0 3px rgba(168,106,120,.14)}
.ads-modal .am-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
.btn-ghost{background:#fff;color:#6b675f;border:1px solid #e6e3db;border-radius:9px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.btn-ghost:hover{background:#faf8f4}
.btn-ghost.sm{padding:4px 10px;font-size:12px}
.btn-danger{background:#c0392b;color:#fff;border:1px solid #b23227;border-radius:9px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.btn-danger:hover{background:#a83224}

/* --- M1: modal grafu trendu (#8) --- */
.ads-trend-modal{max-width:860px;padding:18px 20px 16px}
.tm-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.tm-head-l{min-width:0;flex:1}
.tm-title{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:700;letter-spacing:-.01em;flex-wrap:wrap}
.tm-code{font-variant-numeric:tabular-nums}
.tm-sub{margin-top:3px;font-size:12.5px;color:#8d897f}
.tm-x{width:32px;height:32px;flex:0 0 auto;border-radius:9px;border:1px solid #e6e3db;background:#fff;color:#8d897f;font-size:19px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:inherit}
.tm-x:hover{background:#faf8f4;color:#2c2b28}
/* Dozrávání: záměrně VÝRAZNÉ a nad grafem — je to jediná pojistka proti tomu,
   aby se klesající pravý konec křivky četl jako propad výkonu (nález #4). */
.tm-warn{display:flex;gap:9px;align-items:flex-start;background:#fdf4e7;border:1px solid #f2ddb9;border-left:3px solid #d9a441;border-radius:0 10px 10px 0;padding:9px 12px;margin-bottom:12px;font-size:12px;line-height:1.5;color:#6b5a35}
.tm-warn b{color:#8a5a12}
.tm-warn-i{flex:0 0 auto;font-size:13px;line-height:1.35}
.tm-chart{min-height:300px;border:1px solid #eceae3;border-radius:12px;background:#fffdf9;overflow:hidden}
.tm-chart .acx-mini,.tm-chart .acx-mini-canvas{min-height:296px}
.tm-err{padding:26px 16px;text-align:center;font-size:13px;color:#c0392b;font-weight:600}
.tm-mt{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:13px}
.tm-mt .mt{background:#faf8f4;border:1px solid #eceae3;border-radius:10px;padding:7px 9px;display:flex;flex-direction:column;gap:2px;min-width:0}
.tm-mt .mt span{font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#8d897f;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-mt .mt b{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* K1 — hlavička skupiny metrik přes celou šířku mřížky (💰 Peníze / 🔻 Trychtýř / …). */
.tm-mt .mt-g,.ads-subwrap .sub-mt .mt-g{grid-column:1/-1;font-size:11px;font-weight:700;letter-spacing:.02em;
  color:var(--at-mut,#8d897f);margin:6px 0 -2px;padding-top:6px;border-top:1px solid var(--at-ln,#eceae3)}
.tm-mt .mt-g:first-child,.ads-subwrap .sub-mt .mt-g:first-child{margin-top:0;padding-top:0;border-top:0}
.tm-note{margin-top:9px;font-size:11.5px;color:#8d897f}

/* --- F7/C3: rozpad kreativy podle optimalizací (eventů) ------------------------------
   Chipy = filtr (graf + dlaždice), tabulka = srovnání všech naráz. Dvě vrstvy schválně:
   „která je lepší" se čte z tabulky, „jak se vyvíjí" z grafu po kliknutí na chip.
   Proužek za názvem v tabulce nese PODÍL NA SPENDU — jinak se u šesti optimalizací
   ztratí, že jedna žere 74 % a zbytek jsou drobky. */
.tm-opt{margin:8px 0 10px;padding:9px 11px;background:#fbf8f3;border:1px solid #ece7dc;border-radius:10px}
.tm-opt[hidden]{display:none}
.tmo-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:7px}
.tmo-head b{font-size:12px;color:#3a352c}
.tmo-hint{font-size:10.5px;color:#8d897f;flex:1;min-width:180px}
.tmo-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.tmo-c{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 9px;background:#fff;
  color:#6b6459;border:1px solid #e6dfd2;border-radius:999px;font-family:inherit;font-size:11px;
  font-weight:600;line-height:1;cursor:pointer;max-width:230px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;transition:background .12s,border-color .12s,color .12s}
.tmo-c:hover{border-color:#c9a9b0;color:#3a352c}
.tmo-c.is-on{background:#4b58c9;border-color:#4b58c9;color:#fff}
.tmo-c i{font-style:normal;font-size:10px;font-weight:800;opacity:.72}
.tmo-tbl{width:100%;border-collapse:collapse;font-size:11px}
.tmo-tbl th{text-align:right;font-weight:700;font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;
  color:#8d897f;padding:3px 6px;border-bottom:1px solid #ece7dc;white-space:nowrap}
.tmo-tbl th:first-child{text-align:left}
.tmo-tbl td{text-align:right;padding:4px 6px;font-variant-numeric:tabular-nums;color:#3a352c;
  border-bottom:1px solid #f2ede4;white-space:nowrap}
.tmo-tbl tbody tr{cursor:pointer}
.tmo-tbl tbody tr:hover td{background:#f5f1e9}
.tmo-tbl tbody tr.is-on td{background:#eceefb}
.tmo-n{position:relative;text-align:left !important;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.tmo-bar{position:absolute;left:0;bottom:1px;height:2px;width:var(--w,0%);background:#4b58c9;opacity:.45;
  border-radius:2px}
.tmo-rm{font-weight:700}
.tm-evlbl{color:#4b58c9;font-weight:700}
@media(max-width:720px){.tm-mt{grid-template-columns:repeat(2,1fr)}}
`;
    var style = document.createElement('style');
    style.id = 'ads-tables-css';
    style.textContent = css;
    document.head.appendChild(style);
  }
}
