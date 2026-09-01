/* =============================================================================
 * NK Ads Dashboard — Frontend WIZARD „Denní HECK"
 * Soubor: public/wizard.js   (mount → #wizard-root, fullscreen overlay)
 *
 * Konzumuje POUZE sdílený kontrakt window.ADS (definuje shell/app.js):
 *   ADS.state {from,to,tab,user,preset} · ADS.TH · ADS.FUNNELS · ADS.BQ_RANGE
 *   ADS.api(action,params,opts) · ADS.fmt · ADS.semafor(roas) · ADS.openPreview(ad)
 *   ADS.toast(msg,type) · ADS.el(sel) · ADS.bus:EventTarget · ADS.onReady(cb)
 *
 * Spuštění (blbuvzdorné, 3 nezávislé cesty — banner agent si vybere):
 *   1) window.ADSWizard.open()               ← doporučené (globální handle)
 *   2) ADS.bus.dispatchEvent(new Event('wizardopen'))
 *   3) klik na cokoli s [data-open-wizard]   (event delegation)
 *
 * Zavření:
 *   • po uložení (krok 6) → ADS.bus.dispatch('wizardclose')  → banner zmizí
 *   • přerušení křížkem → NEdispatchuje 'wizardclose' (banner zůstane, nedokončeno)
 *
 * Kroky (SPEC §5, dle aktuálního tabu):
 *   1 Kill kandidáti (vrstvy 1–4)  · 2 Funnely* · 3 Eventy/optimalizace*
 *   4 Scale check · 5 Nejnovější reklamy · 6 Souhrn → wizard_save
 *   (* jen tab „rings"; náušnice funnely/eventy nemají → kroky se vynechají)
 *
 * Kód je striktně samostatný: vlastní scoped styly (prefix .hw-), žádná závislost
 * na sdíleném styles.css ani na interních funkcích jiných agentů.
 *
 * --- FEEDBACK-3 (16. 7.) -------------------------------------------------------
 *   A4  ZRALOST = pct_call × pct_schuzek u každého ROAS (barevný kroužek:
 *       < 25 % č · 25–50 % o · 50–75 % ž · > 75 % z). NENÍ to časová zralost —
 *       tu Filip jako ukazatel nechce (A2). Detail u zralostOf().
 *   H2  Náhled i ve wizardu: hover = velký pop-up, klik = modal (ADS.openPreview).
 *   H3  Období EXPLICITNĚ u každého kroku (periodBarHTML) — „kill kandidáti za měsíc".
 *   H4  U každého funnelu denní graf 90 dní + chipy 14/30/60, které přepočítají čísla.
 *   H5  Totéž u eventů + filtr podle funnelu (chipy).
 *   H6  Scale check: mini grafy po týdnech (CPL · tržby · CPA), týdny česky (A5).
 *   H7  Karta scale kroku říká NAHLAS, že dashboard rozpočty nemění (škálování = Ads Manager).
 * ⚠️ Okno 14/30/60 ani filtr funnelu NEMĚNÍ, o čem se rozhoduje — jen co je vidět.
 *    Karty a gating se vždy staví z období běhu. Viz W.view a feView().
 *
 * --- FEEDBACK-5 (16. 7. večer) -------------------------------------------------
 *   N7  Důvod na pillu KRÁTCE, detail ze závorky → popup na hover. Viz splitReason().
 *   G2  „Nová kreativa" = kód POPRVÉ vyjel v posledních NEW_ADS_DAYS dnech (age_days),
 *       ne „má čerstvě nahranou reklamu" (is_new ze serveru). 15 z 51 karet jinak
 *       renderovalo „nová (posledních 10 dnech) · stáří 260 d". Re-uploady = vlastní
 *       skupina s vysvětlením. Shodné s newest.js. ⚠️ Správné místo je api.php → report.
 *   §5  Krok „Nejnovější" potvrzuje PŘEHLED (tlačítko „Potvrdit zbývající"), ne 51 klik.
 *       Gate to neoslabuje: flag s povinným důvodem zůstává u každé karty.
 * ========================================================================== */
(function () {
  'use strict';

  // Jednorázová inicializace (kdyby se skript načetl vícekrát)
  if (window.__ADS_WIZARD_LOADED__) return;
  window.__ADS_WIZARD_LOADED__ = true;

  /* ---------------------------------------------------------------------------
   * Drobné utility
   * ------------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Bezpečné číslo (BQ/Meta občas vrací stringy)
  const num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  // Escapování textu do HTML (obsah dat je STRING, nikdy důvěryhodné)
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Fallback-safe formátování přes ADS.fmt (kdyby některá funkce chyběla)
  const F = {
    money: (n) => (ADS.fmt && ADS.fmt.money ? ADS.fmt.money(num(n)) : Math.round(num(n)) + ' Kč'),
    int: (n) => (ADS.fmt && ADS.fmt.int ? ADS.fmt.int(num(n)) : String(Math.round(num(n)))),
    roas: (n) => (ADS.fmt && ADS.fmt.roas ? ADS.fmt.roas(num(n)) : num(n).toFixed(2)),
    pct: (n01) => (ADS.fmt && ADS.fmt.pct ? ADS.fmt.pct(num(n01)) : Math.round(num(n01) * 100) + ' %'),
    date: (s) => (ADS.fmt && ADS.fmt.date ? ADS.fmt.date(s) : String(s || '')),
  };

  const toast = (m, t) => {
    try { ADS.toast && ADS.toast(m, t); } catch (_) {}
  };

  // effective_status z Meta → je reklama vypnutá? (PAUSED / ADSET_PAUSED / CAMPAIGN_PAUSED)
  /* ⚠️ Vypnutá reklama se pozná i podle KONFIGURAČNÍHO `status`, ne jen `effective_status`.
   * Filip 15. 8. 2026: při zapnuté bezpečnostní ochraně účtu vrací Meta u vypnuté reklamy
   * `status=PAUSED` + `effective_status=WITH_ISSUES` (naměřeno 12 reklam). Starý test
   * jen na effective → kill vyhodnocen jako selhání → „Zkus znovu" → P-287-001 killnutá
   * 10× po ~33 s. Každý pokus je pro Metu další podezřelá změna a ochranu to utvrzuje. */
  const isPaused = (eff, conf) =>
    (!!conf && /PAUS/i.test(String(conf))) || (!!eff && /PAUS/i.test(String(eff)));
  // „nedoručuje se" = vypnuté i na úrovni ad setu/kampaně, nebo drží review
  const notDelivering = (eff) => !!eff && /PAUS|WITH_ISSUES|PENDING|DISAPPROVED/i.test(String(eff));

  // Preferovaný náhledový „ad" objekt pro ADS.openPreview()
  const previewAd = (c) => c.sample_ad || (c.ads && c.ads[0]) || null;
  // H2: MALÝ náhled do karty (240px cache) · VELKÝ do hoveru i modalu (900px cache).
  // Stejný fallback řetěz jako tables.js — thumbnail_big → image_url → malý thumbnail.
  const thumbOf = (ad) => (ad && (ad.thumbnail || ad.thumbnail_url || ad.image_url)) || '';
  const thumbBigOf = (ad) => (ad && (ad.thumbnail_big || ad.image_url || ad.thumbnail || ad.thumbnail_url)) || '';
  // ADS.openPreview() staví médium z `image_url` → podstrčíme mu VELKOU variantu a doplníme
  // kreativu/funnel z řádku (ads_meta je na adu nenese). Bez sahání do app.js — jako tables.js.
  function previewAdBig(c) {
    const a = previewAd(c);
    if (!a) return null;
    const o = {};
    for (const k in a) o[k] = a[k];
    const big = thumbBigOf(a);
    if (big) o.image_url = big;
    if (!o.creative && c.creative) o.creative = c.creative;
    if (!o.funnel && c.funnel) o.funnel = c.funnel;
    return o;
  }

  // Semafor barva (rozhodovací ROAS) → CSS třída
  const semClass = (roas) => {
    let key = 'yellow';
    try { key = (ADS.semafor && ADS.semafor(num(roas))) || 'yellow'; } catch (_) {}
    return 'hw-sem-' + key;
  };

  /* --- DATUMY (A5: česky, ne „7-6") ---------------------------------------- */
  const iso = (d) => d.toISOString().slice(0, 10);
  const parseISO = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
  const shiftDays = (s, n) => iso(new Date(parseISO(s).getTime() + n * 86400000));
  const daysBetween = (from, to) => Math.round((parseISO(to) - parseISO(from)) / 86400000) + 1;
  // krátké české datum „6. 7." (do os grafů — rok by je zahltil)
  const czShort = (s) => { const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? (+p[2]) + '. ' + (+p[1]) + '.' : String(s); };
  // A5: týden česky — „Týden od 6. 7.", NIKDY „7-6"
  const czWeek = (s) => 'Týden od ' + czShort(s);
  // W1: měsíc česky — „červenec 2026". Server u měsíční granularity `label` posílá
  // (bereme přednostně jeho), tohle je fallback, aby na ose nikdy nevisel ISO řetězec.
  const CZ_MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
                     'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  const czMonth = (s) => {
    const p = String(s).slice(0, 10).split('-');
    if (p.length < 2) return String(s);
    const m = CZ_MONTHS[(+p[1]) - 1];
    return m ? m + ' ' + p[0] : String(s);
  };
  const czMonthShort = (s) => {
    const p = String(s).slice(0, 10).split('-');
    return p.length >= 2 ? (+p[1]) + '/' + String(p[0]).slice(2) : String(s);
  };
  const plural = (n, one, few, many) => {
    n = Math.abs(Math.round(num(n)));
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  };
  const dayWord = (n) => plural(n, 'den', 'dny', 'dní');

  /* ---------------------------------------------------------------------------
   * A4 — ZRALOST = pct_call × pct_schuzek
   *
   * ⚠️ TOHLE NENÍ časová zralost (stáří dat / MATURITY_CURVE / „14 dní"). Ta je jiná
   * veličina a Filip ji jako ukazatel NECHCE (FEEDBACK-3 A2) → ve wizardu ji nekreslíme.
   *
   * Filipova definice: „mám 100 leadů, provolala se půlka, udělalo se 10 schůzek a z nich
   * proběhla půlka → čtvrtina tržby PROBĚHLA." = kolik % tržby je REÁLNÉ vs. dopočtené.
   * Je to přesně jmenovatel Lookerova dopočtu: trzba_celkem = tržba / pct_schuzek / pct_call
   * → zralost = pct_call × pct_schuzek = převrácená hodnota dopočtu.
   *
   * Dopočet zralost UŽ ŘEŠÍ ve výpočtu (revenue_model) → tohle je čistě INDIKÁTOR DŮVĚRY:
   * „je rozdíl, když je ROAS dopočtený z 25 % nebo z 90 %."
   *
   * Zdroj: api.php present_row posílá `pct_call` a `pct_schuzek` (0..1, null = chybí jmenovatel).
   *   • prsteny  → pct_call × pct_schuzek
   *   • náušnice → schůzky NEEXISTUJÍ (pct_schuzek je vždy null a revenue_model = celkem/call_rate)
   *                → zralost = pct_call samotné. Jinak by byla vždy „—".
   * Fallback: když server pošle jen syrové čitatele/jmenovatele (called/leads, passed/bookings)
   * — např. na řádcích funnelů z ?action=overview — dopočítáme si je sami.
   *
   * ⚠️ ZÁMĚRNĚ NEpoužíváme revenue_real/revenue_model jako náhradu: ověřeno naostro 16. 7.
   * na 14 winnerech, že se ta dvě čísla ROZCHÁZEJÍ (L-116-001: pct_call×pct_schuzek = 0,24
   * vs. rr/rm = 2,31 → přes 100 %, nesmysl jako „% reálné"). Důvod: dopočet se počítá na
   * DENNÍM řádku, takže rr/rm je tržbou vážená směs denních sazeb, ne Filipova okenní definice.
   * ------------------------------------------------------------------------ */
  function pctCallOf(o) {
    let v = o.pct_call;
    if (v != null) return clamp01(num(v));
    const l = num(o.leads);
    if (l > 0 && o.called != null) return clamp01(num(o.called) / l);
    return null;
  }
  /* F7/B — DISPLEJ: 0 rezervací → api.php posílá dosazenou 1.0 (ať zralost nespadne na „—"),
   * ale vypsat „100 % schůzek" u kreativy bez jediné rezervace je lež → vracíme null.
   * Zralost si 1.0 dosadí sama v zralostOf() níž. */
  function pctSchuzekOf(o) {
    if (o && o.schuzek_empty) return null;
    let v = o.pct_schuzek;
    if (v != null) return clamp01(num(v));
    const b = num(o.bookings);
    if (b > 0 && o.passed != null) return clamp01(num(o.passed) / b);
    return null;
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /** → {v, call, sch} kde v = zralost 0..1, nebo null když se nedá spočítat. */
  function zralostOf(o) {
    if (!o) return null;
    const call = pctCallOf(o);
    if (call == null) return null;
    if (isEar()) return { v: call, call, sch: null };   // náušnice schůzky nemají
    /* F7/B (Filip 23. 7., L-173-001): ŽÁDNÁ rezervace ≠ „nevím". Nic nevzniklo → není na co
     * čekat → komponenta schůzek = 1 a zralost = jen % hovorů. `sch: null` schválně:
     * karta pak napíše „0 rezervací", ne vymyšlených „100 % schůzek". */
    if (o.schuzek_empty || num(o.bookings) === 0) {
      return { v: clamp01(call), call, sch: null, schEmpty: true };
    }
    const sch = pctSchuzekOf(o);
    if (sch == null) return null;                       // rezervace jsou, výsledek neznáme
    return { v: clamp01(call * sch), call, sch };
  }
  /* Prahy PŘESNĚ dle Filipa: < 25 % červená · 25–50 % oranžová · 50–75 % žlutá · > 75 % zelená.
   * ⚠️ Rozhoduje ZAOKROUHLENÉ procento, tedy to, které Filip na kartě vidí. Ze syrové hodnoty
   * by 0,2478 vykreslilo „25 %" s ČERVENÝM kroužkem — a proti napsanému pravidlu „25–50 =
   * oranžová" by to vypadalo jako bug. Co je vidět, to platí. */
  function zralostKey(pct) {
    if (pct < 25) return 'red';
    if (pct < 50) return 'orange';
    if (pct <= 75) return 'yellow';
    return 'green';
  }
  function zralostTitle(z, why) {
    if (!z) {
      // ⚠️ Důvod MUSÍ sedět. Ověřeno naostro 16. 7.: u eventů pod filtrem funnelu (H5) se
      // zralost spočítat NEDÁ — čísla se skládají z ?action=timeseries, které umí jen
      // spend/leads/bookings/cpa (ne called/passed), a ?action=overview funnel filtr ignoruje.
      // Bez tohohle rozlišení by tam visel hlášky „chybí leady nebo rezervace", což je
      // u funnelu s 86 416 Kč a 511 leady prokazatelná lež.
      if (why === 'filter') {
        return 'Zralost za jeden konkrétní funnel se spočítat nedá — server u eventů uvnitř funnelu ' +
          'neposílá provolanost (jen spend, leady, rezervace a CPA). Přepni filtr na „Vše" a uvidíš ji.';
      }
      return isEar()
        ? 'Zralost nejde spočítat — kreativa zatím nemá ani jednu poptávku, není z čeho počítat podíl provolaných.'
        : 'Zralost nejde spočítat — chybí leady nebo rezervace (bez schůzek není co dopočítávat).';
    }
    const p = (x) => Math.round(x * 100) + ' %';
    const base = 'ZRALOST ' + p(z.v) + ' = tolik tržby je REÁLNÉ, zbytek je dopočet.\n';
    const calc = isEar()
      ? 'Provoláno ' + p(z.call) + ' poptávek. (Náušnice nemají schůzky → dopočet dělí jen provolanost.)'
      : 'Provoláno ' + p(z.call) + ' leadů × proběhlo ' + p(z.sch) + ' schůzek = ' + p(z.v) + '.';
    return base + calc + '\nDopočet ji ve výpočtu už zohledňuje — tohle je míra DŮVĚRY: ' +
      'je rozdíl, když je ROAS dopočtený z 25 % nebo z 90 %.';
  }
  /** Zralost jako metrika do řádku .hw-metrics (barevný kroužek + %).
   *  @param {string} [why] - kontext, proč případně chybí ('filter' = H5 filtr funnelu). */
  function zralostMetric(o, why) {
    const z = zralostOf(o);
    const t = esc(zralostTitle(z, why));
    if (!z) {
      return '<span class="hw-metric hw-zr" title="' + t + '"><span>Zralost</span>' +
        '<b><span class="hw-ring is-none" style="--p:0"></span>—</b></span>';
    }
    const pct = Math.round(z.v * 100);
    return '<span class="hw-metric hw-zr" title="' + t + '"><span>Zralost</span>' +
      '<b><span class="hw-ring is-' + zralostKey(pct) + '" style="--p:' + pct + '"></span>' + pct + ' %</b></span>';
  }

  /* --- TAB-GATING KARET (NÁLEZ #15 + #27) ----------------------------------
   * Hlavní tabulky (tables.js) tohle mají správně přes `d._tab === 'earrings'`,
   * wizard NE — a přitom je to nástroj, kterým se denně killuje. Držíme stejný kontrakt:
   *   K1  náušnice NEMAJÍ CPL — Filipa nezajímá a api.php ho u nich ani neposílá
   *       (present_row: `unset($out['cpl'])`) → karta kreslila trvale „CPL —".
   *   D3  CPS je staré jméno → všude ukazujeme CPA. Server posílá `cpa`,
   *       `cps` drží jen jako zpětně kompatibilní ALIAS (SPEC §1 „ukládáme jako bookings_eff").
   *       Prsteny = cena za schůzku se zohledněním provolanosti · náušnice = cena za rezervaci.
   *   §5  ROZHODOVACÍ ROAS: prsteny = ROAS model · náušnice = ROAS ZAPLACENO (roas_real).
   *       api.php na něj u náušnic kotví kill i winners → semafor na kartě musí ukazovat
   *       tentýž ROAS, kvůli kterému karta v kroku vůbec je. Jinak Filip vidí jinou barvu,
   *       než podle které nástroj rozhodl.
   * Zdroj pravdy tabu = W.period.tab (zmrazený na začátku běhu), ne ADS.state.tab —
   * ten se může pod rukama přepnout, zatímco wizard drží data původního tabu.
   */
  const isEar = () => (((W && W.period && W.period.tab) || (ADS.state && ADS.state.tab)) === 'earrings');
  const cpaOf = (c) => (c.cpa != null ? c.cpa : (c.cps != null ? c.cps : null));
  const decisionRoas = (c) => (isEar() ? c.roas_real : c.roas_model);
  const decisionRoasLabel = () => (isEar() ? 'ROAS zaplaceno' : 'ROAS model');
  const roasPill = (c) => {
    const v = decisionRoas(c);
    return '<span class="hw-sem ' + semClass(v) + '">' + F.roas(v) + '</span>';
  };

  // Trend CPS (7d vs 30d): ⬆︎ horší (červená) / ⬇︎ lepší (zelená) / → beze změny.
  // POZOR: api.php (present_row) posílá trend_cps jako OBJEKT {dir,cps7,cps30} — server je zdroj
  // pravdy, takže objekt rozbalíme na .dir (stejně jako tables.js). Ratio/string snese jako fallback.
  function trendCell(v) {
    let tip = '';
    if (v && typeof v === 'object') {
      const c7 = num(v.cps7), c30 = num(v.cps30);
      // D3/#27: `cps7`/`cps30` jsou názvy POLÍ ze serveru (historický alias), ale uživateli
      // se ta metrika jmenuje CPA — popisek proto CPA, klíče necháváme.
      if (c7 > 0 || c30 > 0) tip = ' title="CPA 7d ' + esc(F.money(c7)) + ' vs 30d ' + esc(F.money(c30)) + '"';
      v = v.dir != null ? v.dir : (v.trend != null ? v.trend : (v.direction != null ? v.direction : v.value));
    }
    const wrap = (cls, txt) => '<span class="hw-trend ' + cls + '"' + tip + '>' + txt + '</span>';
    if (v == null || v === '') return wrap('hw-t-flat', '→');
    if (typeof v === 'string' && !/^-?\d/.test(v.trim())) {
      const s = v.toLowerCase();
      if (/up|hor|worse|zhor|▲|⬆/.test(s)) return wrap('hw-t-up', '⬆︎ horší');
      if (/down|lep|better|zlep|▼|⬇/.test(s)) return wrap('hw-t-down', '⬇︎ lepší');
      return wrap('hw-t-flat', '→ stabilní');
    }
    const r = num(v);
    if (r > 1.05) return wrap('hw-t-up', '⬆︎ ' + Math.round((r - 1) * 100) + ' %');
    if (r < 0.95 && r > 0) return wrap('hw-t-down', '⬇︎ ' + Math.round((1 - r) * 100) + ' %');
    return wrap('hw-t-flat', '→');
  }

  // Prahy ze serveru (VELKÁ písmena — kanonická konvence: cfg.thresholds z api.php).
  const th = (k) => {
    const t = (window.ADS && ADS.TH) || {};
    return t[k] != null ? num(t[k]) : null;
  };

  /* C3: BREAK-EVEN — PLOŠNĚ 2,0 pro VŠECHNO (Filip 16. 7.: „Nechme dva pro všechno",
   * dvě různé linky v jednom grafu se nedají porovnat očima).
   *
   * ZDROJ PRAVDY = server `?action=config` → `breakeven.default`. NEdržet číslo v kódu:
   * na Nastavení se dělá vrstva `ads_settings`, kde Filip práh přepíše — a wizard by pak
   * kreslil jinou linku než grafy. app.js `breakeven` do window.ADS NEPROPISUJE (ověřeno)
   * a NENÍ můj soubor → tahám si config sám, stejně jako to řeší charts.js.
   * Kotví se na ROAS MODEL (SPEC §1: „prahy se kotví SEM") → linku kreslíme jen tam.
   * Fallback 2,0 = tatáž hodnota, jakou dnes vrací server → než config doteče, nelže. */
  const BREAKEVEN_FALLBACK = 2.0;
  function ensureConfig() { return cached('cfg', () => apiGet('config', {})); }
  function breakevenRoas() {
    const slot = ensureConfig();
    if (slot.status === 'ok' && slot.data && slot.data.breakeven && slot.data.breakeven.default != null) {
      return num(slot.data.breakeven.default);
    }
    const a = (window.ADS && ADS.BREAKEVEN) || null;   // bonus, kdyby to app.js doplnil
    if (a && a.default != null) return num(a.default);
    return BREAKEVEN_FALLBACK;
  }

  // Popisky kill vrstev (SPEC §1)
  const KILL_LAYER = {
    1: 'Spend bez leadů',
    2: 'Tichý žrout',
    3: 'Extrém CPL',
    4: 'Zralá ROAS<1',
  };

  /* --- N7: DŮVOD KRÁTCE NA PILLU, DETAIL DO POPUPU -------------------------
   * Filip: „text krátký („Vysoké CPL", „Tichý žrout", „ROAS pod break-even").
   *         Detail ze závorky → po najetí na pill se otevře popup s vysvětlením
   *         + daty. Ne overkill — pár řádků."
   * api.php posílá `kill_reason` jako „KRÁTCE (detail)", ověřeno naostro 16. 7.:
   *   „ROAS pod break-even (vzorek 24, ROAS 1.73 < break-even 2× funnelu Snubní 30K)"
   *   „Spend bez leadů (13940 Kč, 0 leadů)"
   * → řežeme na PRVNÍ závorce: před ní pill, uvnitř popup. Bez závorky se nic
   *   neztratí (detail = '') a pill zůstane jak byl.
   * ⚠️ Server je zdroj pravdy: NEskládáme si text sami, jen ho dělíme — kdyby
   *    api.php formulaci změnil, propíše se sem beze změny kódu.
   * ------------------------------------------------------------------------ */
  function splitReason(reason) {
    const s = String(reason == null ? '' : reason).trim();
    const i = s.indexOf('(');
    if (i < 0 || !s.endsWith(')')) return { short: s, detail: '' };
    const short = s.slice(0, i).trim();
    if (!short) return { short: s, detail: '' };   // závorka hned na začátku → nedělit
    return { short, detail: s.slice(i + 1, -1).trim() };
  }
  const keepReasonLabel = {
    mlada: 'Mladá (málo dat)',
    cekam: 'Čekám na data',
    strategicka: 'Strategická',
    jine: 'Jiné',
  };

  /* ---------------------------------------------------------------------------
   * API helpers přes ADS.api
   *   GET  → ADS.api(action, params)
   *   POST → ADS.api(action, params, {method:'POST'})  (kill/reactivate/wizard_save)
   *   Shell si podle action řídí metodu; opts.method je jen explicitní nápověda.
   * ------------------------------------------------------------------------ */
  const apiGet = (action, params) => ADS.api(action, params || {});
  const apiPost = (action, params) => ADS.api(action, params || {}, { method: 'POST' });

  /* ---------------------------------------------------------------------------
   * Definice kroků podle aktuálního tabu
   * ------------------------------------------------------------------------ */
  function buildStepDefs() {
    const tab = (ADS.state && ADS.state.tab) || 'rings';
    const defs = [{ key: 'kill', label: 'Kill', icon: '🔴' }];
    if (tab !== 'earrings') {
      defs.push({ key: 'funnels', label: 'Funnely', icon: '🔻' });
      defs.push({ key: 'events', label: 'Eventy', icon: '🎯' });
    }
    defs.push({ key: 'scale', label: 'Škálování', icon: '🟢' });
    defs.push({ key: 'newest', label: 'Nové', icon: '🆕' });
    defs.push({ key: 'summary', label: 'Souhrn', icon: '✅' });
    return defs;
  }

  /* ---------------------------------------------------------------------------
   * Běhový stav wizardu (jedna instance)
   * ------------------------------------------------------------------------ */
  let W = null;
  let saveTimer = null;   // debounce průběžného ukládání (J4)
  function freshState() {
    return {
      open: false,
      idx: 0,
      steps: buildStepDefs(),
      period: {
        from: ADS.state && ADS.state.from,
        to: ADS.state && ADS.state.to,
        tab: (ADS.state && ADS.state.tab) || 'rings',
        who: (ADS.state && ADS.state.user) || 'Filip',
      },
      // načtená data + stav načítání per krok
      data: { kill: null, overview: null, winners: null, newest: null },
      load: { kill: 'idle', overview: 'idle', winners: 'idle', newest: 'idle' },
      err: { kill: null, overview: null, winners: null, newest: null },
      // rozhodnutí uživatele
      dec: {
        kill: {},   // creative -> {decision:'kill'|'keep', reason, note, running, result:'ok'|'partial', failed:[], ad_ids:[]}
        funnels: {},// name -> {decision:'ok'|'flag', note}
        events: {}, // name -> {decision:'ok'|'flag', note}
        scale: {},  // creative -> {decision:'scale'|'wait', note}  (wait = odmítnutí → note POVINNÁ)
        newest: {}, // creative -> {decision:'ok'|'flag', note}     (flag = odmítnutí → note POVINNÁ)
        scaleAck: false,  // ack když nejsou žádní kandidáti
        newestAck: false, // ack když nejsou žádné nové reklamy
      },
      /* F7/D3 — ručně ROZBALENÉ karty. Rozhodnutá karta se kolapsne na řádek
       * (miniatura + název + odznak). Kdo si ji chce zas prohlédnout, klikne na ni →
       * klíč „bucket|key" tady drží výjimku. Stav je v paměti (ne v draftu na serveru):
       * je to čistě zobrazení, po zavření wizardu na něm nezáleží. */
      expand: {},
      saving: false,      // finální uložení (krok Souhrn) — drží spinner v patičce
      rootEl: null,
      /* --- J4: průběžné ukládání ------------------------------------------
       * draftSaving  … běží autosave (odděleně od `saving`, ať se nervou o patičku)
       * savePending  … během autosave přišla další změna → po doběhnutí uložit znovu
       * saveState    … stav pro chip v hlavičce (idle|pending|saving|saved|error)
       * wasFinished  … dnešní běh už BYL dokončený (z wizard_today).
       *                Server při každém uložení přepisuje finished_at = (finished ? now : NULL),
       *                takže draft s finished:false by hotový běh ODdokončil a vrátil HECK banner.
       *                → draft posílá finished: W.wasFinished, nikdy natvrdo false.
       * runId/restored … kolik rozhodnutí se předvyplnilo z rozpracovaného běhu
       * focus        … CSS selektor karty, na kterou se má po renderu skočit (J2) */
      draftSaving: false,
      savePending: false,
      saveState: { status: 'idle', at: null, err: null },
      wasFinished: false,
      runId: null,
      restored: 0,
      focus: null,

      /* --- H4/H5/H6: ANALYTICKÁ VRSTVA (čistě POHLED, ne rozhodnutí) ---------
       * ⚠️ KONTRAKT: přepínač okna ani filtr funnelu NESMÍ změnit, o čem se rozhoduje.
       * Karty (a tím gating „dokončit až když je vše vyřešeno") se VŽDY staví z dat
       * období běhu (W.data.overview). Okno 14/30/60 a filtr funnelu mění jen ČÍSLA
       * a GRAF na kartě — jinak by přepnutí okna tiše odemklo/zamklo dokončení běhu
       * a do feedbacku by se uložilo něco jiného, než co Filip viděl.
       *   view.<krok>.days   … null = období běhu; jinak 14/30/60
       *   view.events.funnel … '' = Vše; jinak název funnelu (H5 filtr)
       *   view.<krok>.metric … metrika grafu (společná pro celý krok — Filip chce
       *                        MÉNĚ ovládacích prvků, ne chip u každé karty)
       *   view.<krok>.gran   … W1: osa grafu day|week|month (Filip: „ten graf se ukazuje
       *                        ne po dnech, ale i po týdnech nebo měsících")
       *
       * ⚠️ `gran` je zatím MRTVÉ POLE — ovládání ZÁMĚRNĚ NENÍ. Blokuje to SERVER, ne frontend.
       * Ověřeno v kódu 17. 7. (neobjevovat znovu, nepokoušet se to obejít na FE):
       *   • Grafy kroků jedou z `?action=timeseries` (ne z funnel_trend/event_trend!) a
       *     `build_timeseries(tab, from, to, metric, split, funnelFilter)` NEMÁ parametr
       *     granularity vůbec — vrací VŽDY denní řadu. (funnel_trend `$gran` má, ale umí
       *     jen 'week'; `trend_bucket_key()` u 'month' tiše spadne na den — FEEDBACK-6 G1.)
       *   • Dobucketovat si týden/měsíc na FE NELZE bez lhaní: sečíst denní `revenue_model`
       *     je přesně ta Lookerova denní matematika, kterou FEEDBACK-6 D1 zabil („tu tržbu
       *     dělíš tím, kolik proběhlo hovorů — pro TEN segment"). Správně je derive AŽ nad
       *     součtem koše, k čemuž je potřeba Σcalled/Σcalled_base/Σpassed.
       *   • A ty počty timeseries NEPOSÍLÁ: `timeseries_allowed()` = spend, revenue,
       *     revenue_model, roas_real, roas_model, cpl, cpa, cps, leads, new_leads,
       *     valuable_leads, bookings, reservations.
       *     `called`, `called_base` ani `passed` mezi nimi NEJSOU.
       *     Zpětně dopočítat taky ne: pct_schuzek by z bookings×cpa šlo, ale `called_base`
       *     je „řádky s NEprázdným called" (schema.sql: 17,3 % řádků má NULL) → NENÍ to
       *     `leads` a z ničeho v odpovědi se to nedá odvodit.
       * → W1 = nejdřív `$gran` do build_timeseries (day|week|month, derive nad součtem koše
       *   + český `label`), teprve pak sem chipy. Tlačítko bez toho by LHALO. */
      view: {
        funnels: { days: null, metric: 'cpl', gran: 'day' },
        events:  { days: null, metric: 'cpl', funnel: '', gran: 'day' },
      },
      /* Cache načtených analytických dat (klíč → {status:'loading'|'ok'|'error', data, err}).
       *   ov   … 'overview|<from>|<to>'  — ČÍSLA (autorita, shodná s tabulkami i Lookerem)
       *   tr   … 'tr|<action>|<funnel>|<gran>|<from>|<to>' — funnel_trend/event_trend:
       *          jedním requestem řada VŠECH skupin × všech metrik + totals za okno
       *   wk   … 'wk'                    — týdenní agregáty kreativ (H6) */
      cache: {},
      charts: {},        // hostId → ECharts instance (dispose před každým re-renderem)
      chartSpecs: {},    // hostId → spec pro mountCharts()
    };
  }

  /* ---------------------------------------------------------------------------
   * Styly — public/css/wizard.css (scoped prefixem .hw-)
   *
   * PROČ <link> a ne <style> s CSS v JS: 300 řádků CSS v template stringu se needituje
   * ani neformátuje a při každém načtení appky se táhne v JS payloadu. Styly jsou teď
   * v souboru vedle views.css/newest.css/picker.css.
   *
   * PROČ si link injektujeme SAMI, i když ho index.html nejspíš nalinkuje taky:
   * index.html patří shellu (jiný agent) — kdyby se link zapomněl přidat, wizard by
   * naběhl úplně bez stylů. Kontrola podle názvu souboru → druhý link se nepřidá.
   * Verzi (?v=) bereme z vlastního <script src>, ať se cache-bustuje spolu s deployem
   * (deploy.py přerazítkovává `?v=` jen v index.html, na injektované URL nedosáhne).
   * ------------------------------------------------------------------------ */
  const STYLE_HREF = 'css/wizard.css';
  function injectStyles() {
    if (document.getElementById('hw-styles')) return;
    // Už ho tam dal index.html? (porovnáváme cestu, ne celé URL — liší se ?v=)
    const has = Array.prototype.some.call(
      document.querySelectorAll('link[rel="stylesheet"]'),
      (l) => (l.getAttribute('href') || '').split('?')[0].indexOf(STYLE_HREF) >= 0
    );
    if (has) return;
    const link = document.createElement('link');
    link.id = 'hw-styles';
    link.rel = 'stylesheet';
    link.href = STYLE_HREF + styleVersion();
    // Bez stylů je wizard nepoužitelný → ať se to nehledá v konzoli hodinu.
    link.onerror = () => { try { toast('Styly wizardu se nenačetly (css/wizard.css) — nasadil se soubor?', 'error'); } catch (_) {} };
    document.head.appendChild(link);
  }
  /** `?v=…` ze <script src="wizard.js?v=…">; prázdné, když tam razítko není. */
  function styleVersion() {
    const s = document.querySelector('script[src*="wizard.js"]');
    const src = s ? (s.getAttribute('src') || '') : '';
    const q = src.indexOf('?');
    return q >= 0 ? src.slice(q) : '';
  }


  /* ---------------------------------------------------------------------------
   * Vnořený dialog (uvnitř overlay, samostatný — nezávisí na shell modalu)
   *   choiceDialog → N tlačítek, vrací id zvoleného ('' = klik mimo / zrušeno)
   *   confirmDialog → tenká obálka nad ním (zachovaná původní signatura)
   * ------------------------------------------------------------------------ */
  function choiceDialog({ title, body, buttons, cancelId, focusId }) {
    return new Promise((resolve) => {
      if (!W || !W.rootEl) return resolve('');
      const btns = (buttons || []).filter(Boolean);
      const wrap = document.createElement('div');
      wrap.className = 'hw-confirm';
      wrap.innerHTML =
        '<div class="hw-confirm-box" role="dialog" aria-modal="true">' +
        '<h4>' + esc(title) + '</h4>' +
        '<p>' + body + '</p>' +
        '<div class="hw-confirm-actions">' +
        btns.map((b) => '<button class="hw-btn ' + (b.cls || 'hw-btn-ghost') + '" data-x="' + esc(b.id) + '">' +
          esc(b.text) + '</button>').join('') +
        '</div></div>';
      const done = (val) => { wrap.remove(); resolve(val); };
      wrap.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]');
        if (x) return done(x.getAttribute('data-x'));
        if (e.target === wrap) return done(cancelId || ''); // klik mimo box = zrušit
      });
      W.rootEl.appendChild(wrap);
      const f = wrap.querySelector('[data-x="' + cssEsc(focusId || (btns[btns.length - 1] || {}).id || '') + '"]');
      f && f.focus();
    });
  }
  function confirmDialog({ title, body, okText, okDanger, cancelText }) {
    return choiceDialog({
      title, body, cancelId: 'no', focusId: 'yes',
      buttons: [
        { id: 'no', text: cancelText || 'Zpět', cls: 'hw-btn-ghost' },
        { id: 'yes', text: okText || 'Potvrdit', cls: okDanger ? 'hw-btn-danger' : 'hw-btn-primary' },
      ],
    }).then((x) => x === 'yes');
  }

  /* ---------------------------------------------------------------------------
   * Data loadery (lazy, s cache v rámci jednoho běhu)
   * ------------------------------------------------------------------------ */
  async function ensureKill() {
    if (W.load.kill === 'ok' || W.load.kill === 'loading') return;
    W.load.kill = 'loading'; W.err.kill = null; render();
    try {
      const res = await apiGet('creatives', {
        from: W.period.from, to: W.period.to, tab: W.period.tab, segment: 'kill',
      });
      W.data.kill = normalizeArr(res);
      W.load.kill = 'ok';
    } catch (e) {
      W.load.kill = 'error'; W.err.kill = errMsg(e);
    }
    render();
  }

  async function ensureOverview() {
    if (W.load.overview === 'ok' || W.load.overview === 'loading') return;
    W.load.overview = 'loading'; W.err.overview = null; render();
    try {
      const res = await apiGet('overview', {
        from: W.period.from, to: W.period.to, tab: W.period.tab,
      });
      W.data.overview = res || {};
      W.load.overview = 'ok';
    } catch (e) {
      W.load.overview = 'error'; W.err.overview = errMsg(e);
    }
    render();
  }

  async function ensureWinners() {
    if (W.load.winners === 'ok' || W.load.winners === 'loading') return;
    W.load.winners = 'loading'; W.err.winners = null; render();
    try {
      const res = await apiGet('creatives', {
        from: W.period.from, to: W.period.to, tab: W.period.tab, segment: 'winners',
      });
      W.data.winners = normalizeArr(res);
      W.load.winners = 'ok';
    } catch (e) {
      W.load.winners = 'error'; W.err.winners = errMsg(e);
    }
    render();
  }

  async function ensureNewest() {
    if (W.load.newest === 'ok' || W.load.newest === 'loading') return;
    W.load.newest = 'loading'; W.err.newest = null; render();
    try {
      const res = await apiGet('creatives', {
        from: W.period.from, to: W.period.to, tab: W.period.tab, segment: 'new',
      });
      W.data.newest = normalizeArr(res);
      W.load.newest = 'ok';
    } catch (e) {
      W.load.newest = 'error'; W.err.newest = errMsg(e);
    }
    render();
  }

  /* ===========================================================================
   * ANALYTICKÁ VRSTVA (H4/H5/H6) — lazy loadery s cache v rámci jednoho běhu
   *
   * ⚠️ DVA ZDROJE, KAŽDÝ NA SVOU PRÁCI (ověřeno naostro 16. 7. proti ostré api.php):
   *   • ČÍSLA na kartě  ← ?action=overview za dané okno. Autorita: staví se z per-kreativa
   *     rozpadu `funnels[]` (spend_est dle podílu leadů) — tedy TABULKA, podle které Filip
   *     rozděluje ~1,4 mil. Kč/měs. a kterou cross-checkuje s Lookerem.
   *   • GRAF (denní tvar) ← ?action=timeseries. Ten dělí spend podle PRIMÁRNÍHO funnelu
   *     kreativy (primary_map), ne podle podílu leadů.
   * Naměřený rozdíl Σtimeseries(30 d) vs overview(30 d) na TÉMŽE okně:
   *     Snubní 30K −0,1 % · Zásnubní 49K 0,0 % · 100K −0,4 % · Šaty +0,1 %   → 95 % spendu sedí
   *     100K Dotazník +90,5 % · Maledivy −51,8 % · `---` −100 % (30 863 Kč v grafu chybí)
   *   Leady a rezervace sedí VŠUDE přesně (0,0 %) — rozchází se jen ATRIBUCE SPENDU.
   * → Graf proto bereme jako TVAR v čase, ne jako zdroj čísel, a když se u konkrétního
   *   funnelu rozejde o víc než CHART_MISMATCH_WARN, karta to PŘIZNÁ (chartMismatch()).
   *   Kdyby api.php sjednotil atribuci (viz report), hlídka prostě přestane hlásit.
   * U EVENTŮ se obě cesty shodují přesně (0,0 %) — overview i timeseries tam jedou přes
   * primary_map → filtr „event uvnitř funnelu" (H5) se smí počítat z timeseries.
   *
   * ⚠️ Okno je součást atribuce: primary_map se počítá ZA DOTAZOVANÉ OKNO. 90denní řadu
   *    proto NELZE sečíst na „30 dní" (naměřeno: event „Leads" +50,6 % oproti overview 30 d)
   *    → čísla se VŽDY tahají dotazem na to konkrétní okno.
   * ======================================================================== */

  // F7/D4: graf už nemá vlastní pevné okno — jede na tom, co je zvolené chipem (ensureTrend).
  // Konstanta zůstává jako pojmenovaný default pro případné další grafy; do fe grafu nevstupuje.
  const CHART_DAYS = 90;            // „graf vývoje po dnech za ~3 měsíce" (H4/H5)
  const CHART_MISMATCH_WARN = 0.15; // rozdíl graf vs. čísla, od kterého to karta přizná
  const WEEK_COUNT = 10;            // H6: kolik ISO týdnů zpět (10 × 7 d ≈ 2,5 měsíce)
  const WEEK_CONC = 3;              // souběžné requesty (server dělá compute_creatives na každý)

  // Metriky grafu — společné pro celý krok (méně ovládacích prvků, viz FEEDBACK E).
  // `add` = additivní přes dny (smí se sčítat) — používá se u hlídky atribuce.
  const CHART_METRICS = [
    { k: 'cpl', label: 'CPL', kind: 'money', add: false },
    { k: 'cpa', label: 'CPA', kind: 'money', add: false },
    { k: 'roas_model', label: 'ROAS model', kind: 'roas', add: false },
    { k: 'spend', label: 'Spend', kind: 'money', add: true },
    { k: 'leads', label: 'Leady', kind: 'int', add: true },
    { k: 'bookings', label: 'Rezervace', kind: 'int', add: true },
  ];
  const metricDef = (k) => CHART_METRICS.find((m) => m.k === k) || CHART_METRICS[0];

  // Generický cache-wrapper: vrátí položku a případně nastartuje načtení (idempotentně).
  function cached(key, loader) {
    const c = W.cache[key];
    if (c) return c;
    const slot = W.cache[key] = { status: 'loading', data: null, err: null };
    Promise.resolve()
      .then(loader)
      .then((d) => { slot.status = 'ok'; slot.data = d; })
      .catch((e) => { slot.status = 'error'; slot.err = errMsg(e); })
      .then(() => { if (W && W.open) render(); });
    return slot;
  }

  /* --- Okna 14/30/60 + okno běhu ------------------------------------------- */
  function runDays() { return daysBetween(W.period.from, W.period.to); }
  // Chipy: 14/30/60 + „Okno běhu", když má jinou délku (jinak by tam byl duplikát).
  function windowOptions() {
    const rd = runDays();
    const out = [14, 30, 60].map((d) => ({ days: d, label: d + ' dní', run: d === rd }));
    if (!out.some((o) => o.run)) out.unshift({ days: null, label: 'Okno běhu · ' + rd + ' ' + dayWord(rd), run: true });
    return out;
  }
  // null = okno běhu. `to` držíme na konci období běhu, ať se okna porovnávají ke stejnému dni.
  function viewRange(days) {
    if (days == null) return { from: W.period.from, to: W.period.to, days: runDays() };
    return { from: shiftDays(W.period.to, -(days - 1)), to: W.period.to, days };
  }
  const rangeKey = (r) => r.from + '|' + r.to;

  /** ČÍSLA za okno (overview). Vrací slot {status,data:{funnels,events,totals,…}}. */
  function ensureWindowOverview(days) {
    const r = viewRange(days);
    // Okno běhu už máme načtené hlavním loaderem → neplýtvej requestem.
    if (r.from === W.period.from && r.to === W.period.to && W.load.overview === 'ok') {
      return { status: 'ok', data: W.data.overview, err: null };
    }
    if (r.from === W.period.from && r.to === W.period.to && W.load.overview === 'error') {
      return { status: 'error', data: null, err: W.err.overview };
    }
    return cached('overview|' + rangeKey(r), () =>
      apiGet('overview', { from: r.from, to: r.to, tab: W.period.tab }));
  }

  /** GRAF: denní řada za ZVOLENÉ okno. Jeden request pokryje VŠECHNY funnely/eventy naráz.
   *
   * ⚠️ F7/D4 (Filip 23. 7.: „ono to mění ty čísla a nemění to ten graf. Ono by to mělo
   * měnit i ten graf, který tam je.") — do 23. 7. si graf bral natvrdo posledních
   * CHART_DAYS (90) dní BEZ OHLEDU na chip s oknem, a `days` nebyly ani v cache klíči.
   * Přepnutí okna tedy přepočítalo čísla nad grafem, ale graf zůstal vizuálně stejný,
   * takže to vypadalo jako zamrzlá komponenta.
   * Teď okno určuje `days` (null = okno běhu) a rozdíl se propíše i do cache klíče
   * (ten obsahuje from|to). CHART_DAYS zůstává jen jako výchozí kontext, když se okno neřeší. */
  function ensureTrend(split, metric, funnelFilter, days) {
    const r = viewRange(days === undefined ? null : days);
    const from = r.from, to = r.to;
    const ff = funnelFilter || '';
    return cached('ts|' + split + '|' + metric + '|' + ff + '|' + from + '|' + to, () => {
      const p = { from, to, tab: W.period.tab, metric, split };
      if (ff) p.funnel = ff;
      return apiGet('timeseries', p);
    });
  }
  // Z odpovědi timeseries vytáhni řadu jedné skupiny (funnel/event).
  function trendSeries(slot, name) {
    const d = slot && slot.status === 'ok' ? slot.data : null;
    if (!d || !Array.isArray(d.series)) return null;
    const s = d.series.find((x) => String(x.name) === String(name));
    if (!s) return null;
    return { dates: d.dates || [], data: s.data || [], estFrom: s.estimating_from_index != null ? s.estimating_from_index : d.estimating_from_index };
  }

  /* --- H5: eventy UVNITŘ funnelu -------------------------------------------
   * overview eventy podle funnelu filtrovat neumí (build_overview funnel param nemá).
   * timeseries ANO (`split=event&funnel=…`) a u eventů dává na TÉMŽE okně shodná čísla
   * jako overview (ověřeno: Δ 0,0 % na všech 6 eventech se spendem) → dopočítáme si je
   * ze součtu denních řad. Additivní metriky sečteme; CPA potřebuje jmenovatel
   * bookings_eff, který server neposílá → Σ(spend_den / CPA_den) ho zrekonstruuje přesně
   * (Looker CPA = spend / bookings_eff, takže spend_den/CPA_den = bookings_eff_den).
   * ------------------------------------------------------------------------ */
  const EV_METRICS = ['spend', 'leads', 'bookings', 'revenue', 'revenue_model', 'cpa'];
  function ensureEventsInFunnel(funnel, days) {
    const r = viewRange(days);
    return cached('evw|' + funnel + '|' + rangeKey(r), () =>
      Promise.all(EV_METRICS.map((m) =>
        apiGet('timeseries', { from: r.from, to: r.to, tab: W.period.tab, metric: m, split: 'event', funnel })
      )).then((res) => {
        const byMetric = {};
        EV_METRICS.forEach((m, i) => {
          byMetric[m] = {};
          (res[i].series || []).forEach((s) => { byMetric[m][String(s.name)] = s.data || []; });
        });
        const names = Object.keys(byMetric.spend || {});
        const sum = (a) => (a || []).reduce((x, y) => x + num(y), 0);
        const rows = {};
        names.forEach((n) => {
          const sp = sum(byMetric.spend[n]);
          const leads = sum(byMetric.leads[n]);
          const bookings = sum(byMetric.bookings[n]);
          const rev = sum(byMetric.revenue[n]);
          const revModel = sum(byMetric.revenue_model[n]);
          // Σ bookings_eff = Σ (spend_den / CPA_den); dny s CPA 0 nesou 0 rezervací → přeskoč.
          const spD = byMetric.spend[n] || [], cpaD = byMetric.cpa[n] || [];
          let bkEff = 0;
          for (let i = 0; i < cpaD.length; i++) { const c = num(cpaD[i]); if (c > 0) bkEff += num(spD[i]) / c; }
          rows[n] = {
            spend: sp, leads, bookings,
            cpl: leads > 0 ? sp / leads : 0,
            cpa: bkEff > 0 ? sp / bkEff : 0,
            revenue_real: rev, revenue_model: revModel,
            roas_real: sp > 0 ? rev / sp : 0,
            roas_model: sp > 0 ? revModel / sp : 0,
            _empty: sp === 0 && leads === 0,
          };
        });
        return rows;
      }));
  }

  /* --- H6: týdenní agregáty kreativ ----------------------------------------
   * Filip chce u scale checku mini graf PO TÝDNECH (CPL, tržby, CPA). Per-kreativa
   * řada se ze serveru přímo tahat nedá (timeseries `split=creative` u prstenů není),
   * ale `?action=creatives&from&to` vrací agregát kreativ ZA LIBOVOLNÉ OKNO → zavoláme ho
   * na každý ISO týden. Metriku počítá SERVER ze součtu syrových řádků (ne průměr hotových
   * denních CPL) → čísla sedí s kartou. Cache je klíčovaná TÝDNEM, ne kreativou, takže
   * všechny scale karty jedou z jedněch WEEK_COUNT requestů (dnes typicky 3 karty).
   * Stejný postup, jaký na trend kreativy používá charts.js.
   * ------------------------------------------------------------------------ */
  function isoWeekStart(s) {
    const d = parseISO(s);
    const dow = (d.getUTCDay() + 6) % 7;   // 0 = pondělí
    return iso(new Date(d.getTime() - dow * 86400000));
  }
  function lastIsoWeeks(endISO, n) {
    const cur = isoWeekStart(endISO);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const ws = shiftDays(cur, -i * 7);
      const we = shiftDays(ws, 6);
      // `partial` = běžící (nedojetý) týden. Bez tohohle příznaku by se headline u sparku
      // četl z pondělního ranního výseku a winner s 360 940 Kč za měsíc by hlásil „Tržby 0 Kč".
      out.push({ start: ws, from: ws, to: we > endISO ? endISO : we, partial: we > endISO });
    }
    return out;
  }
  function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = () => {
      if (i >= items.length) return Promise.resolve();
      const my = i++;
      return Promise.resolve(fn(items[my], my)).then((r) => { out[my] = r; return worker(); });
    };
    const runners = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(worker());
    return Promise.all(runners).then(() => out);
  }
  function ensureWeekly() {
    return cached('wk', () => {
      const weeks = lastIsoWeeks(W.period.to, WEEK_COUNT);
      return mapLimit(weeks, WEEK_CONC, (w) =>
        apiGet('creatives', { from: w.from, to: w.to, tab: W.period.tab })
          .then((res) => {
            const by = Object.create(null);
            normalizeArr(res).forEach((r) => { by[cKeyOf(r)] = r; });
            return by;
          })
          .catch(() => null)     // jeden vypadlý týden = díra v grafu, ne pád celého kroku
      ).then((maps) => ({ weeks, maps }));
    });
  }
  /** Týdenní řada jedné kreativy → {weeks:[start…], cpl:[], revenue:[], cpa:[], any} */
  function weeklyOf(cKey) {
    const slot = ensureWeekly();
    if (slot.status !== 'ok') return null;
    const { weeks, maps } = slot.data;
    const out = { weeks: [], cpl: [], revenue: [], cpa: [], any: false,
                  partialFrom: weeks.findIndex((w) => w.partial) };
    weeks.forEach((w, i) => {
      out.weeks.push(w.start);
      const row = maps[i] ? maps[i][cKey] : null;
      if (!row) { out.cpl.push(null); out.revenue.push(null); out.cpa.push(null); return; }
      const sp = num(row.spend);
      if (sp > 0) out.any = true;
      // Bez spendu není CPL/CPA definované → díra v grafu, ne čára po nule.
      out.cpl.push(sp > 0 && row.cpl != null ? num(row.cpl) : null);
      const cpa = cpaOf(row);
      out.cpa.push(sp > 0 && cpa != null && num(cpa) > 0 ? num(cpa) : null);
      out.revenue.push(num(row.revenue_real));
    });
    return out;
  }

  // api může vrátit pole nebo {data:[...]} / {rows:[...]} — sjednotíme
  function normalizeArr(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.data)) return res.data;
    if (res && Array.isArray(res.rows)) return res.rows;
    if (res && Array.isArray(res.items)) return res.items;
    return [];
  }
  function errMsg(e) {
    // ADS.api hází Error('HTTP 400') a detail schovává do e.body.error — pro uživatele
    // je „u odmítnutí je důvod povinný" o dost užitečnější než „HTTP 400".
    const be = e && e.body && (e.body.error || e.body.message);
    if (be) return String(be);
    return (e && (e.message || e.error)) ? String(e.message || e.error) : 'Nepodařilo se načíst data.';
  }

  // Spustí načtení dat potřebná pro aktuální krok
  function loadForCurrentStep() {
    const key = W.steps[W.idx].key;
    if (key === 'kill') ensureKill();
    else if (key === 'funnels' || key === 'events') ensureOverview();
    else if (key === 'scale') ensureWinners();
    else if (key === 'newest') ensureNewest();
    else if (key === 'summary') loadAllSteps();   // souhrn musí znát stav VŠECH kroků (J2/J3)
  }

  // J1: navigace je volná → uživatel může skočit rovnou na Souhrn. Aby progress bar
  // i seznam „co chybí" říkaly pravdu od první vteřiny, načteme data všech kroků naráz.
  // (4 paralelní GETy, ensure* jsou idempotentní → opakované volání nic nestojí.)
  function loadAllSteps() {
    ensureKill();
    if (W.steps.some((s) => s.key === 'funnels')) ensureOverview();
    ensureWinners();
    ensureNewest();
  }

  /* ---------------------------------------------------------------------------
   * Resolved-logika (blbuvzdornost: Další povolen jen když je krok vyřešen)
   * ------------------------------------------------------------------------ */
  function killResolved(cKey) {
    const d = W.dec.kill[cKey];
    if (!d || !d.decision) return false;
    if (d.decision === 'keep') {
      if (!d.reason) return false;
      if (d.reason === 'jine' && !(d.note && d.note.trim())) return false;
      return true;
    }
    if (d.decision === 'kill') {
      return d.result === 'ok' && !d.running;
    }
    return false;
  }
  function fRowResolved(bucket, name) {
    const d = W.dec[bucket][name];
    if (!d || !d.decision) return false;
    // SPEC §5: „Odmítnout" (flag) → důvod je POVINNÝ, jinak nejde dál.
    if (d.decision === 'flag' && !(d.note && d.note.trim())) return false;
    return true;
  }
  // SPEC §5: „Počkat" = odmítnutí doporučení „škáluj" → důvod POVINNÝ (bez něj nejde dál).
  function scaleResolved(cKey) {
    const d = W.dec.scale[cKey];
    if (!d || !d.decision) return false;
    if (d.decision === 'wait' && !(d.note && d.note.trim())) return false;
    return true;
  }
  // SPEC §5 krok 5: „Flag" u nové reklamy = odmítnutí → důvod POVINNÝ.
  function newestResolved(cKey) {
    const d = W.dec.newest[cKey];
    if (!d || !d.decision) return false;
    if (d.decision === 'flag' && !(d.note && d.note.trim())) return false;
    // F7/D6: „kill" je vyřešený teprve tehdy, když Meta potvrdí PAUSED (stejně jako
    // v killResolved). Jinak by krok šel dokončit uprostřed vypínání a karta by se
    // složila dřív, než je jasné, že se to povedlo.
    if (d.decision === 'kill') return d.result === 'ok' && !d.running;
    return true;
  }

  /* --- Nevyřešené položky kroku (JEDEN zdroj pravdy) -------------------------
   * Řídí najednou: tečky v progress baru (J1), seznam „co chybí" v souhrnu (J2),
   * blokaci tlačítka Dokončit (J3) i hint v patičce. Když se to počítá na jednom
   * místě, nemůže se rozejít, co bar ukazuje a co reálně blokuje dokončení.
   * kind: 'loading' (data ještě nejsou) | 'error' (nenačetlo se) | 'item' (chybí rozhodnutí)
   * sel:  CSS selektor karty → klik v souhrnu na ni skočí
   * ------------------------------------------------------------------------ */
  const LOAD_OF = { kill: 'kill', funnels: 'overview', events: 'overview', scale: 'winners', newest: 'newest' };
  function stepIssues(key) {
    const out = [];
    const src = LOAD_OF[key];
    if (src) {
      if (W.load[src] === 'error') {
        return [{ kind: 'error', label: 'Data se nenačetla', hint: W.err[src] || 'zkus to znovu', sel: null }];
      }
      if (W.load[src] !== 'ok') {
        return [{ kind: 'loading', label: 'Data se ještě načítají', hint: '', sel: null }];
      }
    }
    if (key === 'kill') {
      (W.data.kill || []).forEach((c) => {
        const k = cKeyOf(c);
        if (killResolved(k)) return;
        const d = W.dec.kill[k] || {};
        let hint = 'chybí rozhodnutí — Kill nebo Ponechat';
        if (d.decision === 'keep' && !d.reason) hint = 'ponecháno — vyber důvod';
        else if (d.decision === 'keep' && d.reason === 'jine') hint = 'důvod „Jiné" — dopiš poznámku';
        else if (d.decision === 'kill' && d.running) hint = 'vypínání běží — čekám na Metu';
        else if (d.decision === 'kill' && d.result === 'partial') hint = 'část reklam se nevypnula — zkus znovu';
        else if (d.decision === 'kill') hint = 'kill zatím nepotvrzen Metou';
        out.push({ kind: 'item', label: k, hint, sel: '[data-ckey="' + cssEsc(k) + '"]' });
      });
    } else if (key === 'funnels' || key === 'events') {
      (key === 'funnels' ? funnelRows() : eventRows()).forEach((r) => {
        if (fRowResolved(key, r.__name)) return;
        const d = W.dec[key][r.__name] || {};
        out.push({
          kind: 'item', label: r.__name,
          hint: d.decision === 'flag' ? 'flag bez důvodu — důvod je povinný' : 'chybí rozhodnutí — Potvrdit nebo Flag',
          sel: '[data-fkey="' + cssEsc(r.__name) + '"]',
        });
      });
    } else if (key === 'scale') {
      const list = scaleRows();
      if (!list.length) {
        if (!W.dec.scaleAck) out.push({ kind: 'item', label: 'Bez kandidátů', hint: 'potvrď „Beru na vědomí"', sel: '[data-scale-ack]' });
      } else {
        list.forEach((c) => {
          const k = cKeyOf(c);
          if (scaleResolved(k)) return;
          const d = W.dec.scale[k] || {};
          out.push({
            kind: 'item', label: k,
            hint: d.decision === 'wait' ? '„Počkat" bez důvodu — důvod je povinný' : 'chybí rozhodnutí — Škálovat nebo Počkat',
            sel: '[data-skey="' + cssEsc(k) + '"]',
          });
        });
      }
    } else if (key === 'newest') {
      const list = W.data.newest || [];
      if (!list.length) {
        if (!W.dec.newestAck) out.push({ kind: 'item', label: 'Žádné nové reklamy', hint: 'potvrď „Beru na vědomí"', sel: '[data-newest-ack]' });
      } else {
        list.forEach((c) => {
          const k = cKeyOf(c);
          if (newestResolved(k)) return;
          const d = W.dec.newest[k] || {};
          out.push({
            kind: 'item', label: k,
            hint: d.decision === 'flag' ? 'flag bez důvodu — důvod je povinný' : 'chybí rozhodnutí — V pořádku nebo Flag',
            sel: '[data-nkey="' + cssEsc(k) + '"]',
          });
        });
      }
    }
    return out;
  }

  // Všechno nevyřešené napříč kroky (mimo souhrn) — podklad pro J2 seznam i J3 gate.
  function missingAll() {
    const out = [];
    W.steps.forEach((s, i) => {
      if (s.key === 'summary') return;
      stepIssues(s.key).forEach((it) => {
        out.push(Object.assign({ stepIdx: i, stepKey: s.key, stepLabel: s.label }, it));
      });
    });
    return out;
  }

  // Stav kroku pro progress bar: done | todo | error | loading
  function stepState(key) {
    if (key === 'summary') return missingAll().length ? 'todo' : 'done';
    const iss = stepIssues(key);
    if (!iss.length) return 'done';
    if (iss.some((i) => i.kind === 'error')) return 'error';
    if (iss.some((i) => i.kind === 'loading')) return 'loading';
    return 'todo';
  }

  function stepReady(key) {
    return stepIssues(key).length === 0 && (key !== 'summary' || missingAll().length === 0);
  }

  // Klíč kreativy (kód) — robustně
  const cKeyOf = (c) => String(c.creative || c.code || c.kreativa || '').trim();

  /* ---------------------------------------------------------------------------
   * Odvození řádků funnelů / eventů z overview (defenzivní vůči názvům polí)
   * ------------------------------------------------------------------------ */
  // Anomálie = plochý seznam overview.anomalies (item nese funnel + deviation) — zdroj pravdy serveru.
  function anomalyMap() {
    const ov = W.data.overview || {};
    const m = {};
    normalizeArr(ov.anomalies || []).forEach((a) => {
      const n = a && (a.funnel || a.name);
      if (n) m[String(n)] = a;
    });
    return m;
  }
  function funnelRows() {
    const ov = W.data.overview || {};
    const arr = normalizeArr(ov.funnels || ov.funnel || []);
    const am = anomalyMap();
    return arr.map((f) => {
      const r = decorateFE(f, ['funnel', 'name', 'label']);
      // primárně plochý anomalies[], fallback = per-funnel anomaly_detail
      r.__anom = am[r.__name] || (f.anomaly ? (f.anomaly_detail || null) : null) || null;
      return r;
    });
  }
  function eventRows() {
    const ov = W.data.overview || {};
    const arr = normalizeArr(ov.events || ov.optimizations || ov.event || []);
    // server anomálie na eventech nepočítá (funnel_anomalies() je jen per funnel) → __anom vždy null
    return arr.map((f) => decorateFE(f, ['event', 'name', 'optimization', 'label']));
  }
  function decorateFE(f, nameKeys) {
    let name = '';
    for (const k of nameKeys) { if (f[k] != null && f[k] !== '') { name = String(f[k]); break; } }
    if (!name) name = '(bez názvu)';
    return {
      __name: name,
      __spend: f.spend,
      __roas_real: f.roas_real != null ? f.roas_real : f.roasReal,
      __roas_model: f.roas_model != null ? f.roas_model : f.roasModel,
      __trend: f.trend_cps != null ? f.trend_cps : f.trend,
      __leads: f.leads,
      __bookings: f.bookings,
      __cps: f.cpa != null ? f.cpa : f.cps,   // D3/#27: server posílá obojí, `cpa` je nové jméno
      __cpl: f.cpl,
      __anom: null,
      // A4: syrový řádek ze serveru → zralostOf() si z něj vezme pct_call/pct_schuzek
      // (nebo called/leads + passed/bookings), až je api.php na funnelech/eventech pošle.
      __raw: f,
    };
  }
  /* --- G2: CO JE „NOVÁ KREATIVA" (shodně s newest.js) ----------------------
   * NÁLEZ (naostro 16. 7., okno 30 d, segment=new = 51 kreativ): api.php má DVA
   * PROTICHŮDNÉ konce téže množiny:
   *   • is_new   (co server do segmentu pustí) = MAX(created_time) přes ady ≥ dnes−10 d
   *                                              → „má aspoň jednu čerstvě nahranou reklamu"
   *   • age_days (co karta píše jako „stáří")  = MIN(created_time) → „kdy kód poprvé vyjel"
   * → 15 z 51 karet renderovalo doslovný nesmysl: „nová kreativa (spuštěná v posledních
   *   10 dnech) · stáří 260 d · už má první data (24 rez.)" (P-287-001, Z-019-004 219 d…).
   *   Není to nová kreativa, je to RE-UPLOAD starého kódu.
   * ŘEŠENÍ (stejné jako newest.js, ať Filip nevidí v sekci a ve wizardu jiný svět):
   *   „nová" = kód POPRVÉ vyjel v posledních NEW_ADS_DAYS dnech (age_days).
   *   Re-uploady NEZAHAZUJEME (server je za nové považuje a rozhodnout se o nich má),
   *   jen je oddělíme do vlastní skupiny s vysvětlením, ať se nesoudí jako nový test.
   * ⚠️ Client-side záplata. Správné místo je api.php (`is_new`) → viz report.
   * ------------------------------------------------------------------------ */
  function newAdsDays() {
    const v = (window.ADS && ADS.NEW_ADS_DAYS != null) ? num(ADS.NEW_ADS_DAYS) : null;
    return v || th('NEW_ADS_DAYS') || 10;
  }
  function isReupload(c) {
    const a = c.age_days;
    return a != null && num(a) > newAdsDays();
  }
  /** Nejnovější ad = kvůli němu server kreativu považuje za „novou". */
  function newestAdOf(c) {
    let best = '';
    (c.ads || []).forEach((a) => { if (a.created_time && a.created_time > best) best = a.created_time; });
    return best;
  }

  function scaleRows() {
    const list = W.data.winners || [];
    // scale-ready: preferuj příznak z API; fallback = truthy scale_ready
    const flagged = list.filter((c) => isScaleReady(c));
    return flagged.length ? flagged : []; // prázdné → empty-state s ack
  }
  function isScaleReady(c) {
    const v = c.scale_ready;
    if (v === true) return true;
    if (v === false || v == null || v === '' || v === 0 || v === '0') return false;
    const s = String(v).toLowerCase();
    if (s === 'no' || s === 'false' || s === 'wait') return false;
    return true; // '✓✓✓', 'ready', '1', '?' apod. → kandidát na review
  }

  /* ---------------------------------------------------------------------------
   * GRAFY (ECharts) — osa Y VŽDY od 0 (SPEC §5).
   * Filip u velkých grafů výslovně chtěl MÉNĚ ovládání („to už je moc halušek")
   * → tady žádný dataZoom, toolbox ani legenda: jedna čára, tooltip, hotovo.
   *
   * Životní cyklus: render() přepisuje celý panel přes innerHTML, což by instance
   * osiřely (leak + mrtvé canvasy). Proto: disposeCharts() PŘED přepisem a
   * mountCharts() po něm. Spec grafu se předává přes W.chartSpecs[id], ne přes
   * data-atribut (JSON s daty by nafoukl HTML a musel by se escapovat).
   * ------------------------------------------------------------------------ */
  const hasECharts = () => !!(window.echarts && window.echarts.init);
  let chartSeq = 0;
  /* Retry mountu grafů (viz mountCharts): JEDEN naplánovaný rAF na celý běh — nikdy
   * jeden na každý graf — plus strop pokusů, ať se z čekání na layout nestane lavina. */
  let mountRaf = 0;
  let mountTries = 0;
  const MOUNT_RETRY_MAX = 30;   // ~0,5 s při 60 fps; pak to vzdej (graf je nejspíš schovaný)

  function fmtByKind(kind, v) {
    if (v == null) return '—';
    if (kind === 'money') return F.money(v);
    if (kind === 'roas') return F.roas(v);
    return F.int(v);
  }

  /** Zaregistruje graf a vrátí HTML hostitele. spec = {type:'line'|'spark', …}. */
  function chartHost(spec, cls) {
    const id = 'hw-ch-' + (++chartSeq);
    W.chartSpecs[id] = spec;
    return '<div class="hw-canvas' + (cls ? ' ' + cls : '') + '" id="' + id + '"></div>';
  }

  function disposeCharts() {
    Object.keys(W.charts || {}).forEach((id) => {
      try { W.charts[id].dispose(); } catch (_) {}
    });
    W.charts = {};
    W.chartSpecs = {};
    chartSeq = 0;
    // Čekající retry patří k renderu, který se právě zahazuje → zruš ho a vynuluj
    // počítadlo, jinak by strop pokusů přetekl z minulého renderu do nového.
    if (mountRaf) { try { cancelAnimationFrame(mountRaf); } catch (_) {} mountRaf = 0; }
    mountTries = 0;
  }

  /* Mount grafů. `seq` = razítko renderu: ID se po disposeCharts() číslují znovu od 1,
   * takže zpožděný requestAnimationFrame z PŘEDCHOZÍHO renderu by jinak trefil stejné ID
   * v odpojeném panelu a založil instanci na mrtvém uzlu (leak). Razítko to utne. */
  function mountCharts(root, seq) {
    if (!W || !W.open) return;
    if (seq == null) seq = W.renderSeq;
    if (seq !== W.renderSeq) return;                 // mezitím proběhl další render → zahoď
    mountRaf = 0;                                    // čekající retry se právě spotřeboval
    let needRetry = false;
    Object.keys(W.chartSpecs).forEach((id) => {
      const host = (root || W.rootEl).querySelector('#' + id);
      if (!host || W.charts[id]) return;
      const spec = W.chartSpecs[id];
      if (!hasECharts()) { host.innerHTML = '<div class="hw-chart-msg">Graf se nenačetl (chybí ECharts).</div>'; return; }
      // ECharts na 0px šířku vykreslí prázdno → počkej na layout (panel se zrovna vkládá).
      if (!host.clientWidth) { needRetry = true; return; }
      let inst;
      try { inst = window.echarts.init(host); } catch (_) { return; }
      try { inst.setOption(chartOption(spec)); } catch (_) { try { inst.dispose(); } catch (__) {} return; }
      W.charts[id] = inst;
    });
    /* ⚠️ RETRY AŽ ZA SMYČKOU, A JEN JEDEN (do 26. 7. 2026 byl uvnitř forEach).
     * `return` ve forEach je `continue`, ne `break` — K grafů bez šířky tedy naplánovalo
     * K callbacků a KAŽDÝ z nich spustil celý mountCharts znovu → K^n callbacků za n snímků.
     * Graf ve složené kartě má display:none (css/wizard.css: .hw-card.is-collapsed .hw-chart),
     * takže clientWidth 0 NATRVALO → K = počet rozhodnutých karet a smyčka neměla konec.
     * Při psaní do poznámky se navíc nevolá render() (jen refreshChrome), takže razítko
     * `seq` lavinu neutlo a rostla dál. Naměřeno 227 000 callbacků za 12 s → zablokované
     * hlavní vlákno a „Page Unresponsive" v Chrome. Jeden retry na běh + strop to utíná. */
    if (needRetry && ++mountTries <= MOUNT_RETRY_MAX) {
      mountRaf = requestAnimationFrame(() => mountCharts(root, seq));
    }
  }

  function chartOption(spec) {
    const est = spec.estFrom;
    const dates = spec.dates || [];
    const kind = spec.kind || 'money';
    const isSpark = spec.type === 'spark';
    const color = spec.color || '#c99a2f';
    const label = spec.label || '';
    const weekly = !!spec.weekly;
    // Zóna „ještě to není dojeté" → šrafovaně, ať se z ní nesoudí:
    //   denní graf  = poslední ~3 dny, data dotékají (SPEC §2)
    //   týdenní     = běžící (neúplný) týden
    const markArea = (est != null && est >= 0 && est < dates.length)
      ? { silent: true, itemStyle: { color: 'rgba(180,165,130,.16)' },
          data: [[{ xAxis: dates[est] }, { xAxis: dates[dates.length - 1] }]] }
      : null;
    return {
      animation: false,
      grid: { left: isSpark ? 2 : 46, right: isSpark ? 2 : 8, top: isSpark ? 6 : 10, bottom: isSpark ? 2 : 22, containLabel: isSpark },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: '#fffdf9',
        borderColor: '#ece6dc',
        textStyle: { color: '#33302a', fontSize: 12 },
        // A5: „Týden od 6. 7.", NIKDY „7-6"
        formatter: (ps) => {
          const p = ps[0];
          if (!p) return '';
          const head = weekly ? czWeek(dates[p.dataIndex]) : czShort(dates[p.dataIndex]);
          const val = p.value == null ? '—' : fmtByKind(kind, p.value);
          const tail = (est != null && p.dataIndex >= est)
            ? '<br><span style="color:#a89f90">' + (weekly ? 'běžící týden — ještě není dojetý' : 'data ještě dotékají') + '</span>'
            : '';
          return '<b>' + esc(head) + '</b><br>' + esc(label) + ': <b>' + esc(val) + '</b>' + tail;
        },
      },
      xAxis: {
        type: 'category', data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: '#e9e2d5' } },
        axisTick: { show: false },
        axisLabel: isSpark ? { show: false } : {
          color: '#a89f90', fontSize: 10, hideOverlap: true,
          formatter: (v) => (weekly ? czShort(v) : czShort(v)),
        },
      },
      yAxis: {
        type: 'value',
        min: 0,                        // ⚠️ SPEC §5: osa Y VŽDY od 0 — jinak graf zveličí šum
        splitLine: { show: !isSpark, lineStyle: { color: '#f4efe6' } },
        axisLabel: isSpark ? { show: false } : {
          color: '#a89f90', fontSize: 10,
          formatter: (v) => (kind === 'roas' ? (Math.round(v * 10) / 10) : F.int(v)),
        },
      },
      series: [{
        type: 'line', name: label, data: spec.data || [],
        showSymbol: false, symbolSize: 5, smooth: false, connectNulls: false,
        lineStyle: { width: isSpark ? 1.6 : 2, color },
        itemStyle: { color },
        areaStyle: { color: spec.area || 'rgba(201,154,47,.10)' },
        markArea: markArea || undefined,
        // C3: u ROAS modelu JEDNA plošná break-even linka (2,0). Bez ní se z grafu nedá
        // číst to jediné, co Filip potřebuje vědět: jsme nad, nebo pod. U sparku ne —
        // tam by popisek přebil 58px vysoký graf (a sparky ROAS stejně nekreslí).
        markLine: (!isSpark && spec.breakeven != null) ? {
          silent: true, symbol: 'none',
          lineStyle: { color: '#b8322e', type: 'dashed', width: 1.2, opacity: .75 },
          // ⚠️ F.roas() UŽ „×" přidává (ADS.fmt.roas → „2,00×") → další by dalo „2,00××".
          label: { formatter: 'break-even ' + F.roas(spec.breakeven), position: 'insideStartTop',
                   color: '#b8322e', fontSize: 10, fontWeight: 700 },
          data: [{ yAxis: spec.breakeven }],
        } : undefined,
      }],
    };
  }

  /* Hlídka atribuce: sedí graf (timeseries) s čísly na kartě (overview)? Viz velký
   * komentář u analytické vrstvy — u malých funnelů se spend rozchází i o 90 %.
   * Vrací null (OK) nebo hlášku, kterou karta přizná. Kontroluje se jen na ADITIVNÍCH
   * metrikách (spend/leady/rezervace); u poměrových (CPL/CPA/ROAS) by součet nedával smysl. */
  function chartMismatch(series, days, cardVal, metricKey) {
    const m = metricDef(metricKey);
    if (!m.add || !series || cardVal == null) return null;
    const n = series.data.length;
    const w = days == null ? runDays() : days;
    if (n < w) return null;
    let s = 0;
    for (let i = n - w; i < n; i++) s += num(series.data[i]);
    const card = num(cardVal);
    if (card <= 0 || s <= 0) return null;
    const diff = Math.abs(s - card) / card;
    if (diff < CHART_MISMATCH_WARN) return null;
    return 'Graf sedí na tvar, ne na úroveň: za stejné okno ukazuje ' + fmtByKind(m.kind, s) +
      ', čísla nahoře ' + fmtByKind(m.kind, card) + '. Graf dělí spend podle hlavního funnelu kreativy, ' +
      'čísla podle podílu leadů — u malých funnelů se to rozejde. Rozhoduj podle čísel nahoře.';
  }

  /* ---------------------------------------------------------------------------
   * RENDER — hlavní
   * ------------------------------------------------------------------------ */
  function render() {
    if (!W || !W.open) return;
    const root = W.rootEl;
    /* ⚠️ F7/D2 — ZACHOVAT SCROLL (Filip 23. 7.: „když kliknu na ponechat nebo na kill, tak mě
     * to hodí nahoru… všude je vždycky pokliknutí na to tlačítko, to vyskočí nahoru. To nechcem.")
     * PŘÍČINA: render() přestaví celý panel od nuly (root.innerHTML = '' níž), takže scroll
     * kontejner #hw-body zanikne i s pozicí → prohlížeč začne od 0. Nebyl to chybějící
     * preventDefault (jsou to <button>, ne odkazy).
     * OPRAVA JE TADY, NE V HANDLERECH: render() volá každé rozhodnutí (keep, kill, setFE,
     * setScale, setNewest, bulk potvrzení) — opravit to na jednom místě pokryje všechna
     * tlačítka najednou a nemůže na to zapomenout ani nový handler.
     * ⚠️ Krok se tím NEROZBIJE: goTo() volá scrollTop() AŽ PO render(), takže přepnutí
     * kroku dál poctivě začíná nahoře. */
    const prevScroll = (() => {
      const b = root.querySelector('#hw-body');
      return b ? b.scrollTop : 0;
    })();
    // Zachovej případný otevřený confirm dialog
    const openConfirm = root.querySelector('.hw-confirm');
    W.renderSeq = (W.renderSeq || 0) + 1;
    disposeCharts();          // instance ECharts musí pryč PŘED přepsáním DOM (jinak leak)
    hideHoverPop();
    hideTextPop();            // N7 popup visí na <body> → po přepsání panelu by osiřel viditelný
    root.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'hw-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = headHTML() + stepsHTML() + '<div class="hw-body" id="hw-body">' + bodyHTML() + '</div>' + footHTML();
    root.appendChild(panel);
    if (openConfirm) root.appendChild(openConfirm);
    // F7/D2: vrátit scroll HNED po vložení do DOM (před mountCharts) — jinak by uživatel
    // stihl vidět skok nahoru. Clamp na scrollHeight řeší případ, kdy se tělo zkrátilo
    // (např. karta se po rozhodnutí kolapsla a původní pozice už neexistuje).
    const bodyEl = panel.querySelector('#hw-body');
    if (bodyEl && prevScroll > 0) {
      bodyEl.scrollTop = Math.min(prevScroll, Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight));
    }
    wireEvents(panel);
    mountCharts(panel);
    applyFocus();
  }

  /* J2: po skoku ze souhrnu doscrollovat na konkrétní kartu a bliknout na ni,
   * ať uživatel nehledá, co po něm chceme. */
  function applyFocus() {
    const sel = W.focus;
    if (!sel) return;
    W.focus = null;
    setTimeout(() => {
      if (!W || !W.rootEl) return;
      const el = W.rootEl.querySelector(sel);
      if (!el) return;
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
      const card = el.closest('.hw-card, .hw-ack') || el;
      card.classList.add('hw-flash');
      setTimeout(() => card.classList.remove('hw-flash'), 2400);
    }, 40);
  }

  // J1: skok na libovolný krok (progress bar / Další / Zpět / odkaz ze souhrnu)
  function goTo(i, focusSel) {
    if (!W || i < 0 || i >= W.steps.length) return;
    W.idx = i;
    W.focus = focusSel || null;
    loadForCurrentStep();
    render();
    if (!focusSel) scrollTop();
  }

  function headHTML() {
    const p = W.period;
    const tabLabel = 'Reklamy';
    const sub =
      'Období ' + esc(F.date(p.from)) + ' – ' + esc(F.date(p.to)) +
      ' · ' + esc(tabLabel) + ' · ' + esc(p.who);
    return (
      '<div class="hw-head">' +
      '<span class="hw-badge">Denní check</span>' +
      '<div><h3 class="hw-title">Denní kontrola reklam</h3><div class="hw-sub">' + sub +
      '<span class="hw-savechip is-' + esc(W.saveState.status) + '" id="hw-savechip">' + saveChipInner() + '</span>' +
      '</div></div>' +
      '<button class="hw-x" id="hw-close" title="Zavřít" aria-label="Zavřít">×</button>' +
      '</div>'
    );
  }

  /* --- J4: indikátor průběžného ukládání ---------------------------------- */
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  function saveChipInner() {
    const s = W.saveState || { status: 'idle' };
    if (s.status === 'saving') return '<span class="hw-spin"></span> Ukládám…';
    if (s.status === 'pending') return '● Neuloženo';
    if (s.status === 'saved') return '✓ Uloženo' + (s.at ? ' ' + esc(hhmm(s.at)) : '');
    if (s.status === 'error') return '⚠ Neuloženo';
    return '○ Rozpracované se ukládá průběžně';
  }
  function setSaveStatus(status, err) {
    if (!W) return;
    const prevAt = (W.saveState && W.saveState.at) || null;
    W.saveState = { status, at: status === 'saved' ? new Date() : prevAt, err: err || null };
    // Chip patchujeme přímo do DOM (ne render()) — jinak by při psaní poznámky ulétl focus.
    const chip = W.rootEl && W.rootEl.querySelector('#hw-savechip');
    if (chip) {
      chip.className = 'hw-savechip is-' + status;
      chip.innerHTML = saveChipInner();
      chip.title = status === 'error' ? ('Uložení selhalo: ' + (err || '')) : '';
    }
  }

  // J1: každý krok je tlačítko → proklikat se dá KAMKOLI, i na nesplněné.
  // Nesplněné se jen označí (žlutá tečka „!"), nikdy neblokují navigaci.
  function stepsHTML() {
    let h = '<div class="hw-steps" role="tablist">';
    W.steps.forEach((s, i) => {
      const st = stepState(s.key);
      const cls = 'hw-stepbtn is-' + st + (i === W.idx ? ' is-active' : '');
      const dot = st === 'done' ? '✓' : (st === 'todo' ? '!' : (st === 'error' ? '⚠' : String(i + 1)));
      const n = st === 'todo' ? stepIssues(s.key).filter((x) => x.kind === 'item').length : 0;
      const tip = {
        done: 'Hotovo',
        todo: (s.key === 'summary' ? 'Chybí dokončit rozhodnutí v předchozích krocích' : 'Nevyřešeno: ' + n),
        error: 'Data se nenačetla',
        loading: 'Načítám data…',
      }[st] || '';
      h += '<button type="button" class="' + cls + '" data-goto="' + i + '" role="tab"' +
        ' aria-selected="' + (i === W.idx ? 'true' : 'false') + '" title="' + esc(s.label + ' — ' + tip) + '">' +
        '<span class="hw-dot">' + dot + '</span>' + esc(s.label) +
        (n ? '<span class="hw-stepn">' + F.int(n) + '</span>' : '') +
        '</button>';
    });
    h += '</div>';
    return h;
  }

  function bodyHTML() {
    const key = W.steps[W.idx].key;
    switch (key) {
      case 'kill': return renderKillStep();
      case 'funnels': return renderFEStep('funnels');
      case 'events': return renderFEStep('events');
      case 'scale': return renderScaleStep();
      case 'newest': return renderNewestStep();
      case 'summary': return renderSummaryStep();
      default: return '';
    }
  }

  // Univerzální stavové bloky
  function loadingBlock(msg) {
    return '<div class="hw-state"><div class="hw-loader"></div><p>' + esc(msg || 'Načítám data…') + '</p></div>';
  }
  function errorBlock(msg, retryStep) {
    return (
      '<div class="hw-state"><div class="hw-emoji">⚠️</div>' +
      '<h4>Data se nenačetla</h4><p>' + esc(msg || '') + '</p>' +
      '<button class="hw-btn hw-btn-primary" data-retry="' + esc(retryStep) + '">Zkusit znovu</button></div>'
    );
  }

  /* ---------------------------------------------------------------------------
   * „PROČ" bloky — u KAŽDÉ karty musí být vidět, které pravidlo/práh se spustil.
   * Bez toho nemá odmítnutí (a tím ani feedback smyčka) o čem vypovídat (SPEC §5).
   * Slugy pravidel berou ze serveru (kill_rule/kill_rules, anomalies[].rule).
   * ------------------------------------------------------------------------ */
  function rulesOf(c) {
    if (Array.isArray(c.kill_rules) && c.kill_rules.length) return c.kill_rules.filter(Boolean).map(String);
    return c.kill_rule ? [String(c.kill_rule)] : [];
  }
  function ruleCodes(rules) {
    return rules.map((r) => '<code>' + esc(r) + '</code>').join(' + ');
  }
  function whyKill(c) {
    const rules = rulesOf(c);
    const layer = num(c.kill_layer);
    // N7: i tady jen KRÁTKÝ důvod — detail ze závorky visí na pillu (hover popup).
    // Dřív tu byla celá věta včetně závorky, takže karta nesla tentýž dlouhý text 2×.
    const rs = splitReason(c.kill_reason || KILL_LAYER[layer] || 'kill kandidát');
    let h = '<div class="hw-why"><b>Proč:</b> ' + esc(rs.short);
    if (rules.length) h += ' · pravidlo ' + ruleCodes(rules);
    if (layer) h += ' · vrstva <b>' + esc(String(layer)) + '</b>';
    if (c.in_grace) h += ' · <b>grace perioda</b> (kreativa je mladá — killuje se jen spend bez leadů)';
    if (c.age_days != null) h += ' · stáří ' + esc(F.int(c.age_days)) + ' d';
    if (c.maturity === 'young') h += ' · <b>mladá</b> (málo dat)';
    h += '</div>';
    return h;
  }
  function whyFE(bucket, r) {
    const a = r.__anom;
    if (a) {
      const dev = num(a.deviation);
      const pct = Math.round(dev * 100);
      const thr = th('ANOMALY_PCT');
      let h = '<div class="hw-why"><b>Proč:</b> anomálie ' + ruleCodes([String(a.rule || 'anomaly')]) + ' — ' +
        esc(String(a.metric || 'cpl').toUpperCase()) + ' včera ' + esc(F.money(a.yesterday)) +
        ' vs 7d medián ' + esc(F.money(a.median_7d)) +
        ' → <b>' + (pct > 0 ? '+' : '') + pct + ' %</b> ' + (dev > 0 ? '(dráž)' : '(levněji)');
      if (thr != null) h += ' · práh ' + esc(F.pct(thr));
      h += '</div>';
      return h;
    }
    return '<div class="hw-why"><b>Proč:</b> žádné pravidlo se nespustilo — rutinní kontrola výkonu ' +
      (bucket === 'funnels' ? 'funnelu' : 'eventu') + ' za období.</div>';
  }
  function whyScale(c) {
    const minBk = th('SCALE_MIN_BOOKINGS');
    const bits = [];
    bits.push('rezervace <b>' + esc(F.int(c.bookings)) + '</b>' + (minBk != null ? ' ≥ ' + esc(F.int(minBk)) : ''));
    if (num(c.benchmark_cps) > 0) {
      bits.push('CPA <b>' + esc(F.money(cpaOf(c))) + '</b> ≤ medián funnelu ' + esc(F.money(c.benchmark_cps)));
    }
    let h = '<div class="hw-why"><b>Proč:</b> pravidlo ' + ruleCodes(['scale_ready']) + ' — ' + bits.join(' · ');
    if (c.scale_third_unknown) h += ' · <b>?</b> poslední škálování neznáme (v1)';
    h += '</div>';
    return h;
  }
  /* G2: dvě různé věty pro dvě různé věci — nikdy nesmí vzniknout
   * „nová (posledních 10 dnech) · stáří 260 d". Buď je to nová kreativa, nebo re-upload. */
  function whyNewest(c) {
    const days = newAdsDays();
    const reup = isReupload(c);
    let h = '<div class="hw-why"><b>Proč:</b> ';
    if (reup) {
      h += '<b>není to nová kreativa</b> — kód poprvé vyjel před ' + esc(F.int(c.age_days)) + ' dny' +
        (newestAdOf(c) ? ' (' + esc(F.date(String(newestAdOf(c)).slice(0, 10))) + ' mu někdo nahrál další reklamu se stejným kódem → server ho pustil mezi nové)' : '') +
        ' · čísla jsou za <b>celou historii kódu</b>, ne za nový test';
    } else {
      h += 'nová kreativa — kód poprvé vyjel v posledních ' + esc(F.int(days)) + ' dnech';
      if (c.age_days != null) h += ' (stáří ' + esc(F.int(c.age_days)) + ' d)';
    }
    h += num(c.bookings) < 1
      ? ' · zatím <b>0 rezervací</b> → čekáme data, nekillovat'
      : ' · už má první data (' + esc(F.int(c.bookings)) + ' rez.)';
    h += '</div>';
    return h;
  }

  /* ----- Krok 1: Kill kandidáti ------------------------------------------- */
  function renderKillStep() {
    if (W.load.kill === 'loading' || W.load.kill === 'idle') return stepTitle('kill') + loadingBlock('Hledám kill kandidáty…');
    if (W.load.kill === 'error') return stepTitle('kill') + errorBlock(W.err.kill, 'kill');
    const list = W.data.kill || [];
    if (!list.length) {
      return stepTitle('kill') +
        '<div class="hw-state"><div class="hw-emoji">🎉</div><h4>Žádní kandidáti na kill</h4>' +
        '<p>V tomto období nesplňuje žádná kreativa kill vrstvy 1–4. Můžeš pokračovat dál.</p></div>';
    }
    let h = stepTitle('kill');
    list.forEach((c) => { h += killCard(c); });
    return h;
  }

  function killCard(c) {
    const key = cKeyOf(c);
    const d = W.dec.kill[key] || {};
    const resolved = killResolved(key);
    const killed = d.decision === 'kill' && d.result === 'ok';
    let cls = 'hw-card';
    if (killed) cls += ' is-killed';
    else if (resolved) cls += ' is-resolved';
    // F7/D3: vyřešená karta se složí na řádek (miniatura + název + odznak)
    if (isCollapsed('kill', key, resolved)) cls += ' is-collapsed';
    const badge = !resolved ? ''
      : doneBadge(killed ? '⏸ Vypnuto' : '✓ Ponecháno', killed ? 'is-kill' : 'is-keep');

    const layer = num(c.kill_layer);
    const reason = c.kill_reason || (KILL_LAYER[layer] || 'Kill kandidát');

    // N7: pill nese jen krátký důvod, detail (vzorek, ROAS, práh) je v popupu na hover.
    const rs = splitReason(reason);
    let h = '<div class="' + cls + '" data-ckey="' + esc(key) + '">';
    h += '<div class="hw-crow">';
    h += thumbHTML(c);
    h += '<div class="hw-cmain">';
    h += '<div class="hw-cname">' + esc(key) +
      (c.funnel ? ' <span class="hw-chip hw-chip-funnel">' + esc(c.funnel) + '</span>' : '') +
      ' <span class="hw-chip hw-chip-layer' + (rs.detail ? ' hw-haspop' : '') + '"' +
        (rs.detail ? ' data-why="' + esc(key) + '"' : '') + '>Vrstva ' + (layer || '?') + ' · ' + esc(rs.short) +
        (rs.detail ? '<span class="hw-i">?</span>' : '') + '</span>' +
      (c.dopocet_warn ? ' <span class="hw-chip hw-chip-warn">⚠︎ velký dopočet ' + esc(F.pct(num(c.dopocet_pct))) + '</span>' : '') +
      badge +
      '</div>';
    const copy = sampleCopy(c);
    if (copy) h += '<div class="hw-copy">' + esc(copy) + '</div>';
    // metriky – „spálené peníze" napřed.
    // D5/D7: TRŽBY na kartě jsou povinné — bez nich Filip nevidí, že kandidát na kill
    // má 8× ROAS a jen drahý lead (přesně nález #1: P-860-001, ROAS 8,3×, tržba 53 500 Kč,
    // padal na kill kvůli CPL 645). Tabulky to mají, wizard to neměl.
    h += '<div class="hw-metrics">';
    h += metric('Spend', F.money(c.spend), 'hw-burn');
    if (isEar()) {
      h += metric('Poptávky', F.int(c.leads));
      h += metric('Rezervace', F.int(c.bookings));
      h += metric('CPA', cpaOf(c) != null ? F.money(cpaOf(c)) : '—');
      h += metric('Tržba zaplaceno', F.money(c.revenue_real));
      h += metric('Tržba celkem', F.money(c.revenue_created));
    } else {
      h += metric('Leady', F.int(c.leads));
      h += metric('Rezervace', F.int(c.bookings));
      h += metric('CPA', cpaOf(c) != null ? F.money(cpaOf(c)) : '—');
      h += metric('CPL', c.cpl != null ? F.money(c.cpl) : '—');
      h += metric('Tržby', F.money(c.revenue_real));
      h += metricRaw('ROAS real', F.roas(c.roas_real));
    }
    h += metricRaw(decisionRoasLabel(), roasPill(c));
    h += zralostMetric(c);   // A4: hned vedle ROAS — kolik % té tržby je vůbec reálné
    h += metricRaw('Trend CPA', trendCell(c.trend_cps));
    h += '</div>';
    h += '</div></div>'; // cmain / crow
    h += whyKill(c);     // PROČ = které pravidlo/práh se spustil

    // rozhodovací pruh
    h += '<div class="hw-decide">';
    if (killed) {
      h += '<span class="hw-killstate ok">⏸ Vypnuto (' + F.int((d.ad_ids || []).length) + ' reklam)</span>';
      h += adsManagerLinks(c);
    } else if (d.running) {
      h += '<span class="hw-killstate run"><span class="hw-spin"></span> Vypínám v Meta… čekám na potvrzení</span>';
    } else {
      const keepOn = d.decision === 'keep';
      h += '<div class="hw-seg">' +
        '<button class="hw-segbtn is-kill" data-kill-do="' + esc(key) + '">🔴 Kill</button>' +
        '<button class="hw-segbtn is-keep' + (keepOn ? ' is-on' : '') + '" data-keep="' + esc(key) + '">Ponechat</button>' +
        '</div>';
      if (d.result === 'partial') {
        h += '<span class="hw-killstate partial">Část se nevypnula (' + F.int((d.failed || []).length) + ') — </span>' +
          '<button class="hw-segbtn is-kill" data-kill-do="' + esc(key) + '">Zkusit znovu</button>';
      }
      if (keepOn) {
        h += '<select class="hw-select" data-keep-reason="' + esc(key) + '">' +
          '<option value="">— důvod ponechání —</option>' +
          reasonOption('mlada', d.reason) +
          reasonOption('cekam', d.reason) +
          reasonOption('strategicka', d.reason) +
          reasonOption('jine', d.reason) +
          '</select>';
      }
    }
    h += '</div>';

    if (d.decision === 'keep') {
      const req = d.reason === 'jine';
      h += '<textarea class="hw-note' + (req ? ' is-required' : '') + '" data-keep-note="' + esc(key) + '" ' +
        'placeholder="' + (req ? 'Doplň důvod (povinné u „Jiné")' : 'Poznámka (nepovinná)') + '">' +
        esc(d.note || '') + '</textarea>';
    }
    h += '</div>'; // card
    return h;
  }
  function reasonOption(val, cur) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + esc(keepReasonLabel[val]) + '</option>';
  }

  /* ----- Kroky 2/3: Funnely / Eventy --------------------------------------
   * H4/H5: u každého funnelu/eventu graf vývoje po dnech za ~3 měsíce
   *        + tlačítka 14/30/60 dní, která přepočítají čísla nahoře.
   * H5:    navíc filtr podle funnelu (Vše / Snubní / Zásnubní / 100K / Maledivy…).
   *
   * Ovládání je na ÚROVNI KROKU, ne u každé karty: Filip u grafů výslovně chtěl
   * MÉNĚ ovládacích prvků („to už je moc halušek", „musíš to zjednodušit").
   * Deset karet × šest chipů by bylo přesně to, co nechce.
   * ------------------------------------------------------------------------ */
  function renderFEStep(bucket) {
    if (W.load.overview === 'loading' || W.load.overview === 'idle') return stepTitle(bucket) + loadingBlock('Načítám přehled…');
    if (W.load.overview === 'error') return stepTitle(bucket) + errorBlock(W.err.overview, bucket === 'funnels' ? 'funnels' : 'events');
    const rows = bucket === 'funnels' ? funnelRows() : eventRows();
    if (!rows.length) {
      return stepTitle(bucket) +
        '<div class="hw-state"><div class="hw-emoji">📭</div><h4>Žádná data</h4>' +
        '<p>Pro toto období nejsou k dispozici žádné řádky. Pokračuj dál.</p></div>';
    }
    let h = stepTitle(bucket) + feControlsHTML(bucket, rows);
    rows.forEach((r) => { h += feCard(bucket, r); });
    return h;
  }

  /** Ovládací lišta kroku: okno pro čísla · metrika grafu · (jen eventy) filtr funnelu. */
  function feControlsHTML(bucket, rows) {
    const v = W.view[bucket];
    let h = '<div class="hw-ctl">';

    // Okno pro ČÍSLA (H4: „tlačítka 14/30/60 dní, která přepočítají čísla nahoře")
    h += '<div class="hw-ctlrow"><span class="hw-ctllbl">Čísla za</span><span class="hw-chips">';
    windowOptions().forEach((o) => {
      // v.days == null = „okno běhu" → zvýrazni chip označený jako běh (ať už je to
      // vlastní chip „Okno běhu · N dní", nebo shodou okolností rovnou 14/30/60).
      const on = (v.days === o.days) || (v.days == null && o.run);
      h += '<button type="button" class="hw-chipbtn' + (on ? ' is-on' : '') + '" ' +
        'data-fe-win="' + esc(bucket) + '|' + (o.days == null ? '' : o.days) + '">' + esc(o.label) +
        (o.run ? '<span class="n">běh</span>' : '') + '</button>';
    });
    h += '</span></div>';

    // Metrika grafu (společná pro celý krok)
    // F7/D4: graf sleduje okno zvolené výš → pevné „90 dní" v popisku by lhalo
    h += '<div class="hw-ctlrow"><span class="hw-ctllbl">Metrika grafu</span><span class="hw-chips">';
    CHART_METRICS.forEach((m) => {
      if (isEar() && m.k === 'cpl') return;   // K1: náušnice CPL nemají
      h += '<button type="button" class="hw-chipbtn' + (v.metric === m.k ? ' is-on' : '') + '" ' +
        'data-fe-met="' + esc(bucket) + '|' + esc(m.k) + '">' + esc(m.label) + '</button>';
    });
    h += '</span></div>';

    // H5: filtr podle funnelu — jen u eventů (funnely samy filtrovat nedává smysl)
    if (bucket === 'events') {
      const fs = feFunnelChoices();
      h += '<div class="hw-ctlrow"><span class="hw-ctllbl">Funnel</span><span class="hw-chips">';
      h += '<button type="button" class="hw-chipbtn' + (v.funnel === '' ? ' is-on' : '') + '" data-fe-fun="">Vše</button>';
      fs.forEach((f) => {
        h += '<button type="button" class="hw-chipbtn' + (v.funnel === f ? ' is-on' : '') + '" ' +
          'data-fe-fun="' + esc(f) + '">' + esc(f) + '</button>';
      });
      h += '</span></div>';
      if (v.funnel) {
        // ⚠️ Filtr je ANALYTICKÁ LUPA, ne výběr toho, o čem se rozhoduje. Rozhodnout se musí
        // o KAŽDÉM eventu období běhu — jinak by schování karty tiše odemklo dokončení běhu.
        const unresolved = rows.filter((r) => !fRowResolved('events', r.__name)).length;
        h += '<div class="hw-filtnote">Filtr <b>' + esc(v.funnel) + '</b>: čísla i grafy na kartách jsou ' +
          'jen za tenhle funnel. Rozhodnout je pořád potřeba u všech eventů' +
          (unresolved ? ' — zbývá ' + F.int(unresolved) + '.' : ' — hotovo.') + '</div>';
      }
    }
    h += '</div>';
    return h;
  }

  /** Funnely do filtru: co reálně je v období běhu (ne celý config — ať tam nejsou mrtvé). */
  function feFunnelChoices() {
    const rows = funnelRows()
      .filter((r) => r.__name && r.__name !== '---' && num(r.__spend) > 0)
      .sort((a, b) => num(b.__spend) - num(a.__spend));
    return rows.map((r) => r.__name);
  }

  /* Čísla karty za zvolené okno (+ u eventů případně uvnitř funnelu).
   * Vrací {status, row} — row má stejná pole jako decorateFE (__spend, __cpl, …).
   * ⚠️ AUTORITA zůstává `r` z období běhu (drží rozhodnutí i snapshot do feedbacku);
   *    tohle je jen to, co Filip zrovna vidí. */
  function feView(bucket, r) {
    const v = W.view[bucket];
    const runWin = v.days == null;

    if (bucket === 'events' && v.funnel) {
      const slot = ensureEventsInFunnel(v.funnel, v.days);
      if (slot.status !== 'ok') return { status: slot.status, err: slot.err, row: null };
      const e = slot.data[r.__name];
      if (!e || e._empty) return { status: 'empty', row: null };
      return { status: 'ok', row: {
        __name: r.__name, __spend: e.spend, __cpl: e.cpl, __cps: e.cpa, __leads: e.leads,
        __bookings: e.bookings, __roas_real: e.roas_real, __roas_model: e.roas_model,
        __trend: null, __raw: null,
      } };
    }
    if (runWin) return { status: 'ok', row: r };

    const slot = ensureWindowOverview(v.days);
    if (slot.status !== 'ok') return { status: slot.status, err: slot.err, row: null };
    const arr = normalizeArr(bucket === 'funnels' ? (slot.data.funnels || []) : (slot.data.events || []));
    const keys = bucket === 'funnels' ? ['funnel', 'name', 'label'] : ['event', 'name', 'optimization', 'label'];
    const hit = arr.map((x) => decorateFE(x, keys)).find((x) => x.__name === r.__name);
    if (!hit) return { status: 'empty', row: null };
    return { status: 'ok', row: hit };
  }

  function feCard(bucket, r) {
    const name = r.__name;
    const d = W.dec[bucket][name] || {};
    const resolved = fRowResolved(bucket, name);
    let cls = 'hw-card';
    if (d.decision === 'flag') cls += ' is-flag';
    else if (resolved) cls += ' is-resolved';
    // F7/D3 — kolaps platí i pro funnely/eventy (Filip: „ať už u fanelu nebo u té kreativy")
    if (isCollapsed(bucket, name, resolved)) cls += ' is-collapsed';
    const badge = !resolved ? ''
      : doneBadge(d.decision === 'flag' ? '⚑ Flag' : '✓ Potvrzeno', d.decision === 'flag' ? 'is-flag' : 'is-ok');

    const v = W.view[bucket];
    const view = feView(bucket, r);
    const vr = view.row;

    let h = '<div class="' + cls + '" data-fkey="' + esc(name) + '">';
    h += '<div class="hw-frow">';
    h += '<div class="hw-cmain" style="flex:1;min-width:200px">';
    h += '<div class="hw-cname">' + esc(name) +
      (r.__anom ? ' <span class="hw-chip hw-chip-layer">⚠︎ anomálie</span>' : '') +
      (v.days != null ? ' <span class="hw-chip hw-chip-reason">čísla za ' + F.int(v.days) + ' ' + esc(dayWord(v.days)) + '</span>' : '') +
      (bucket === 'events' && v.funnel ? ' <span class="hw-chip hw-chip-funnel">' + esc(v.funnel) + '</span>' : '') +
      badge +
      '</div>';
    if (view.status === 'loading') {
      h += '<div class="hw-chart-msg" style="text-align:left"><span class="hw-spin"></span> Přepočítávám čísla…</div>';
    } else if (view.status === 'error') {
      h += '<div class="hw-chartwarn">Čísla za tohle okno se nenačetla: ' + esc(view.err || '') + '</div>';
    } else if (view.status === 'empty' || !vr) {
      h += '<div class="hw-chart-msg" style="text-align:left">V tomhle okně' +
        (bucket === 'events' && v.funnel ? ' a funnelu' : '') + ' nemá žádná data.</div>';
    } else {
      h += '<div class="hw-metrics">';
      h += metric('Spend', vr.__spend != null ? F.money(vr.__spend) : '—');
      if (!isEar() && vr.__cpl != null) h += metric('CPL', F.money(vr.__cpl));
      if (vr.__leads != null) h += metric(isEar() ? 'Poptávky' : 'Leady', F.int(vr.__leads));
      if (vr.__bookings != null) h += metric('Rezervace', F.int(vr.__bookings));
      if (vr.__cps != null) h += metric('CPA', F.money(vr.__cps));   // D3/#27: CPS = staré jméno CPA
      h += metricRaw('ROAS real', vr.__roas_real != null ? F.roas(vr.__roas_real) : '—');
      h += metricRaw('ROAS model', vr.__roas_model != null
        ? '<span class="hw-sem ' + semClass(vr.__roas_model) + '">' + F.roas(vr.__roas_model) + '</span>' : '—');
      // A4: zralost i tady. Overview ji na funnelech/eventech POSÍLÁ (pct_call/pct_schuzek,
      // ověřeno naostro), takže v okně běhu i pod 14/30/60 vyjde číslo. Pod filtrem funnelu
      // (H5) se skládá z timeseries, kde provolanost není → „—" + tooltip, který řekne PROČ.
      h += zralostMetric(vr.__raw || {}, (bucket === 'events' && v.funnel) ? 'filter' : '');
      h += metricRaw('Trend CPA', trendCell(vr.__trend));
      h += '</div>';
    }
    h += '</div></div>';
    h += feChartHTML(bucket, r, vr);   // H4/H5: denní vývoj za ~3 měsíce
    h += whyFE(bucket, r);   // PROČ = anomálie (pravidlo + odchylka + práh), nebo rutinní kontrola

    // rozhodnutí Potvrzeno / Flag
    h += '<div class="hw-decide">';
    h += '<div class="hw-seg">' +
      '<button class="hw-segbtn is-ok' + (d.decision === 'ok' ? ' is-on' : '') + '" data-fe-ok="' + esc(bucket) + '|' + esc(name) + '">✓ Potvrdit</button>' +
      '<button class="hw-segbtn is-flag' + (d.decision === 'flag' ? ' is-on' : '') + '" data-fe-flag="' + esc(bucket) + '|' + esc(name) + '">⚑ Flag</button>' +
      '</div>';
    h += '</div>';
    if (d.decision === 'flag') {
      h += '<textarea class="hw-note is-required" data-fe-note="' + esc(bucket) + '|' + esc(name) + '" ' +
        'placeholder="Popiš anomálii / co je špatně (povinné)">' + esc(d.note || '') + '</textarea>';
    }
    h += '</div>';
    return h;
  }

  /* H4/H5: denní graf ~3 měsíce pod kartou funnelu/eventu. */
  function feChartHTML(bucket, r, viewRow) {
    const v = W.view[bucket];
    const m = metricDef(v.metric);
    const split = bucket === 'funnels' ? 'funnel' : 'event';
    const ff = bucket === 'events' ? v.funnel : '';
    // F7/D4: graf jede na STEJNÉM okně jako čísla nad ním (dřív natvrdo 90 dní)
    const slot = ensureTrend(split, m.k, ff, v.days);
    const wd = viewRange(v.days).days;   // kolik dní okno reálně má (null = okno běhu)

    let h = '<div class="hw-chart"><div class="hw-chart-head">' +
      '<span class="hw-chart-t">' + esc(m.label) + ' po dnech</span>' +
      '<span class="hw-chart-sub">posledních ' + F.int(wd) + ' ' + esc(dayWord(wd)) +
      (ff ? ' · jen ' + esc(ff) : '') + ' · osa od 0</span></div>';

    if (slot.status === 'loading') {
      h += '<div class="hw-chart-msg"><span class="hw-spin"></span> Načítám graf…</div></div>';
      return h;
    }
    if (slot.status === 'error') {
      h += '<div class="hw-chart-msg">Graf se nenačetl: ' + esc(slot.err || '') + '</div></div>';
      return h;
    }
    const s = trendSeries(slot, r.__name);
    if (!s || !s.dates.length || !s.data.some((x) => num(x) > 0)) {
      h += '<div class="hw-chart-msg">Za posledních ' + F.int(wd) + ' ' + esc(dayWord(wd)) + ' tu není co kreslit.</div></div>';
      return h;
    }
    h += chartHost({
      type: 'line', dates: s.dates,
      // 0 u poměrových metrik (CPL/CPA/ROAS) neznamená „nula Kč", ale „ten den nic neběželo"
      // → díra v čáře, ne pád na dno. U aditivních (spend/leady) je 0 pravdivá.
      data: m.add ? s.data.map((x) => num(x)) : s.data.map((x) => (num(x) > 0 ? num(x) : null)),
      estFrom: s.estFrom, kind: m.kind, label: m.label,
      breakeven: m.k === 'roas_model' ? breakevenRoas() : null,   // C3: jedna linka, jen u ROAS modelu
    });
    const warn = chartMismatch(s, v.days, viewRow ? viewRow.__spend : null, v.metric);
    if (warn) h += '<div class="hw-chartwarn">⚠︎ ' + esc(warn) + '</div>';
    h += '</div>';
    return h;
  }

  /* H6: mini grafy po týdnech u scale kandidáta — CPL · tržby · CPA.
   * Tři samostatné sparkliny místo jednoho grafu se třemi osami: CPL ~150 Kč,
   * CPA ~2 000 Kč a tržba ~50 000 Kč se do jedné osy nevejdou a dvě/tři osy jsou
   * přesně ty „halušky", které Filip u grafů odmítl. Každý má vlastní měřítko od 0. */
  function scaleSparksHTML(c) {
    const slot = ensureWeekly();
    if (slot.status === 'loading') {
      return '<div class="hw-sparks"><div class="hw-chart-msg" style="flex:1"><span class="hw-spin"></span> Načítám týdenní vývoj…</div></div>';
    }
    if (slot.status === 'error') {
      return '<div class="hw-sparks"><div class="hw-chart-msg" style="flex:1">Týdenní vývoj se nenačetl: ' + esc(slot.err || '') + '</div></div>';
    }
    const w = weeklyOf(cKeyOf(c));
    if (!w || !w.any) {
      return '<div class="hw-sparks"><div class="hw-chart-msg" style="flex:1">Za posledních ' + WEEK_COUNT +
        ' týdnů tu není co kreslit.</div></div>';
    }
    /* ⚠️ DVA RŮZNÉ DRUHY METRIKY → dva různé headliny. Oboje naměřeno naostro 16. 7.:
     *
     * CPL a CPA jsou SAZBY a platí hned → headline = poslední DOJETÝ týden. Z běžícího by
     *   se četl čtvrteční výsek (E-028-001: CPA 16 470 Kč ze dvou rezervací vs. 6 240 Kč
     *   za poslední celý týden).
     * TRŽBA ale ZAOSTÁVÁ: `ads_rings_daily.revenue_real` sedí na DATU LEADU, a lead dozraje
     *   přes návštěvu prodejny až za ~2–3 týdny. Naměřená řada L-158-001:
     *   [… 26 800 · 36 340 · 34 570 · 0 · 0] — poslední dva týdny jsou nula STRUKTURÁLNĚ,
     *   ne proto, že by kreativa přestala vydělávat. Headline „Tržby posl. týden = 0 Kč"
     *   by tedy hlásil nulu u KAŽDÉHO winnera. → u tržby ukazujeme SOUČET za zobrazené týdny
     *   (u L-158-001 = 97 710 Kč, tj. přesně `Tržby` na kartě) a nedojetý ocas se šrafuje.
     * Tohle NENÍ návrat časové zralosti jako ukazatele (A2) — je to jen mez, odkud se nedá
     * číst headline, a šrafování podle SPEC §2, které Filip u týdenního grafu sám schválil.
     */
    const cut = w.partialFrom >= 0 ? w.partialFrom : w.weeks.length;
    const lastDone = (arr) => { for (let i = cut - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    const sum = (arr) => arr.reduce((a, b) => a + num(b), 0);
    // od kterého týdne tržba ještě dozrává (konec týdne novější než maturity_full_days)
    const full = maturityFullDays();
    const ripeCut = shiftDays(W.period.to, -full);
    let revEst = w.weeks.findIndex((ws) => shiftDays(ws, 6) > ripeCut);
    if (revEst < 0) revEst = w.partialFrom;

    const specs = [
      { label: 'CPL', data: w.cpl, kind: 'money', color: '#5b7cc4', area: 'rgba(91,124,196,.10)',
        head: ' / posl. celý týden', val: lastDone(w.cpl), est: w.partialFrom },
      { label: 'Tržby', data: w.revenue, kind: 'money', color: '#1f8a54', area: 'rgba(31,138,84,.10)',
        head: ' / ' + w.weeks.length + ' týdnů', val: sum(w.revenue), est: revEst,
        note: 'Poslední ~' + full + ' dní tržba teprve dozrává (lead → prodejna) → pravý konec grafu klesá vždycky. ' +
              'Číslo vedle je součet za zobrazené týdny.' },
      { label: 'CPA', data: w.cpa, kind: 'money', color: '#c9701a', area: 'rgba(201,112,26,.10)',
        head: ' / posl. celý týden', val: lastDone(w.cpa), est: w.partialFrom },
    ].filter((s) => !(isEar() && s.label === 'CPL'));   // K1: náušnice CPL nemají

    let h = '<div class="hw-sparks">';
    specs.forEach((s) => {
      h += '<div class="hw-spark"' + (s.note ? ' title="' + esc(s.note) + '"' : '') + '>' +
        '<div class="hw-spark-h">' +
        '<span class="hw-spark-l">' + esc(s.label) + esc(s.head) + '</span>' +
        '<span class="hw-spark-v">' + esc(fmtByKind(s.kind, s.val)) + '</span></div>' +
        chartHost({ type: 'spark', weekly: true, dates: w.weeks, data: s.data, kind: s.kind,
                    label: s.label, color: s.color, area: s.area, estFrom: s.est }, 'is-mini');
      h += '</div>';
    });
    h += '</div>';
    return h;
  }
  /** Po kolika dnech je tržba „dojetá" — server posílá `maturity_full_days` (rings 14 / earrings 5).
   * ⚠️ ZÁMĚRNĚ NEsaháme na ADS.ripeness.FULL_AGE (= 56): to je stará „8týdenní" křivka, kterou
   * SPEC §1 i config označují za změřenou ŠPATNĚ (míchala různé kohorty) a Filip ji 16. 7.
   * přepsal na 14 dní. Fallback je proto config hodnota natvrdo, ne ta discreditovaná.
   * Používá se jen na hranici šrafování tržbového sparku, na žádný výpočet. */
  function maturityFullDays() {
    const th = (window.ADS && ADS.TH) || {};
    const src = (window.ADS && ADS.MATURITY_FULL_DAYS) || th.MATURITY_FULL_DAYS || null;
    const tab = W.period.tab;
    if (src && src[tab] != null) return num(src[tab]);
    if (typeof src === 'number' && src > 0) return num(src);
    return isEar() ? 5 : 14;
  }

  /* ----- Krok 4: Scale check ---------------------------------------------- */
  function renderScaleStep() {
    if (W.load.winners === 'loading' || W.load.winners === 'idle') return stepTitle('scale') + loadingBlock('Hledám scale-ready winnery…');
    if (W.load.winners === 'error') return stepTitle('scale') + errorBlock(W.err.winners, 'scale');
    const list = scaleRows();
    let h = stepTitle('scale') + scaleNoteHTML();
    if (!list.length) {
      const on = W.dec.scaleAck ? ' checked' : '';
      h += '<div class="hw-state"><div class="hw-emoji">🟢</div><h4>Žádný scale-ready winner</h4>' +
        '<p>Aktuálně žádná kreativa nesplňuje podmínky pro škálování (dost rezervací + CPA pod mediánem). To je v pořádku.</p></div>';
      h += '<label class="hw-ack"><input type="checkbox" data-scale-ack' + on + '>' +
        '<span class="t"><b>Beru na vědomí</b> — nikdo teď není připraven na škálování.</span></label>';
      return h;
    }
    list.forEach((c) => { h += scaleCard(c); });
    return h;
  }

  /* H7 — Filip: „To škálování něco dělá, nebo se musí v Ads Manageru?"
   * Odpověď: dashboard rozpočty MĚNIT NEUMÍ (v1 umí jen kill a reaktivaci, SPEC §7).
   * Krok je tedy DOPORUČENÍ + záznam rozhodnutí; navýšit rozpočet se musí v Ads Manageru.
   * Musí to říct nahlas na kartě, ať to Filip nehledá a hlavně ať nečeká, že „Škálovat"
   * něco provedlo — tichý no-op je u nástroje na 1,4 mil. Kč/měs. ta nejhorší varianta. */
  function scaleNoteHTML() {
    return '<div class="hw-scalenote"><span>ℹ️</span><span>' +
      '<b>Dashboard rozpočty nemění.</b> „Škálovat" = rozhodnutí se zapíše do běhu a feedbacku, ' +
      'ale <b>navýšit rozpočet musíš v Ads Manageru</b> — vypínat (kill) umí dashboard, škálovat ne. ' +
      'Odkaz „Otevřít v Meta ↗" je na každé kartě.</span></div>';
  }

  function scaleCard(c) {
    const key = cKeyOf(c);
    const d = W.dec.scale[key] || {};
    // „Počkat" bez důvodu NENÍ vyřešeno (Další je zablokované) → karta to musí ukázat,
    // jinak vypadá zeleně hotová a uživatel netuší, co ho drží.
    const resolved = scaleResolved(key);
    let cls = 'hw-card';
    if (d.decision === 'wait' && !resolved) cls += ' is-flag';
    else if (resolved) cls += ' is-resolved';
    // F7/D3 — vyřešená karta se složí na řádek (miniatura + název + odznak)
    if (isCollapsed('scale', key, resolved)) cls += ' is-collapsed';
    const badge = !resolved ? ''
      : doneBadge(d.decision === 'wait' ? '⏳ Počkat' : '🟢 Škálovat', d.decision === 'wait' ? 'is-flag' : 'is-ok');
    let h = '<div class="' + cls + '" data-skey="' + esc(key) + '">';
    h += '<div class="hw-crow">';
    h += thumbHTML(c);
    h += '<div class="hw-cmain">';
    h += '<div class="hw-cname">' + esc(key) +
      (c.funnel ? ' <span class="hw-chip hw-chip-funnel">' + esc(c.funnel) + '</span>' : '') +
      ' <span class="hw-chip hw-chip-scale">✓ scale-ready</span>' + badge + '</div>';
    const copy = sampleCopy(c);
    if (copy) h += '<div class="hw-copy">' + esc(copy) + '</div>';
    h += '<div class="hw-metrics">';
    h += metric('Spend', F.money(c.spend));
    h += metric('Rezervace', F.int(c.bookings));
    h += metric('CPA', cpaOf(c) != null ? F.money(cpaOf(c)) : '—');
    // Tržby i tady: škálovat se má podle toho, co reklama VYDĚLALA, ne jen podle CPA.
    h += metric(isEar() ? 'Tržba zaplaceno' : 'Tržby', F.money(c.revenue_real));
    h += metricRaw(decisionRoasLabel(), roasPill(c));
    h += zralostMetric(c);   // A4: škálovat podle ROAS dopočteného z 25 % je jiná sázka než z 90 %
    h += metricRaw('Trend CPA', trendCell(c.trend_cps));
    h += '</div></div></div>';
    h += scaleSparksHTML(c);   // H6: mini grafy po týdnech (CPL · tržby · CPA)
    h += whyScale(c);   // PROČ = pravidlo scale_ready + prahy
    h += '<div class="hw-decide">';
    h += '<div class="hw-seg">' +
      '<button class="hw-segbtn is-scale' + (d.decision === 'scale' ? ' is-on' : '') + '" data-scale="' + esc(key) + '">📈 Škálovat</button>' +
      '<button class="hw-segbtn is-wait' + (d.decision === 'wait' ? ' is-on' : '') + '" data-wait="' + esc(key) + '">⏳ Počkat</button>' +
      '</div>';
    // H7: rozpočet se navyšuje TADY, ne v dashboardu → odkaz musí být přímo u rozhodnutí.
    h += adsManagerLinks(c);
    h += '</div>';
    // SPEC §5: „Počkat" = odmítnutí doporučení → důvod POVINNÝ (bez něj Další nepustí dál).
    const waiting = d.decision === 'wait';
    h += '<textarea class="hw-note' + (waiting ? ' is-required' : '') + '" data-scale-note="' + esc(key) + '" ' +
      'placeholder="' + (waiting
        ? 'Proč počkat? Povinné — z důvodů se ladí nuance pravidel (scale-trap, sezóna, kapacita…)'
        : 'Poznámka (o kolik navýšit) — nepovinné') + '">' +
      esc(d.note || '') + '</textarea>';
    h += '</div>';
    return h;
  }

  /* ----- Krok 5: Nejnovější reklamy --------------------------------------- */
  function renderNewestStep() {
    if (W.load.newest === 'loading' || W.load.newest === 'idle') return stepTitle('newest') + loadingBlock('Načítám nejnovější reklamy…');
    if (W.load.newest === 'error') return stepTitle('newest') + errorBlock(W.err.newest, 'newest');
    const list = W.data.newest || [];
    let h = stepTitle('newest');
    // Prázdný seznam → není co rozhodovat, stačí ack (symetrie s krokem Scale check).
    if (!list.length) {
      const on = W.dec.newestAck ? ' checked' : '';
      h += '<div class="hw-state"><div class="hw-emoji">🆕</div><h4>Žádné nové reklamy</h4>' +
        '<p>V posledních dnech nepřibyla žádná nová kreativa. Potvrď a pokračuj.</p></div>';
      h += '<label class="hw-ack"><input type="checkbox" data-newest-ack' + on + '>' +
        '<span class="t"><b>Beru na vědomí</b> — žádné nové reklamy k prohlédnutí.</span></label>';
      return h;
    }
    // G2: nejdřív skutečně nové kreativy, pak re-uploady starých kódů (oddělené + vysvětlené).
    const fresh = list.filter((c) => !isReupload(c));
    const reups = list.filter((c) => isReupload(c));

    h += newestBulkHTML(list);
    if (fresh.length) {
      h += groupHeadHTML('🆕 Nové kreativy', fresh.length,
        'Kód poprvé vyjel v posledních ' + F.int(newAdsDays()) + ' dnech — tohle je opravdu nový test.');
      fresh.forEach((c) => { h += newestCard(c); });
    }
    if (reups.length) {
      h += groupHeadHTML('♻️ Není nová kreativa — re-upload', reups.length,
        'Starý kód, kterému někdo nahrál další reklamu → server ho pustil mezi „nové". ' +
        'Čísla jsou za celou historii kódu, ne za nový test — nesuď je jako rozjezd.');
      reups.forEach((c) => { h += newestCard(c); });
    }
    return h;
  }

  /* Hlavička skupiny uvnitř kroku (G2: nové vs. re-uploady). */
  function groupHeadHTML(title, n, note) {
    return '<div class="hw-group"><div class="hw-group-t">' + esc(title) +
      ' <span class="hw-group-n">' + F.int(n) + '</span></div>' +
      (note ? '<div class="hw-group-note">' + esc(note) + '</div>' : '') + '</div>';
  }

  /* --- „Potvrdit zbývající" (SPEC §5 krok 5: „potvrď PŘEHLED") --------------
   * Naostro je v segmentu 51 kreativ → s rozhodnutím po jedné by denní běh
   * nešel dokončit dřív než po 51 kliknutích (celkem 83 napříč kroky). SPEC ale
   * u tohohle kroku mluví o potvrzení PŘEHLEDU, ne o rozhodnutí u každé karty.
   * ⚠️ Gate to NEOSLABUJE: je to jedno VĚDOMÉ potvrzení = „přehled jsem viděl",
   *    zapíše se do feedbacku jako accept u každé položky (stejné řádky jako klik
   *    po jedné) a „⚑ Flag" s POVINNÝM důvodem zůstává u každé karty beze změny.
   *    Už rozhodnuté karty (včetně flagů) tlačítko nepřepisuje.
   * ------------------------------------------------------------------------ */
  function newestBulkHTML(list) {
    const rest = list.filter((c) => !W.dec.newest[cKeyOf(c)] || !W.dec.newest[cKeyOf(c)].decision);
    if (!rest.length) {
      return '<div class="hw-okbox">✅ <b>Přehled potvrzený</b> — všechny nové kreativy mají rozhodnutí.</div>';
    }
    return '<div class="hw-bulk"><div class="hw-bulk-t">Prohlédni si přehled a potvrď ho.</div>' +
      '<div class="hw-bulk-n">Co je špatně, flagni u konkrétní karty (důvod povinný) — zbytek potvrdíš jedním tlačítkem.</div>' +
      '<button type="button" class="hw-btn hw-btn-ok" data-newest-bulk>✓ Potvrdit zbývající (' + F.int(rest.length) + ')</button></div>';
  }

  function newestCard(c) {
    const key = cKeyOf(c);
    const d = W.dec.newest[key] || {};
    const resolved = newestResolved(key);
    const young = num(c.bookings) < 1;
    let cls = 'hw-card';
    if (d.decision === 'flag') cls += ' is-flag';
    else if (resolved) cls += ' is-resolved';
    const killed = d.decision === 'kill' && d.result === 'ok';   // F7/D6
    if (killed) cls += ' is-killed';
    // F7/D3 — vyřešená karta se složí na řádek (miniatura + název + odznak)
    if (isCollapsed('newest', key, resolved)) cls += ' is-collapsed';
    const badge = !resolved ? '' : doneBadge(
      d.decision === 'flag' ? '⚑ Flag' : d.decision === 'kill' ? '⏸ Vypnuto' : '✓ V pořádku',
      d.decision === 'flag' ? 'is-flag' : d.decision === 'kill' ? 'is-kill' : 'is-ok');

    let h = '<div class="' + cls + '" data-nkey="' + esc(key) + '">';
    h += '<div class="hw-crow">';
    h += thumbHTML(c);
    h += '<div class="hw-cmain">';
    h += '<div class="hw-cname">' + esc(key) +
      (c.funnel ? ' <span class="hw-chip hw-chip-funnel">' + esc(c.funnel) + '</span>' : '') +
      // G2: re-upload dostane vlastní štítek — „mladá / první data" by u 260denního kódu lhalo
      (isReupload(c) ? ' <span class="hw-chip hw-chip-warn">♻️ re-upload · stáří ' + esc(F.int(c.age_days)) + ' d</span>' : '') +
      (young ? ' <span class="hw-chip hw-chip-reason">mladá · čekáme data</span>'
             : ' <span class="hw-chip hw-chip-scale">první data</span>') + badge + '</div>';
    const copy = sampleCopy(c);
    if (copy) h += '<div class="hw-copy">' + esc(copy) + '</div>';
    h += '<div class="hw-metrics">';
    h += metric('Spend', F.money(c.spend));
    h += metric(isEar() ? 'Poptávky' : 'Leady', F.int(c.leads));
    h += metric('Rezervace', F.int(c.bookings));
    // K1: u náušnic CPL neexistuje → CPA (cena za rezervaci). U prstenů zůstává CPL i CPA.
    h += metric('CPA', cpaOf(c) != null ? F.money(cpaOf(c)) : '—');
    if (!isEar()) h += metric('CPL', c.cpl != null ? F.money(c.cpl) : '—');
    h += metric(isEar() ? 'Tržba zaplaceno' : 'Tržby', F.money(c.revenue_real));
    if (decisionRoas(c) != null) h += metricRaw(decisionRoasLabel(), roasPill(c));
    h += zralostMetric(c);   // A4: u čerstvé kreativy bývá nízká → ROAS se nedá brát vážně
    h += '</div></div></div>';
    h += whyNewest(c);   // PROČ = nová kreativa (NEW_ADS_DAYS) + stav dat

    // SPEC §5 krok 5: potvrď přehled (Přijmout) / flag + POVINNÝ důvod.
    h += '<div class="hw-decide">';
    h += '<div class="hw-seg">' +
      '<button class="hw-segbtn is-ok' + (d.decision === 'ok' ? ' is-on' : '') + '" data-new-ok="' + esc(key) + '">✓ V pořádku</button>' +
      '<button class="hw-segbtn is-flag' + (d.decision === 'flag' ? ' is-on' : '') + '" data-new-flag="' + esc(key) + '">⚑ Flag</button>' +
      // F7/D6: „kdy jí můžu rovnou zabít" — bez odskoku do tabulky nebo Ads Manageru
      (killed ? '' : '<button class="hw-segbtn is-kill" data-new-kill="' + esc(key) + '">🔴 Kill</button>') +
      '</div>';
    h += '</div>';
    if (d.decision === 'flag') {
      h += '<textarea class="hw-note is-required" data-new-note="' + esc(key) + '" ' +
        'placeholder="Co je s novou kreativou špatně? (povinné)">' + esc(d.note || '') + '</textarea>';
    }
    h += '</div>';
    return h;
  }

  /* ----- Krok 6: Souhrn ---------------------------------------------------- */
  // J2: NAHOŘE seznam chybějících rozhodnutí s odkazem (klik → skok na krok + kartu).
  // J3: dokud tenhle seznam není prázdný, „Dokončit a uložit" je zablokované (viz footHTML).
  function missingBoxHTML() {
    const miss = missingAll();
    if (!miss.length) {
      return '<div class="hw-okbox">✅ <b>Vše vyřešeno</b> — každé doporučení má rozhodnutí ' +
        'a každé odmítnutí důvod. Můžeš běh dokončit a uložit.</div>';
    }
    const items = miss.filter((m) => m.kind === 'item').length;
    const loading = miss.some((m) => m.kind === 'loading');
    const errors = miss.filter((m) => m.kind === 'error').length;
    let head = 'Chybí dokončit: ' + F.int(items) + ' ' + plural(items, 'položka', 'položky', 'položek');
    if (errors) head += ' · ' + F.int(errors) + '× nenačtená data';
    if (loading) head += ' · něco se ještě načítá';
    let h = '<div class="hw-missbox"><div class="hw-misshead">⚠️ ' + esc(head) + '</div>' +
      '<p class="hw-missnote">Běh nejde dokončit, dokud zbývá nevyřešené rozhodnutí — ' +
      'jinak by se do feedbacku uložila jen půlka dne. Klikni na položku a skočíš rovnou na ni.</p>';
    miss.forEach((m, i) => {
      h += '<button type="button" class="hw-missitem" data-miss="' + i + '">' +
        '<span class="hw-misstep">' + esc(m.stepLabel) + '</span>' +
        '<span class="hw-misslabel">' + esc(m.label) + '</span>' +
        '<span class="hw-misshint">' + esc(m.hint || '') + '</span>' +
        '<span class="hw-missgo">Přejít →</span></button>';
    });
    h += '</div>';
    return h;
  }
  function renderSummaryStep() {
    const s = collectSummary();
    let h = stepTitle('summary');
    h += missingBoxHTML();
    h += '<div class="hw-sumgrid">';
    h += sumTile(s.killed.length, 'Vypnuto reklam (kreativ)', 'kill');
    h += sumTile(s.kept.length, 'Ponecháno s důvodem', '');
    h += sumTile(s.flags.length, 'Flagnuto (funnely/eventy/nové)', 'flag');
    h += sumTile(s.scale.length, 'Ke škálování', 'scale');
    h += '</div>';

    if (s.killed.length) {
      h += '<div class="hw-sumsec"><h5>Vypnuté kreativy</h5>';
      s.killed.forEach((k) => {
        h += '<div class="hw-sumitem"><span class="k">🔴 ' + esc(k.creative) + '</span>' +
          '<span class="m">' + F.int(k.ad_ids.length) + ' reklam' + (k.result === 'partial' ? ' · část selhala' : '') + '</span></div>';
      });
      h += '</div>';
    }
    if (s.kept.length) {
      h += '<div class="hw-sumsec"><h5>Ponecháno</h5>';
      s.kept.forEach((k) => {
        h += '<div class="hw-sumitem"><span class="k">' + esc(k.creative) + '</span>' +
          '<span class="m">' + esc(keepReasonLabel[k.reason] || k.reason || '') +
          (k.note ? ' — ' + esc(k.note) : '') + '</span></div>';
      });
      h += '</div>';
    }
    if (s.flags.length) {
      h += '<div class="hw-sumsec"><h5>Flagnuté anomálie</h5>';
      s.flags.forEach((f) => {
        const bLabel = { funnels: 'funnel', events: 'event', newest: 'nová reklama' }[f.bucket] || f.bucket;
        h += '<div class="hw-sumitem"><span class="k">⚑ ' + esc(f.name) + '</span>' +
          '<span class="m">' + esc(bLabel) + (f.note ? ' — ' + esc(f.note) : '') + '</span></div>';
      });
      h += '</div>';
    }
    if (s.scale.length) {
      h += '<div class="hw-sumsec"><h5>Ke škálování</h5>';
      s.scale.forEach((c) => {
        h += '<div class="hw-sumitem"><span class="k">📈 ' + esc(c.creative) + '</span>' +
          '<span class="m">' + (c.note ? esc(c.note) : 'škálovat') + '</span></div>';
      });
      h += '</div>';
    }
    h += '<p class="hw-stepdesc" style="margin-top:6px">Kliknutím na <b>Dokončit a uložit</b> se běh uzavře (kdo/kdy/co) ' +
      'a banner denního checku pro dnešek zmizí. Rozpracovaný stav se ukládá průběžně — zavřením o nic nepřijdeš.</p>';
    return h;
  }

  function sumTile(n, label, mod) {
    return '<div class="hw-sumtile ' + (mod || '') + '"><div class="n">' + F.int(n) + '</div><div class="l">' + esc(label) + '</div></div>';
  }

  /* ---------------------------------------------------------------------------
   * Sběr souhrnu + steps_json payload
   * ------------------------------------------------------------------------ */
  function collectSummary() {
    const killed = [], kept = [];
    (W.data.kill || []).forEach((c) => {
      const key = cKeyOf(c);
      const d = W.dec.kill[key];
      if (!d) return;
      if (d.decision === 'kill' && (d.result === 'ok' || d.result === 'partial')) {
        killed.push({ creative: key, ad_ids: d.ad_ids || [], result: d.result });
      } else if (d.decision === 'keep') {
        kept.push({ creative: key, reason: d.reason, note: d.note || '' });
      }
    });
    const flags = [];
    ['funnels', 'events', 'newest'].forEach((bucket) => {
      Object.keys(W.dec[bucket] || {}).forEach((name) => {
        const d = W.dec[bucket][name];
        if (d && d.decision === 'flag') flags.push({ bucket, name, note: d.note || '' });
      });
    });
    const scale = [];
    Object.keys(W.dec.scale || {}).forEach((key) => {
      const d = W.dec.scale[key];
      if (d && d.decision === 'scale') scale.push({ creative: key, note: d.note || '' });
    });
    return { killed, kept, flags, scale };
  }

  // steps_json → ukládá se do ads_wizard_runs.steps_json (MEDIUMTEXT)
  // ⚠️ decision se NIKDY nedefaultuje na 'keep'/'ok' — steps_json je zároveň zdroj pro
  // obnovení rozpracovaného běhu (J4). Default by po návratu předvyplnil rozhodnutí,
  // která uživatel nikdy neudělal (a „ponecháno bez důvodu" by tiše prošlo jako hotové).
  // Prázdné decision = nerozhodnuto.
  function buildStepsJson(finished) {
    const steps = [];
    // 1) kill
    const killItems = (W.data.kill || []).map((c) => {
      const key = cKeyOf(c);
      const d = W.dec.kill[key] || {};
      return {
        creative: key, funnel: c.funnel || '', kill_layer: num(c.kill_layer),
        decision: d.decision || '',
        reason: d.reason || '', note: d.note || '',
        ad_ids: d.ad_ids || [], result: d.result || '',
        spend: num(c.spend), roas_model: num(c.roas_model),
      };
    });
    steps.push({ key: 'kill', decision: '', note: '', items: killItems });

    // 2/3 funnely + eventy (jen pokud jsou kroky přítomné)
    if (W.steps.some((s) => s.key === 'funnels')) {
      steps.push({
        key: 'funnels', decision: '', note: '',
        items: funnelRows().map((r) => {
          const d = W.dec.funnels[r.__name] || {};
          return { funnel: r.__name, decision: d.decision || '', note: d.note || '', spend: num(r.__spend), roas_model: num(r.__roas_model) };
        }),
      });
      steps.push({
        key: 'events', decision: '', note: '',
        items: eventRows().map((r) => {
          const d = W.dec.events[r.__name] || {};
          return { event: r.__name, decision: d.decision || '', note: d.note || '', spend: num(r.__spend), roas_model: num(r.__roas_model) };
        }),
      });
    }

    // 4) scale
    steps.push({
      key: 'scale', decision: W.dec.scaleAck ? 'none' : '', note: '',
      items: scaleRows().map((c) => {
        const key = cKeyOf(c);
        const d = W.dec.scale[key] || {};
        return { creative: key, decision: d.decision || '', note: d.note || '', bookings: num(c.bookings), cps: num(c.cps) };
      }),
    });

    // 5) newest — s kartami se rozhoduje per kreativa, ack je jen pro prázdný seznam
    steps.push({
      key: 'newest',
      decision: (W.data.newest || []).length ? 'reviewed' : (W.dec.newestAck ? 'confirmed' : ''),
      note: '',
      items: (W.data.newest || []).map((c) => {
        const d = W.dec.newest[cKeyOf(c)] || {};
        return {
          creative: cKeyOf(c), decision: d.decision || '', note: d.note || '',
          bookings: num(c.bookings), spend: num(c.spend),
        };
      }),
    });

    const s = collectSummary();
    steps.push({
      key: 'summary', decision: finished ? 'saved' : 'draft', note: '',
      items: [], counts: { killed: s.killed.length, kept: s.kept.length, flags: s.flags.length, scale: s.scale.length },
    });

    return {
      tab: W.period.tab, who: W.period.who,
      from: W.period.from, to: W.period.to,
      generated_at: new Date().toISOString(),
      finished: !!finished,          // draft vs. uzavřený běh (rozliší i offline čtení steps_json)
      missing: finished ? 0 : missingAll().filter((m) => m.kind === 'item').length,
      steps,
    };
  }

  /* ---------------------------------------------------------------------------
   * Malé HTML helpery
   * ------------------------------------------------------------------------ */
  function stepTitle(key) {
    const meta = {
      kill: ['🔴 Kill kandidáti', 'Projdi kreativy, které padly do kill vrstev 1–4 (řazeno spálené peníze). U každé rozhodni: <b>Kill</b> (vypne reklamy v Meta) nebo <b>Ponechat</b> s důvodem. Mezi kroky se můžeš pohybovat volně — nevyřešené položky jen blokují <b>dokončení</b> běhu.'],
      funnels: ['🔻 Zhodnocení funnelů', 'Přehled výkonu funnelů za období. U každého <b>Potvrď</b>, že sedí, nebo <b>Flagni</b> anomálii s poznámkou.'],
      events: ['🎯 Zhodnocení eventů / optimalizací', 'Výkon podle optimalizačního eventu. Stejná logika — Potvrdit nebo Flag + poznámka.'],
      scale: ['🟢 Scale check', 'Winneři připravení na škálování. U každého rozhodni <b>Škálovat</b> / <b>Počkat</b>. „Počkat" = odmítnutí doporučení → <b>důvod je povinný</b> (ladí se z něj nuance pravidel).'],
      newest: ['🆕 Nejnovější reklamy', 'Čerstvě spuštěné kreativy. U každé potvrď, že přehled sedí, nebo ji <b>flagni s povinným důvodem</b>.'],
      summary: ['✅ Souhrn dne', 'Rekapitulace všeho, co jsi právě rozhodl. Uložením se zaznamená disciplinovaný běh denního checku.'],
    }[key] || ['', ''];
    let counter = '';
    if (key === 'kill' && W.load.kill === 'ok') {
      const list = W.data.kill || [];
      const done = list.filter((c) => killResolved(cKeyOf(c))).length;
      counter = counterChip(done, list.length);
    } else if ((key === 'funnels' || key === 'events') && W.load.overview === 'ok') {
      const rows = key === 'funnels' ? funnelRows() : eventRows();
      const done = rows.filter((r) => fRowResolved(key, r.__name)).length;
      counter = counterChip(done, rows.length);
    } else if (key === 'scale' && W.load.winners === 'ok') {
      const rows = scaleRows();
      if (rows.length) {
        const done = rows.filter((c) => scaleResolved(cKeyOf(c))).length;
        counter = counterChip(done, rows.length);
      }
    } else if (key === 'newest' && W.load.newest === 'ok') {
      const rows = W.data.newest || [];
      if (rows.length) {
        const done = rows.filter((c) => newestResolved(cKeyOf(c))).length;
        counter = counterChip(done, rows.length);
      }
    }
    return '<h3 class="hw-steptitle">' + meta[0] + counter + '</h3><p class="hw-stepdesc">' + meta[1] + '</p>' +
      periodBarHTML(key);
  }

  /* --- H3: OBDOBÍ u KAŽDÉHO kroku -----------------------------------------
   * Filip: „chybí info, za jaké období to je (kill kandidáti jsou za měsíc)" →
   * „za jakou dobu to porovnáváme?". Explicitně, ne skrytě: od–do + počet dní
   * + jednou větou, co se za to okno počítá. Hlavička wizardu období sice nese,
   * ale je to malým písmem nahoře a u kill karet ho Filip nehledal.
   * ------------------------------------------------------------------------ */
  function periodBarHTML(key) {
    const p = W.period;
    const d = runDays();
    const note = {
      kill: 'Kill vrstvy 1–4 se počítají z tohohle okna — spend, leady i ROAS níž jsou za něj.',
      funnels: 'Výchozí okno běhu. Čísla na kartách přepneš tlačítky níž, graf ukazuje 90 dní.',
      events: 'Výchozí okno běhu. Čísla na kartách přepneš tlačítky níž, graf ukazuje 90 dní.',
      scale: 'Winneři a CPA jsou za tohle okno; mini grafy ukazují posledních ' + WEEK_COUNT + ' týdnů.',
      newest: 'Naměřená data nových kreativ jsou za tohle okno (kreativa přitom může být mladší).',
      summary: 'Celý běh se uloží s tímhle obdobím.',
    }[key] || '';
    return '<div class="hw-period"><span class="cal">📅</span>' +
      '<span>Období: <b>' + esc(F.date(p.from)) + ' – ' + esc(F.date(p.to)) + '</b></span>' +
      '<span class="hw-pdays">' + F.int(d) + ' ' + esc(dayWord(d)) + '</span>' +
      (note ? '<span class="hw-pnote">' + esc(note) + '</span>' : '') +
      '</div>';
  }
  function counterChip(done, total) {
    const ready = done >= total && total > 0;
    return ' <span class="hw-counter' + (ready ? ' is-ready' : '') + '">' + F.int(done) + ' / ' + F.int(total) + ' vyřešeno</span>';
  }

  /* ===========================================================================
   * F7/D3 — KOLAPS ROZHODNUTÉ KARTY
   * ---------------------------------------------------------------------------
   * Filip 23. 7.: „ve chvíli, kdy se u tý kreativy kill nebo ponechat klikne na jedno
   * z těch tlačítek, tak se to jakoby kolapsne a bude tam jenom název kreativy a malá
   * miniaturka, ať je to přehlednější, ať nezabírá tak vysokou část. (…) Jo, animovaně."
   *
   * DVĚ VĚCI, KTERÉ SE NESMÍ POPLÉST:
   *   • STAV kolapsu je ODVOZENÝ z „karta je vyřešená" (killResolved/fRowResolved/…),
   *     ne z DOM → přežije re-render a nemůže se rozejít s tím, co ukazuje progress bar.
   *   • ANIMACE běží na ŽIVÉM elementu PŘED render()em — render() DOM přestaví, takže
   *     přechod by po něm neměl na čem běžet a karta by jen cvakla.
   *
   * ⚠️ PROČ „vyřešená", a ne „kliknuté tlačítko": u „Ponechat" (chce důvod), „Flag"
   *    i „Počkat" (chtějí povinnou poznámku) by okamžitý kolaps SCHOVAL pole, které
   *    uživatel musí vyplnit → nešlo by dokončit krok. Takhle se karta složí až ve chvíli,
   *    kdy po uživateli nic dalšího nechceme.
   * ======================================================================== */
  const COLLAPSE_MS = 240;

  /** Má být karta složená? = je vyřešená a uživatel si ji ručně nerozbalil. */
  function isCollapsed(bucket, key, resolved) {
    // `W.expand || (…= {})` = pojistka: kdyby někdy vznikl W jinou cestou než freshState()
    // (obnovený draft apod.), kolaps se nesmí rozbít o chybějící pole.
    if (!W.expand) W.expand = {};
    return !!resolved && !W.expand[bucket + '|' + key];
  }
  /** Odznak rozhodnutí — v složeném stavu jediné, co kromě názvu a miniatury zbyde. */
  function doneBadge(txt, cls) {
    return '<span class="hw-done ' + (cls || '') + '">' + esc(txt) + '</span>';
  }
  /** Animovaně složit kartu a teprve potom překreslit (viz komentář výš). */
  function collapseAnim(sel, done) {
    const el = W.rootEl && W.rootEl.querySelector(sel);
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { /* starý prohlížeč */ }
    if (!el || reduce) { done(); return; }
    el.classList.add('is-collapsing');
    el.style.maxHeight = el.scrollHeight + 'px';
    void el.offsetHeight;                  // vynucený reflow — bez něj přechod nemá odkud vyjít
    el.style.maxHeight = '58px';
    el.style.opacity = '.92';
    setTimeout(done, COLLAPSE_MS);
  }
  /** Rozhodnutí uloženo → ulož draft a překresli; animuj JEN při přechodu na „vyřešeno". */
  function afterDecision(sel, wasResolved, isResolvedNow) {
    scheduleSave();
    if (!wasResolved && isResolvedNow) collapseAnim(sel, render);
    else render();
  }

  function metric(label, val, extra) {
    return '<span class="hw-metric ' + (extra || '') + '"><span>' + esc(label) + '</span><b>' + esc(val) + '</b></span>';
  }
  function metricRaw(label, valHtml) {
    return '<span class="hw-metric"><span>' + esc(label) + '</span><b>' + valHtml + '</b></span>';
  }

  /* --- H2: NÁHLED VE WIZARDU ------------------------------------------------
   * Filip: „když kliknu na ten obrázek, tak se nic nestane, ani když na něj najedu."
   * (Klik handler existoval, ale sahal na `data-preview` na <img>, který se při chybě
   * načtení sám přepsal na placeholder — a hover nebyl vůbec žádný.)
   * Teď stejně jako v tabulkách: hover → velký pop-up (thumbnail_big) · klik → modal.
   * data-preview drží WRAPPER, ne <img> → onerror obrázku nemůže handler odstřelit.
   * ------------------------------------------------------------------------ */
  function thumbHTML(c) {
    const ad = previewAd(c);
    const small = thumbOf(ad);
    const key = esc(cKeyOf(c));
    const inner = small
      ? '<img class="hw-thumb" src="' + esc(small) + '" alt="" ' +
        'onerror="this.classList.add(\'hw-ph\');this.removeAttribute(\'src\');this.textContent=\'🖼\';">'
      : '<div class="hw-thumb hw-ph">🖼</div>';
    // Bez jediného náhledu nemá cenu lákat na zvětšení → wrapper zůstane „mrtvý".
    const can = !!(ad && (small || thumbBigOf(ad)));
    return '<span class="hw-thumbwrap"' + (can ? ' data-preview="' + key + '" title="Klikni pro velký náhled"' : '') + '>' +
      inner + (can ? '<span class="hw-zoom">⤢</span>' : '') + '</span>';
  }

  /* Sdílený hover pop-up (jeden element na celý wizard, jako v tables.js). */
  let hoverPop = null;
  function getHoverPop() {
    if (!hoverPop || !hoverPop.parentNode) {
      hoverPop = document.createElement('div');
      hoverPop.className = 'hw-thumbpop';
      document.body.appendChild(hoverPop);
    }
    return hoverPop;
  }
  function hideHoverPop() {
    if (hoverPop) { hoverPop.classList.remove('show'); hoverPop.style.display = 'none'; }
  }
  function showHoverPop(c, anchor) {
    const ad = previewAd(c);
    const big = thumbBigOf(ad), small = thumbOf(ad);
    if (!big) return;
    const p = getHoverPop();
    p.innerHTML = '<img src="' + esc(big) + '" alt=""' +
      (small && small !== big ? ' onerror="this.onerror=null;this.src=' + esc(JSON.stringify(small)) + '"' : '') + '>';
    p.style.display = 'block';
    // Rozměry MUSÍ sedět s CSS `.hw-thumbpop img` (380 + 2×5 padding + 2×1 rámeček = 392),
    // jinak by se překlopení u pravého okraje počítalo ze špatné šířky.
    const r = anchor.getBoundingClientRect();
    const pw = 392, ph = 392;
    let left = r.right + 12, top = r.top - 16;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 12;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    if (top < 8) top = 8;
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    requestAnimationFrame(() => p.classList.add('show'));
  }
  /* N7: popup s detailem důvodu (hover na pillu). Vlastní element, ať se nervou
   * o pozici s náhledovým pop-upem (můžou být na obrazovce oba). */
  let textPop = null;
  function getTextPop() {
    if (!textPop || !textPop.parentNode) {
      textPop = document.createElement('div');
      textPop.className = 'hw-textpop';
      document.body.appendChild(textPop);
    }
    return textPop;
  }
  function hideTextPop() {
    if (textPop) { textPop.classList.remove('show'); textPop.style.display = 'none'; }
  }
  /** Popup: krátký důvod (nadpis) + detail ze závorky + pravidlo/vrstva. „Pár řádků", ne esej. */
  function showWhyPop(c, anchor) {
    const layer = num(c.kill_layer);
    const rs = splitReason(c.kill_reason || KILL_LAYER[layer] || '');
    if (!rs.detail) return;
    const rules = rulesOf(c);
    const p = getTextPop();
    p.innerHTML =
      '<div class="t">' + esc(rs.short) + '</div>' +
      '<div class="d">' + esc(rs.detail) + '</div>' +
      '<div class="m">' + (rules.length ? 'pravidlo ' + ruleCodes(rules) + ' · ' : '') +
      'vrstva <b>' + esc(String(layer || '?')) + '</b>' +
      (c.in_grace ? ' · <b>grace perioda</b>' : '') +
      (c.age_days != null ? ' · stáří ' + esc(F.int(c.age_days)) + ' d' : '') + '</div>';
    p.style.display = 'block';
    // Popup je nad pillem, ne vedle: pill bývá široký a u pravého okraje by se ulomil.
    const r = anchor.getBoundingClientRect();
    const pw = p.offsetWidth, ph = p.offsetHeight;
    let left = r.left, top = r.bottom + 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;   // nevejde se dolů → nad pill
    if (top < 8) top = 8;
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    requestAnimationFrame(() => p.classList.add('show'));
  }
  function sampleCopy(c) {
    const ad = previewAd(c);
    if (!ad) return '';
    return ad.copy_code || ad.ad_name || '';
  }
  function adsManagerLinks(c) {
    const ads = c.ads || [];
    if (!ads.length) return '';
    const first = ads[0];
    const link = first.adsmanager_link ||
      (first.ad_id ? 'https://www.facebook.com/adsmanager/manage/ads?act=842525630619928&selected_ad_ids=' + encodeURIComponent(first.ad_id) : '');
    if (!link) return '';
    return ' <a class="hw-linkbtn" href="' + esc(link) + '" target="_blank" rel="noopener">Otevřít v Meta ↗</a>';
  }

  function footHTML() {
    const key = W.steps[W.idx].key;
    const isLast = key === 'summary';
    const first = W.idx === 0;
    let h = '<div class="hw-foot">';
    // J1: Zpět/Další jsou VŽDY aktivní (Zpět jen na 1. kroku nemá kam) — nesplněný krok
    // navigaci neblokuje, jen se označí v progress baru.
    h += '<button class="hw-btn hw-btn-ghost" id="hw-back"' + (first ? ' disabled' : '') + '>← Zpět</button>';

    let hint = '';
    if (isLast) {
      // J3: dokončit jde až když je vše vyřešené — a je vidět KOLIK a PROČ to drží.
      const miss = missingAll();
      const items = miss.filter((m) => m.kind === 'item').length;
      if (miss.length) {
        hint = items
          ? 'Zbývá ' + F.int(items) + ' ' + plural(items, 'nevyřešená položka', 'nevyřešené položky', 'nevyřešených položek') + ' → dokončit nelze.'
          : 'Čekám na data všech kroků → dokončit nelze.';
      }
      h += '<span class="hw-hint">' + esc(hint) + '</span><span class="hw-spacer"></span>';
      const blocked = miss.length > 0 || W.saving;
      h += '<button class="hw-btn hw-btn-save" id="hw-save"' + (blocked ? ' disabled' : '') +
        ' title="' + esc(miss.length ? 'Nejdřív vyřeš ' + F.int(items) + ' zbývajících položek (seznam nahoře)' : 'Uzavřít dnešní běh') + '">' +
        (W.saving ? '<span class="hw-spin"></span> Ukládám…' : '✅ Dokončit a uložit') + '</button>';
    } else {
      const n = stepIssues(key).filter((m) => m.kind === 'item').length;
      if (n) hint = F.int(n) + ' ' + plural(n, 'položka', 'položky', 'položek') + ' bez rozhodnutí — projít můžeš dál, dokončit ne.';
      h += '<span class="hw-hint">' + esc(hint) + '</span><span class="hw-spacer"></span>';
      h += '<button class="hw-btn hw-btn-primary" id="hw-next">Další →</button>';
    }
    h += '</div>';
    return h;
  }

  /* ---------------------------------------------------------------------------
   * Napojení eventů po renderu (delegace na panelu)
   * ------------------------------------------------------------------------ */
  function wireEvents(panel) {
    // Zavření (X)
    const closeBtn = panel.querySelector('#hw-close');
    if (closeBtn) closeBtn.addEventListener('click', attemptAbort);

    /* F7/D3 — klik na SLOŽENOU kartu ji zase rozbalí. Bez toho by rozhodnutí bylo
     * jednosměrné: kdo si to chce rozmyslet nebo si jen znovu přečíst čísla, neměl by jak.
     * Interaktivní prvky uvnitř (odkaz do Meta, tlačítka) klik nepřebírají. */
    panel.querySelectorAll('.hw-card.is-collapsed').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, a, select, textarea, input, .hw-thumbwrap')) return;
        const bk = collapseKeyOf(card);
        if (!bk) return;
        W.expand[bk] = true;
        render();
      });
    });

    // Navigace — J1: Další/Zpět bez podmínek, klik na krok v baru skočí kamkoli
    const back = panel.querySelector('#hw-back');
    if (back) back.addEventListener('click', () => goTo(W.idx - 1));
    const next = panel.querySelector('#hw-next');
    if (next) next.addEventListener('click', () => goTo(W.idx + 1));
    panel.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      goTo(parseInt(b.getAttribute('data-goto'), 10));
    }));
    const save = panel.querySelector('#hw-save');
    if (save) save.addEventListener('click', doSave);

    // J2: odkaz ze souhrnu → skoč na krok a na konkrétní kartu
    panel.querySelectorAll('[data-miss]').forEach((b) => b.addEventListener('click', () => {
      const m = missingAll()[parseInt(b.getAttribute('data-miss'), 10)];
      if (m) goTo(m.stepIdx, m.sel);
    }));

    // Retry data
    panel.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => {
      const step = b.getAttribute('data-retry');
      if (step === 'kill') { W.load.kill = 'idle'; ensureKill(); }
      else if (step === 'funnels' || step === 'events') { W.load.overview = 'idle'; ensureOverview(); }
      else if (step === 'scale') { W.load.winners = 'idle'; ensureWinners(); }
      else if (step === 'newest') { W.load.newest = 'idle'; ensureNewest(); }
    }));

    // N7: hover na pillu „Vrstva X · důvod" → popup s detailem ze závorky
    panel.querySelectorAll('[data-why]').forEach((el) => {
      const key = el.getAttribute('data-why');
      el.addEventListener('mouseenter', () => {
        const c = findCreativeByKey(key);
        if (c) showWhyPop(c, el);
      });
      el.addEventListener('mouseleave', hideTextPop);
    });

    // H2: Náhled — hover = velký pop-up · klik = modal (jako v tabulkách)
    panel.querySelectorAll('[data-preview]').forEach((el) => {
      const key = el.getAttribute('data-preview');
      el.addEventListener('click', () => {
        const c = findCreativeByKey(key);
        const ad = c && previewAdBig(c);
        if (ad && ADS.openPreview) { try { hideHoverPop(); ADS.openPreview(ad); } catch (_) {} }
      });
      el.addEventListener('mouseenter', () => {
        const c = findCreativeByKey(key);
        if (c) showHoverPop(c, el);
      });
      el.addEventListener('mouseleave', hideHoverPop);
    });

    // --- Krok 1: kill ---
    panel.querySelectorAll('[data-kill-do]').forEach((b) => b.addEventListener('click', () => runKill(b.getAttribute('data-kill-do'))));
    // F7/D6 — kill přímo z kroku „Nové"
    panel.querySelectorAll('[data-new-kill]').forEach((b) => b.addEventListener('click', () => runKill(b.getAttribute('data-new-kill'), 'newest')));
    panel.querySelectorAll('[data-keep]').forEach((b) => b.addEventListener('click', () => {
      const key = b.getAttribute('data-keep');
      const d = W.dec.kill[key] || (W.dec.kill[key] = {});
      if (d.running || d.result === 'ok') return;
      const was = killResolved(key);
      d.decision = 'keep';
      // F7/D3: „Ponechat" samo o sobě kartu NESLOŽÍ — ještě chceme důvod. Složí se až
      // po jeho výběru (níž), kdy je karta vyřešená a nic dalšího po uživateli nechceme.
      afterDecision(killSel(key), was, killResolved(key));
    }));
    panel.querySelectorAll('[data-keep-reason]').forEach((sel) => sel.addEventListener('change', () => {
      const key = sel.getAttribute('data-keep-reason');
      const d = W.dec.kill[key] || (W.dec.kill[key] = {});
      const was = killResolved(key);
      d.reason = sel.value;
      afterDecision(killSel(key), was, killResolved(key));
    }));
    bindNote(panel, '[data-keep-note]', (key, val) => {
      const d = W.dec.kill[key] || (W.dec.kill[key] = {});
      d.note = val;
    }, 'data-keep-note');

    // --- H4/H5: ovládání kroku (okno pro čísla · metrika grafu · filtr funnelu) ---
    // Chipy mění jen POHLED (W.view) → rozhodnutí ani gating se jich netýkají.
    panel.querySelectorAll('[data-fe-win]').forEach((b) => b.addEventListener('click', () => {
      const [bucket, d] = splitCombo(b.getAttribute('data-fe-win'));
      W.view[bucket].days = d === '' ? null : parseInt(d, 10);
      render();
    }));
    panel.querySelectorAll('[data-fe-met]').forEach((b) => b.addEventListener('click', () => {
      const [bucket, m] = splitCombo(b.getAttribute('data-fe-met'));
      W.view[bucket].metric = m;
      render();
    }));
    panel.querySelectorAll('[data-fe-fun]').forEach((b) => b.addEventListener('click', () => {
      W.view.events.funnel = b.getAttribute('data-fe-fun') || '';
      render();
    }));

    // --- Kroky 2/3: funnely/eventy ---
    panel.querySelectorAll('[data-fe-ok]').forEach((b) => b.addEventListener('click', () => setFE(b.getAttribute('data-fe-ok'), 'ok')));
    panel.querySelectorAll('[data-fe-flag]').forEach((b) => b.addEventListener('click', () => setFE(b.getAttribute('data-fe-flag'), 'flag')));
    bindNote(panel, '[data-fe-note]', (combo, val) => {
      const [bucket, name] = splitCombo(combo);
      const d = W.dec[bucket][name] || (W.dec[bucket][name] = {});
      d.note = val;
    }, 'data-fe-note');

    // --- Krok 4: scale ---
    panel.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => setScale(b.getAttribute('data-scale'), 'scale')));
    panel.querySelectorAll('[data-wait]').forEach((b) => b.addEventListener('click', () => setScale(b.getAttribute('data-wait'), 'wait')));
    bindNote(panel, '[data-scale-note]', (key, val) => {
      const d = W.dec.scale[key] || (W.dec.scale[key] = {});
      d.note = val;
    }, 'data-scale-note');
    const sack = panel.querySelector('[data-scale-ack]');
    if (sack) sack.addEventListener('change', () => { W.dec.scaleAck = sack.checked; refreshChrome(panel); scheduleSave(); });

    // --- Krok 5: newest ---
    panel.querySelectorAll('[data-new-ok]').forEach((b) => b.addEventListener('click', () => setNewest(b.getAttribute('data-new-ok'), 'ok')));
    panel.querySelectorAll('[data-new-flag]').forEach((b) => b.addEventListener('click', () => setNewest(b.getAttribute('data-new-flag'), 'flag')));
    bindNote(panel, '[data-new-note]', (key, val) => {
      const d = W.dec.newest[key] || (W.dec.newest[key] = {});
      d.note = val;
    }, 'data-new-note');
    const nack = panel.querySelector('[data-newest-ack]');
    if (nack) nack.addEventListener('change', () => { W.dec.newestAck = nack.checked; refreshChrome(panel); scheduleSave(); });

    // „Potvrdit zbývající" — jen NEROZHODNUTÉ karty; flagy ani ruční volby nepřepisuje.
    const nbulk = panel.querySelector('[data-newest-bulk]');
    if (nbulk) nbulk.addEventListener('click', () => {
      let n = 0;
      (W.data.newest || []).forEach((c) => {
        const k = cKeyOf(c);
        const d = W.dec.newest[k] || (W.dec.newest[k] = {});
        if (!d.decision) { d.decision = 'ok'; n++; }
      });
      render();
      scheduleSave();
      toast('Přehled potvrzen — ' + F.int(n) + ' ' + plural(n, 'kreativa', 'kreativy', 'kreativ') + ' označeno jako v pořádku.', 'success');
    });
  }

  // Textarea: ukládat průběžně (input) bez re-renderu, aby nezmizel focus;
  // re-render až na blur (kvůli přepočtu resolved/counteru).
  // J4: každý úhoz plánuje autosave — debounce 800 ms drží API v klidu i při psaní.
  function bindNote(panel, selector, apply, attr) {
    panel.querySelectorAll(selector).forEach((ta) => {
      const key = ta.getAttribute(attr);
      ta.addEventListener('input', () => { apply(key, ta.value); refreshChrome(panel); scheduleSave(); });
      ta.addEventListener('blur', () => { apply(key, ta.value); render(); });
    });
  }

  function setFE(combo, decision) {
    const [bucket, name] = splitCombo(combo);
    const d = W.dec[bucket][name] || (W.dec[bucket][name] = {});
    const was = fRowResolved(bucket, name);
    d.decision = decision;
    // „flag" chce povinnou poznámku → není vyřešeno → render je okamžitý a focusNote
    // (setTimeout 0) doskočí do UŽ překreslené karty. Kdyby se animovalo, focus by ulétl.
    afterDecision('.hw-card[data-fkey="' + cssEsc(name) + '"]', was, fRowResolved(bucket, name));
    if (decision === 'flag') focusNote('[data-fe-note="' + cssEsc(combo) + '"]');
  }
  function setScale(key, decision) {
    const d = W.dec.scale[key] || (W.dec.scale[key] = {});
    const was = scaleResolved(key);
    d.decision = decision;
    afterDecision('.hw-card[data-skey="' + cssEsc(key) + '"]', was, scaleResolved(key));
    // „Počkat" = odmítnutí → důvod je povinný, skoč rovnou do pole (jako u setFE('flag'))
    if (decision === 'wait') focusNote('[data-scale-note="' + cssEsc(key) + '"]');
  }
  function setNewest(key, decision) {
    const d = W.dec.newest[key] || (W.dec.newest[key] = {});
    const was = newestResolved(key);
    d.decision = decision;
    afterDecision(newestSel(key), was, newestResolved(key));
    if (decision === 'flag') focusNote('[data-new-note="' + cssEsc(key) + '"]');
  }
  function splitCombo(combo) {
    const i = combo.indexOf('|');
    return [combo.slice(0, i), combo.slice(i + 1)];
  }
  // F7/D3: selektory karet — každý krok má vlastní atribut (historicky), tak ať se to
  // neopisuje v každém handleru a nedá se v něm udělat překlep.
  function killSel(key)   { return '.hw-card[data-ckey="' + cssEsc(key) + '"]'; }
  function newestSel(key) { return '.hw-card[data-nkey="' + cssEsc(key) + '"]'; }
  /** Z DOM karty zpět na klíč do W.expand („bucket|key"). Opak selektorů výš. */
  function collapseKeyOf(card) {
    if (card.hasAttribute('data-ckey')) return 'kill|'   + card.getAttribute('data-ckey');
    if (card.hasAttribute('data-nkey')) return 'newest|' + card.getAttribute('data-nkey');
    if (card.hasAttribute('data-skey')) return 'scale|'  + card.getAttribute('data-skey');
    // funnely/eventy sdílí atribut i vzhled — bucket pozná jen podle právě otevřeného kroku
    if (card.hasAttribute('data-fkey')) {
      const step = W.steps[W.idx] && W.steps[W.idx].key;
      if (step === 'funnels' || step === 'events') return step + '|' + card.getAttribute('data-fkey');
    }
    return null;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function focusNote(sel) {
    setTimeout(() => { const t = W.rootEl.querySelector(sel); if (t) t.focus(); }, 0);
  }

  // Přepočítat „chrom" kolem těla (patička + progress bar + counter) bez re-renderu těla.
  // Používá se při psaní do poznámky — full render() by sebral focus z textarey.
  function refreshChrome(panel) {
    const swap = (sel, html, pick) => {
      const old = panel.querySelector(sel);
      if (!old) return null;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const neu = pick ? tmp.querySelector(pick) : tmp.firstElementChild;
      if (!neu) return null;
      old.replaceWith(neu);
      return neu;
    };
    // patička (hint + gate na Dokončit)
    const foot = swap('.hw-foot', footHTML());
    if (foot) {
      const back = foot.querySelector('#hw-back');
      if (back) back.addEventListener('click', () => goTo(W.idx - 1));
      const next = foot.querySelector('#hw-next');
      if (next) next.addEventListener('click', () => goTo(W.idx + 1));
      const save = foot.querySelector('#hw-save');
      if (save) save.addEventListener('click', doSave);
    }
    // progress bar (tečky/varování se mění s každým vyřešeným bodem)
    const steps = swap('.hw-steps', stepsHTML());
    if (steps) {
      steps.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
        goTo(parseInt(b.getAttribute('data-goto'), 10));
      }));
    }
    // counter v nadpisu kroku
    swap('.hw-steptitle', stepTitle(W.steps[W.idx].key), '.hw-steptitle');
  }

  function scrollTop() {
    const b = W.rootEl.querySelector('#hw-body');
    if (b) b.scrollTop = 0;
  }
  function findCreativeByKey(key) {
    const pools = [W.data.kill, W.data.winners, W.data.newest];
    for (const p of pools) {
      if (!p) continue;
      const hit = p.find((c) => cKeyOf(c) === key);
      if (hit) return hit;
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
   * KILL flow (stejný jako v tabulkách: POST kill → poll ad_status → PAUSED)
   * Kreativa může mít víc reklam → vypni všechny aktivní a každou odpolluj.
   * ------------------------------------------------------------------------ */
  /* F7/D6 — kill jde spustit i z kroku „Nové" (Filip 23. 7.: „zároveň chci u těch novejch
   * mít i volbu kill, nejenom flag a v pořádku, ale i kill, kdy jí můžu rovnou zabít.").
   * Proto `bucket`: rozhoduje, ze kterého seznamu se kreativa bere, kam se zapíše
   * rozhodnutí a kterou kartu po dokončení složit. Samotný kill flow (potvrzení →
   * POST → poll na PAUSED) zůstává JEDEN — dvě kopie by se dřív nebo později rozešly. */
  async function runKill(cKey, bucket) {
    bucket = bucket === 'newest' ? 'newest' : 'kill';
    const pool = bucket === 'newest' ? (W.data.newest || []) : (W.data.kill || []);
    const c = pool.find((x) => cKeyOf(x) === cKey);
    if (!c) return;
    const cardSel = bucket === 'newest' ? newestSel(cKey) : killSel(cKey);
    const d = W.dec[bucket][cKey] || (W.dec[bucket][cKey] = {});
    if (d.running) return;

    // cílové reklamy = ty, které ještě nejsou vypnuté
    const targets = (c.ads || []).filter((a) => !isPaused(a.effective_status, a.status));
    const totalAds = (c.ads || []).length;

    // potvrzení (metriky + varování)
    const ok = await confirmDialog({
      title: 'Zabít reklamu ' + cKey + '?',
      body:
        'Vypne se <b>' + F.int(targets.length || totalAds) + '</b> reklam v Meta (status → PAUSED).<br>' +
        'Spend ' + esc(F.money(c.spend)) + ' · leady ' + esc(F.int(c.leads)) +
        ' · rezervace ' + esc(F.int(c.bookings)) +
        (c.roas_model != null ? ' · ROAS model ' + esc(F.roas(c.roas_model)) : '') + '.<br>' +
        // F7/D6: u čerstvé kreativy jsou čísla ještě nezralá → říct to nahlas, ne mlčet
        (bucket === 'newest'
          ? '<span style="color:#8a6a1f">⚠︎ Je to NOVÁ kreativa — data ještě nedozrála, ' +
            'takže ROAS i CPA se můžou ještě výrazně změnit.</span><br>' : '') +
        '<span style="color:#8b8378">Akci lze později vrátit reaktivací v dashboardu.</span>',
      okText: '🔴 Ano, zabít',
      okDanger: true,
      cancelText: 'Zrušit',
    });
    if (!ok) return;

    if (targets.length === 0) {
      // vše už vypnuté → jen zaznamenat rozhodnutí
      d.decision = 'kill'; d.result = 'ok'; d.running = false;
      d.ad_ids = (c.ads || []).map((a) => a.ad_id);
      toast('Reklamy u ' + cKey + ' už byly vypnuté.', 'info');
      collapseAnim(cardSel, render);   // F7/D3
      return;
    }

    d.decision = 'kill'; d.running = true; d.result = null; d.failed = [];
    d.ad_ids = targets.map((a) => a.ad_id);
    render();

    for (const ad of targets) {
      let effOk = false;
      try {
        // F7/D1: nové zápisy do ads_action_log jdou pod „CHECK: " (přejmenováno z „HECK: ").
        // Staré řádky v DB se NEPŘEPISUJÍ — historie zůstává, jak byla pořízena.
        const res = await apiPost('kill', {
          ad_id: ad.ad_id, creative: cKey,
          reason: 'CHECK: ' + (bucket === 'newest'
            ? 'nová kreativa — ruční kill'
            : (c.kill_reason || KILL_LAYER[num(c.kill_layer)] || 'kill')),
        });
        let eff = res && res.effective_status;
        let conf = res && res.status;
        // poll dokud Meta nepotvrdí vypnutí (max ~24 s). Stačí KTERÝKOLI z obou statusů —
        // konfigurační `status=PAUSED` je platné vypnutí i při `effective=WITH_ISSUES`.
        let tries = 0;
        while (!isPaused(eff, conf) && tries < 12) {
          await sleep(2000);
          try {
            const st = await apiGet('ad_status', { ad_id: ad.ad_id });
            eff = st && st.effective_status; conf = st && st.status;
          } catch (_) { /* poll chyba → zkus dál */ }
          tries++;
        }
        ad.effective_status = eff || ad.effective_status;
        if (conf) ad.status = conf;
        effOk = isPaused(eff, conf);
      } catch (e) {
        effOk = false;
      }
      if (effOk) {
        // Živý přepis řádků v tabulkách. tables.js větví na det.scope ('creative'|'ad') —
        // bez scope by se událost tiše zahodila. Killujeme po jednotlivých ad → scope 'ad'.
        try {
          ADS.bus && ADS.bus.dispatchEvent(new CustomEvent('killed', {
            detail: { scope: 'ad', ad_id: ad.ad_id, creative: cKey },
          }));
        } catch (_) {}
      } else {
        d.failed.push(ad.ad_id);
      }
      render(); // živý postup
    }

    d.running = false;
    d.result = d.failed.length === 0 ? 'ok' : 'partial';
    if (d.result === 'ok') toast('Vypnuto: ' + cKey, 'success');
    else toast('Nepodařilo se vypnout ' + d.failed.length + ' reklam u ' + cKey + '. Zkus znovu.', 'error');
    scheduleSave(150);   // kill je nevratný → ulož stav skoro hned, ne až za 800 ms
    // F7/D3: povedený kill = karta je vyřešená → animovaně ji slož. Při 'partial' NE —
    // tam ještě zbývá „Zkusit znovu" a schovat to by uživatele připravilo o akci.
    if (d.result === 'ok') collapseAnim(cardSel, render);
    else render();
  }

  /* ---------------------------------------------------------------------------
   * FEEDBACK řádky → ads_rule_feedback  (SPEC §5 — jádro zpětné vazby pro Claude:
   * z důvodů odmítnutí se ladí NUANCE pravidel, additivně, do FUNNEL_OVERRIDES.)
   *
   * Tvar řádku sedí na schema.sql (ads_rule_feedback) i na validaci v api.php (wizard_save):
   *   {rec_type, rule, target, ad_id, suggested_action, decision:'accept'|'reject', reason, snapshot}
   *   • decision MUSÍ být 'accept' | 'reject'            → jinak 400
   *   • u 'reject' MUSÍ být neprázdný reason             → jinak 400 (proto to hlídá i stepReady)
   *   • snapshot → server ho json_encode() do snapshot_json
   * Mapování rozhodnutí wizardu na doporučení:
   *   kill → accept · keep → reject(+důvod)  |  scale → accept · wait → reject(+důvod)
   *   funnel/event ok → accept · flag → reject(+důvod)  |  newest ok → accept · flag → reject(+důvod)
   * ------------------------------------------------------------------------ */
  function fbRow(o) {
    return {
      rec_type: String(o.rec_type || ''),
      rule: String(o.rule || ''),                        // slug pravidla ze serveru; '' = žádné nespustilo
      target: String(o.target || ''),                    // kód kreativy / název funnelu / eventu
      ad_id: o.ad_id ? String(o.ad_id) : null,
      suggested_action: String(o.suggested_action || ''),
      decision: o.decision,                              // 'accept' | 'reject'
      reason: String(o.reason == null ? '' : o.reason).trim(),
      snapshot: o.snapshot || {},                        // metriky v čase rozhodnutí
    };
  }
  const period = () => ({ from: W.period.from, to: W.period.to, tab: W.period.tab });
  function firstAdId(c) {
    const a = (c.ads || [])[0] || c.sample_ad;
    return a && a.ad_id ? String(a.ad_id) : null;
  }
  // Snapshot metrik kreativy v čase rozhodnutí (názvy polí = jak je posílá api.php)
  function snapCreative(c, extra) {
    const s = {
      creative: cKeyOf(c), funnel: c.funnel || '', event: c.event || '',
      spend: num(c.spend), leads: num(c.leads), called: num(c.called),
      bookings: num(c.bookings), passed: c.passed == null ? null : num(c.passed),
      cpl: num(c.cpl), cps: num(c.cps),
      roas_real: num(c.roas_real), roas_model: num(c.roas_model),
      call_rate: num(c.call_rate), dopocet_pct: num(c.dopocet_pct),
      benchmark_cps: num(c.benchmark_cps),
      trend_cps: c.trend_cps || null,
      maturity: c.maturity || '', age_days: c.age_days == null ? null : num(c.age_days),
      in_grace: !!c.in_grace,
      period: period(),
    };
    return Object.assign(s, extra || {});
  }
  function keepReasonText(d) {
    const label = keepReasonLabel[d.reason] || d.reason || '';
    const note = (d.note || '').trim();
    return note ? (label ? label + ' — ' + note : note) : label;
  }

  /* @param {object} [opts] - {validOnly:true} → vyhoď řádky, které by server odmítl
   *   (reject bez důvodu = 400 pro CELOU dávku). Nutné pro průběžné ukládání (J4):
   *   uživatel klikne „Ponechat" a důvod dopisuje až za vteřinu — draft mezitím
   *   nesmí spadnout. Rozpracované odmítnutí bez důvodu prostě do feedbacku ještě
   *   nepatří; do steps_json se uloží tak jako tak, takže se po návratu obnoví.
   *   Finální uložení posílá VŠE (validOnly=false) — tam už je díky J3 gate vše kompletní. */
  function buildFeedbackRows(opts) {
    const rows = [];

    // --- Krok 1: kill kandidáti · doporučení = „vypni tuhle kreativu" ---
    (W.data.kill || []).forEach((c) => {
      const key = cKeyOf(c);
      const d = W.dec.kill[key];
      if (!d || !d.decision) return;
      const rule = rulesOf(c)[0] || '';   // pravidlo s nejvyšší prioritou (server řadí 1>2>3>4)
      const snap = snapCreative(c, {
        kill_layer: num(c.kill_layer), kill_rules: rulesOf(c), kill_reason: c.kill_reason || '',
      });
      if (d.decision === 'kill') {
        rows.push(fbRow({
          rec_type: 'kill', rule, target: key,
          ad_id: (d.ad_ids && d.ad_ids[0]) || firstAdId(c),
          suggested_action: 'kill', decision: 'accept',
          reason: c.kill_reason || '',   // u accept nepovinné — necháváme kontext pravidla
          snapshot: Object.assign(snap, { ad_ids: d.ad_ids || [], kill_result: d.result || '', failed_ads: d.failed || [] }),
        }));
      } else if (d.decision === 'keep') {
        rows.push(fbRow({
          rec_type: 'kill', rule, target: key,
          ad_id: firstAdId(c),
          suggested_action: 'kill', decision: 'reject',
          reason: keepReasonText(d),     // POVINNÉ — hlídá killResolved()
          snapshot: Object.assign(snap, { keep_reason_code: d.reason || '' }),
        }));
      }
    });

    // --- Kroky 2/3: funnely + eventy · doporučení = anomálie / zhodnocení ---
    [['funnels', 'funnel_flag'], ['events', 'event_flag']].forEach(([bucket, recType]) => {
      if (!W.steps.some((s) => s.key === bucket)) return;   // náušnice funnely/eventy nemají
      const rows_ = bucket === 'funnels' ? funnelRows() : eventRows();
      rows_.forEach((r) => {
        const d = W.dec[bucket][r.__name];
        if (!d || !d.decision) return;
        const a = r.__anom;
        const snap = {
          name: r.__name, spend: num(r.__spend), leads: num(r.__leads), bookings: num(r.__bookings),
          cpl: num(r.__cpl), cps: num(r.__cps),
          roas_real: num(r.__roas_real), roas_model: num(r.__roas_model),
          trend_cps: r.__trend || null, anomaly: a || null, period: period(),
          // A4: zralost v čase rozhodnutí (null, dokud ji api.php na funnelech/eventech nepošle)
          zralost: (zralostOf(r.__raw || {}) || {}).v ?? null,
          // H4/H5: čím se Filip zrovna díval, když se rozhodoval. Čísla výš jsou VŽDY za období
          // běhu (autorita); tohle jen říká, jaká lupa byla nasazená — bez toho by se z důvodu
          // „to je 14denní propad" nedalo poznat, na co koukal.
          viewed: { window_days: W.view[bucket].days, chart_metric: W.view[bucket].metric,
                    funnel_filter: bucket === 'events' ? (W.view.events.funnel || '') : '' },
        };
        rows.push(fbRow({
          rec_type: recType,
          rule: a ? String(a.rule || 'anomaly') : '',   // anomálie = jediné pravidlo na této úrovni
          target: r.__name, ad_id: null,
          suggested_action: 'review',
          decision: d.decision === 'flag' ? 'reject' : 'accept',
          reason: d.decision === 'flag' ? (d.note || '') : '',   // flag → POVINNÉ (fRowResolved)
          snapshot: snap,
        }));
      });
    });

    // --- Krok 4: scale check · doporučení = „škáluj tohoto winnera" ---
    scaleRows().forEach((c) => {
      const key = cKeyOf(c);
      const d = W.dec.scale[key];
      if (!d || !d.decision) return;
      rows.push(fbRow({
        rec_type: 'scale', rule: 'scale_ready', target: key,
        ad_id: firstAdId(c),
        suggested_action: 'scale',
        decision: d.decision === 'wait' ? 'reject' : 'accept',
        // u 'wait' je poznámka POVINNÁ (hlídá scaleResolved), u 'scale' je nepovinný kontext
        reason: d.note || '',
        snapshot: snapCreative(c, { scale_ready: true, scale_third_unknown: !!c.scale_third_unknown, winner: !!c.winner }),
      }));
    });

    // --- Krok 5: nejnovější reklamy · doporučení = „přehled sedí, sbírá data" ---
    (W.data.newest || []).forEach((c) => {
      const key = cKeyOf(c);
      const d = W.dec.newest[key];
      if (!d || !d.decision) return;
      rows.push(fbRow({
        rec_type: 'newest', rule: '', target: key,
        ad_id: firstAdId(c),
        // F7/D6: kill z kroku „Nové" je PROVEDENÁ akce → zapsat ji jako takovou,
        // ať se z feedbacku pozná „novou kreativu rovnou zabil" od „jen prohlédl".
        suggested_action: d.decision === 'kill' ? 'kill' : 'review',
        decision: d.decision === 'flag' ? 'reject' : 'accept',
        reason: d.decision === 'flag' ? (d.note || '')
              : d.decision === 'kill' ? 'ruční kill nové kreativy z denního checku' : '',
        snapshot: snapCreative(c, { is_new: !!c.is_new }),
      }));
    });

    // Zrcadlo serverové validace (api.php wizard_save): reject bez důvodu = 400 na celou dávku.
    if (opts && opts.validOnly) return rows.filter((r) => !(r.decision === 'reject' && !r.reason));
    return rows;
  }

  /* ---------------------------------------------------------------------------
   * J4 — PRŮBĚŽNÉ UKLÁDÁNÍ (draft po každé akci, debounce 800 ms)
   *
   * Server (api.php wizard_save) při každém uložení feedback řádky NAHRAZUJE
   * (DELETE by run_id + INSERT) → posíláme VŽDY kompletní sadu z W.dec, nikdy delty.
   * Běh se páruje přes (run_date, who) → opakované uložení přepisuje týž řádek.
   * ------------------------------------------------------------------------ */
  function scheduleSave(delay) {
    if (!W || !W.open) return;
    if (saveTimer) clearTimeout(saveTimer);
    setSaveStatus('pending');
    saveTimer = setTimeout(() => { saveTimer = null; saveDraft(); }, delay == null ? 800 : delay);
  }
  function cancelScheduledSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }

  async function saveDraft() {
    if (!W || !W.open) return;              // wizard se mezitím zavřel → nic neposílej
    if (W.draftSaving) { W.savePending = true; return; }   // doběhne a uloží se znovu
    W.draftSaving = true;
    setSaveStatus('saving');
    try {
      await apiPost('wizard_save', {
        steps_json: JSON.stringify(buildStepsJson(W.wasFinished)),
        // ⚠️ NIKDY natvrdo false: server zapisuje finished_at = (finished ? now : NULL),
        // takže draft nad už dokončeným během by ho „odDOKONČIL" a vrátil HECK banner.
        finished: W.wasFinished,
        feedback: buildFeedbackRows({ validOnly: true }),
      });
      if (W && W.open) setSaveStatus('saved');
    } catch (e) {
      if (W && W.open) setSaveStatus('error', errMsg(e));
    }
    if (!W) return;
    W.draftSaving = false;
    if (W.savePending) { W.savePending = false; scheduleSave(200); }
  }

  // Dojet rozpracované uložení (před zavřením s „Ponechat uložené")
  async function flushSave() {
    cancelScheduledSave();
    const st = W.saveState && W.saveState.status;
    if (st === 'saved' && !W.savePending) return;   // není co dodělávat
    await saveDraft();
  }

  /* ---------------------------------------------------------------------------
   * Finální uložení (krok 6) — J3: pustí jen kompletně vyřešený běh
   * ------------------------------------------------------------------------ */
  /* F7/D7 — FLAGY Z DENNÍHO CHECKU MUSÍ PŘEŽÍT BĚH.
   * Rozhodnutí „⚑ Flag" u nové kreativy se dosud ukládalo jen do `ads_rule_feedback`,
   * kde se řádky při každém uložení běhu DELETE+INSERT přepisují — takže poznámka
   * „tuhle hlídat" byla za den pryč. Filip ji chce vidět u kreativy dlouhodobě
   * (a jako sloupec v tabulce), proto se navíc založí trvalý flag.
   *
   * ⚠️ AŽ PŘI FINÁLNÍM ULOŽENÍ, ne při autosave draftu: draft běží po každém úhozu
   *    (debounce 800 ms) a nasypal by desítky duplicit z rozepsané poznámky.
   * ⚠️ Selhání se NESMÍ propsat do výsledku uložení — běh je uložený, flagy jsou bonus. */
  async function persistWizardFlags() {
    if (!ADS.flags) return;
    const jobs = [];
    Object.keys(W.dec.newest || {}).forEach((key) => {
      const d = W.dec.newest[key];
      if (!d || d.decision !== 'flag') return;
      const note = (d.note || '').trim();
      if (!note || d.flagSaved) return;     // flagSaved = pojistka proti druhému kliknutí na Uložit
      d.flagSaved = true;
      jobs.push(ADS.flags.add(key, note, { source: 'wizard' })
        .catch((e) => { d.flagSaved = false; console.warn('[wizard] flag se neuložil', key, e); }));
    });
    if (jobs.length) await Promise.all(jobs);
  }

  async function doSave() {
    if (W.saving) return;

    // J3 gate (tlačítko je disabled, tohle je pojistka proti závodu s načítáním dat)
    const miss = missingAll();
    if (miss.length) {
      const first = miss.find((m) => m.kind === 'item');
      toast(first
        ? 'Zbývá ' + F.int(miss.filter((m) => m.kind === 'item').length) + ' nevyřešených položek — začni u „' + first.label + '".'
        : 'Počkej, data se ještě načítají.', 'error');
      if (first) goTo(first.stepIdx, first.sel);
      return;
    }

    cancelScheduledSave();   // ať draft nepřepíše finished:true zpátky na false
    const payload = buildStepsJson(true);
    const feedback = buildFeedbackRows();

    // Zrcadlo serverové validace (api.php wizard_save): odmítnutí bez důvodu = 400 pro CELOU dávku.
    // Radši to chytneme tady a pošleme uživatele doplnit důvod, než ať mu spadne uložení.
    const bad = feedback.find((r) => r.decision === 'reject' && !r.reason);
    if (bad) {
      toast('U odmítnutí „' + bad.target + '" chybí důvod — vrať se a doplň ho.', 'error');
      return;
    }

    W.saving = true; render();
    try {
      const res = await apiPost('wizard_save', {
        steps_json: JSON.stringify(payload),
        finished: true,        // ← bez toho zůstane finished_at NULL → wizard_today done:false → banner NEZMIZÍ
        feedback,              // ← řádky do ads_rule_feedback (podklad pro ladění nuancí pravidel)
      });
      const n = res && res.feedback_saved != null ? num(res.feedback_saved) : feedback.length;
      W.wasFinished = true;
      await persistWizardFlags();   // F7/D7 — flagy z běhu ať přežijí den
      toast('Denní check uložen ✔' + (n ? ' · ' + F.int(n) + ' rozhodnutí do feedbacku' : ''), 'success');
      close({ saved: true });
    } catch (e) {
      W.saving = false;
      toast('Uložení selhalo: ' + errMsg(e), 'error');
      render();
    }
  }

  /* ---------------------------------------------------------------------------
   * J4 — obnovení rozpracovaného běhu (wizard_today → předvyplnit rozhodnutí)
   * ------------------------------------------------------------------------ */
  async function restoreDraft() {
    try {
      const res = await apiGet('wizard_today', {});
      const run = res && res.run;
      if (!run) return;
      // Cizí rozpracovaný běh nepředvyplňujeme: wizard_today vrací POSLEDNÍ dnešní běh
      // bez ohledu na uživatele, ale wizard_save zapisuje pod (dnes, JÁ) → jinak by
      // Filip uviděl Vojtova rozhodnutí a uložil je pod sebe.
      if (String(run.who || '') !== String(W.period.who || '')) return;
      W.runId = run.id || null;
      W.wasFinished = !!run.finished_at || !!res.done;
      const payload = run.steps;
      const steps = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.steps) ? payload.steps : null);
      if (!steps) return;
      const n = applyDraftSteps(steps);
      if (n) {
        W.restored = n;
        setSaveStatus('saved');
        toast('Načten rozpracovaný běh — ' + F.int(n) + ' ' + plural(n, 'rozhodnutí', 'rozhodnutí', 'rozhodnutí') + ' předvyplněno.', 'info');
      }
    } catch (_) { /* rozpracovaný běh je bonus — když se nenačte, jede se od nuly */ }
  }

  // Předvyplní W.dec ze steps_json. Defenzivní: tvar musí sedět, jinak položku ignoruj
  // (mock/starší běhy mají items jako číslo nebo úplně jiná pole).
  function applyDraftSteps(steps) {
    let n = 0;
    const s = (v) => String(v == null ? '' : v).trim();
    steps.forEach((st) => {
      if (!st || !st.key) return;
      const items = Array.isArray(st.items) ? st.items : [];
      if (st.key === 'kill') {
        items.forEach((it) => {
          if (!it || typeof it !== 'object') return;
          const key = s(it.creative), d = s(it.decision);
          if (!key || (d !== 'kill' && d !== 'keep')) return;
          W.dec.kill[key] = {
            decision: d, reason: s(it.reason), note: String(it.note || ''),
            ad_ids: Array.isArray(it.ad_ids) ? it.ad_ids : [],
            result: s(it.result), running: false, failed: [],
          };
          n++;
        });
      } else if (st.key === 'funnels' || st.key === 'events') {
        const nameKey = st.key === 'funnels' ? 'funnel' : 'event';
        items.forEach((it) => {
          if (!it || typeof it !== 'object') return;
          const name = s(it[nameKey] || it.name), d = s(it.decision);
          if (!name || (d !== 'ok' && d !== 'flag')) return;
          W.dec[st.key][name] = { decision: d, note: String(it.note || '') };
          n++;
        });
      } else if (st.key === 'scale') {
        if (s(st.decision) === 'none') W.dec.scaleAck = true;
        items.forEach((it) => {
          if (!it || typeof it !== 'object') return;
          const key = s(it.creative), d = s(it.decision);
          if (!key || (d !== 'scale' && d !== 'wait')) return;
          W.dec.scale[key] = { decision: d, note: String(it.note || '') };
          n++;
        });
      } else if (st.key === 'newest') {
        if (s(st.decision) === 'confirmed') W.dec.newestAck = true;
        items.forEach((it) => {
          if (!it || typeof it !== 'object') return;
          const key = s(it.creative), d = s(it.decision);
          if (!key || (d !== 'ok' && d !== 'flag')) return;
          W.dec.newest[key] = { decision: d, note: String(it.note || '') };
          n++;
        });
      }
    });
    return n;
  }

  // Jsou vůbec nějaká rozhodnutí? (rozhoduje, jestli má smysl ptát se při zavírání)
  function hasAnyDecision() {
    if (W.dec.scaleAck || W.dec.newestAck) return true;
    return ['kill', 'funnels', 'events', 'scale', 'newest'].some((b) =>
      Object.keys(W.dec[b] || {}).some((k) => {
        const d = W.dec[b][k];
        return d && (d.decision || d.reason || (d.note && d.note.trim()));
      })
    );
  }

  /* ---------------------------------------------------------------------------
   * Zavření (X / Esc) — J4: Zahodit / Ponechat uložené / Pokračovat
   * Rozpracovaný stav je díky autosave už na serveru, takže „přerušit = přijít o práci"
   * neplatí. Uživatel se rozhoduje jen o tom, jestli si draft nechat na později.
   * ------------------------------------------------------------------------ */
  async function attemptAbort() {
    // Pokud běží kill, nedovol zavřít
    const running = Object.values(W.dec.kill).some((d) => d && d.running);
    if (running) {
      toast('Počkej, než Meta potvrdí vypnutí reklamy.', 'info');
      return;
    }
    // Nic rozhodnutého → není o čem vést dialog
    if (!hasAnyDecision()) { cancelScheduledSave(); close({ saved: false }); return; }

    const miss = missingAll().filter((m) => m.kind === 'item').length;
    const killed = Object.keys(W.dec.kill).filter((k) => {
      const d = W.dec.kill[k];
      return d && d.decision === 'kill' && (d.result === 'ok' || d.result === 'partial');
    }).length;

    const choice = await choiceDialog({
      title: 'Zavřít denní kontrolu?',
      body:
        'Rozpracovaný běh je <b>průběžně uložený</b>' +
        (miss ? ' — zbývá ' + F.int(miss) + ' ' + esc(plural(miss, 'nevyřešená položka', 'nevyřešené položky', 'nevyřešených položek')) + '.' : '.') +
        '<br><b>Ponechat uložené</b> = po návratu se rozhodnutí předvyplní a dokončíš to později.' +
        '<br><b>Zahodit</b> = rozpracovaná rozhodnutí zahodíš a příště začneš načisto.' +
        (killed
          ? '<br><span style="color:#b8322e">Pozor: ' + F.int(killed) + ' už vypnutých kreativ zahození nevrátí — reklamy zůstanou v Meta vypnuté.</span>'
          : '') +
        '<br><span style="color:#8b8378">Banner denního checku zůstane, dokud běh nedokončíš v Souhrnu.</span>',
      cancelId: 'cancel',
      focusId: 'keep',
      buttons: [
        { id: 'discard', text: '🗑 Zahodit', cls: 'hw-btn-danger' },
        { id: 'cancel', text: 'Pokračovat', cls: 'hw-btn-ghost' },
        { id: 'keep', text: '💾 Ponechat uložené', cls: 'hw-btn-primary' },
      ],
    });

    if (!choice || choice === 'cancel') return;
    if (choice === 'keep') {
      await flushSave();
      const failed = W.saveState && W.saveState.status === 'error';
      toast(failed ? 'Uložení se nepovedlo — draft nemusí být kompletní.' : 'Rozpracovaný běh uložen — dokončíš ho později.',
        failed ? 'error' : 'success');
      close({ saved: false });
      return;
    }
    if (choice === 'discard') {
      await discardDraft();
      close({ saved: false });
    }
  }

  // „Zahodit" — server nemá wizard_discard, takže běh přepíšeme prázdným stavem:
  // steps_json bez rozhodnutí → wizard_today příště nic nepředvyplní.
  async function discardDraft() {
    cancelScheduledSave();
    W.dec = freshState().dec;    // vyprázdnit i lokálně (kdyby se wizard otevřel znovu)
    try {
      await apiPost('wizard_save', {
        steps_json: JSON.stringify({
          tab: W.period.tab, who: W.period.who, from: W.period.from, to: W.period.to,
          generated_at: new Date().toISOString(), finished: !!W.wasFinished, discarded: true, steps: [],
        }),
        finished: W.wasFinished,   // zahození draftu nesmí odDOKONČIT už hotový běh
        feedback: [],
      });
      toast('Rozpracovaná rozhodnutí zahozena.', 'info');
    } catch (e) {
      toast('Zahození se nepovedlo: ' + errMsg(e), 'error');
    }
  }

  /* ---------------------------------------------------------------------------
   * Open / Close
   * ------------------------------------------------------------------------ */
  function mountRoot() {
    let root = document.getElementById('wizard-root');
    if (!root) {
      // fallback: shell nevytvořil kontejner → vytvoříme si vlastní
      root = document.createElement('div');
      root.id = 'wizard-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function open() {
    if (W && W.open) return; // už otevřeno
    injectStyles();
    W = freshState();
    W.open = true;
    W.rootEl = mountRoot();
    W.rootEl.className = 'hw-overlay';
    W.rootEl.setAttribute('aria-hidden', 'false');
    document.documentElement.style.overflow = 'hidden'; // lock scroll pozadí
    document.addEventListener('keydown', onKeydown, true);
    render();
    // J1: navigace je volná → data všech kroků naráz (viz loadAllSteps)
    loadAllSteps();
    // J4: předvyplnit rozpracovaný běh (nezávisle na datech — W.dec je klíčovaný kódem)
    restoreDraft().then(() => { if (W && W.open) render(); });
  }

  function close({ saved }) {
    if (!W) return;
    cancelScheduledSave();   // ať po zavření nedoběhne autosave nad mrtvým stavem
    disposeCharts();         // ECharts instance + jejich canvasy pryč, ať se wizard neusadí v paměti
    hideHoverPop();
    hideTextPop();
    document.removeEventListener('keydown', onKeydown, true);
    document.documentElement.style.overflow = '';
    if (W.rootEl) {
      W.rootEl.innerHTML = '';
      W.rootEl.className = '';
      W.rootEl.setAttribute('aria-hidden', 'true');
    }
    W.open = false;
    // Banner zmizí JEN po uložení (dnešní běh hotov)
    if (saved) {
      try { ADS.bus && ADS.bus.dispatchEvent(new CustomEvent('wizardclose', { detail: { saved: true } })); } catch (_) {}
    }
    W = null;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); attemptAbort(); }
  }

  /* ---------------------------------------------------------------------------
   * Napojení spouštěčů (blbuvzdorně, více cest)
   * ------------------------------------------------------------------------ */
  function wireTriggers() {
    // 1) globální handle
    window.ADSWizard = { open, close: () => close({ saved: false }), isOpen: () => !!(W && W.open) };
    // pro pohodlí i na ADS objektu (kdyby banner sáhl tam)
    try { if (window.ADS && !window.ADS.openWizard) window.ADS.openWizard = open; } catch (_) {}

    // 2) bus event
    try { window.ADS && ADS.bus && ADS.bus.addEventListener('wizardopen', open); } catch (_) {}

    // 3) delegace na klik (banner může jen přidat atribut na tlačítko)
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-open-wizard],[data-heck-start],#heck-start,.js-open-heck');
      if (t) { e.preventDefault(); open(); }
    });
  }

  /* ---------------------------------------------------------------------------
   * Bootstrap — počkej na window.ADS, pak napoj spouštěče
   * ------------------------------------------------------------------------ */
  function boot() {
    if (window.ADS) {
      wireTriggers();
      // pokud shell nabízí onReady, jen si přes něj případně re-checkne stav
      try { if (typeof ADS.onReady === 'function') ADS.onReady(function () { /* wizard je on-demand, nic dělat netřeba */ }); } catch (_) {}
      return;
    }
    // ADS ještě není → poll
    let tries = 0;
    const iv = setInterval(function () {
      tries++;
      if (window.ADS) { clearInterval(iv); wireTriggers(); }
      else if (tries > 200) { clearInterval(iv); /* 10 s, vzdáváme čekání */ }
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
