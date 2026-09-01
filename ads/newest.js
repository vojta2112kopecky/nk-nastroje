/* =====================================================================
 * NK Ads Dashboard — newest.js
 * Sekce „🆕 Nejnovější reklamy" jako DLAŽDICE (FEEDBACK-3 G1–G5).
 * Konzumuje POUZE window.ADS. Mount: #newest (index.html).
 *
 * ⚠️ KOORDINACE: tuhle sekci renderoval tables.js (`renderNewest()`).
 *    newest.js má PŘEDNOST → integrátor musí `renderNewest()` z tables.js
 *    vypnout (viz notes_for_integrator). Kdyby oba běžely, přepisují si
 *    innerHTML stejného mountu — kdo doběhne později, vyhraje.
 *
 * Data: ADS.api('creatives',{from,to,tab:'rings',segment:'new'})
 *
 * CO TAHLE SEKCE ODPOVÍDÁ (Filip): „rychlej check, co se chytá."
 * → tzn. u ČERSTVĚ SPUŠTĚNÉ kreativy: dostala prostor? chytá se? můžu škálovat?
 * ===================================================================== */
(function boot(tries){
  if (window.ADS && typeof window.ADS.onReady === 'function') { main(window.ADS); }
  else if (tries < 60) { setTimeout(function(){ boot(tries + 1); }, 100); }
  else { console.error('[newest] window.ADS není dostupné — dlaždice se nevykreslí.'); }
})(0);

function main(ADS) {
  'use strict';

  var F = ADS.fmt || {};
  var MOUNT = '#newest';

  /* ================================================================== *
   * 0) POMOCNÉ
   * ================================================================== */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function num(v){ var n = Number(v); return isFinite(n) ? n : null; }
  function th(key, dflt){
    var t = ADS.TH || {};
    return (t[key] != null && isFinite(Number(t[key]))) ? Number(t[key]) : dflt;
  }
  function money(n){ return F.money ? F.money(n) : (Math.round(Number(n)||0) + ' Kč'); }
  function int(n){ return F.int ? F.int(n) : String(Math.round(Number(n)||0)); }
  function roasTxt(n){ return F.roas ? F.roas(n) : ((Number(n)||0).toFixed(2) + '×'); }
  function dateTxt(s){ return F.date ? F.date(s) : String(s || '').slice(0,10); }
  function plural(n, one, few, many){
    n = Math.abs(Math.round(Number(n)||0));
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  }

  /* ================================================================== *
   * 1) BREAK-EVEN — PLOŠNĚ 2,0 (C3, přepsáno 16. 7. / iterace 4–5)
   * ------------------------------------------------------------------
   * Filip: „Break-even bych dal plošně pro všechno, protože jinak u zásnubních/
   * snubních mít dvě linie je blbý. Nechme dva pro všechno."
   * → JEDNA hodnota 2,0 pro VŠECHNY funnely i náušnice. Per-funnel větvení
   *   (dřív snubní 2,0 / zásnubní 1,5) je ZRUŠENÉ.
   *
   * Je to SAFE hranice, ne reálná: reálný break-even je vyšší, ale počítá se s tím,
   * že se ne všechna tržba dotrackuje. Filip u ní řekl „pod tím je totálně red flag,
   * killuje" → přesně to, co tahle sekce potřebuje.
   *
   * ZDROJ PRAVDY = `?action=config` → `breakeven`. Ověřeno naostro 16. 7.:
   *   { default: 2, flat: true, funnels: {…všechny 2…}, note: "…" }
   * Čte se defenzivně (několik tvarů klíče) a `default`/`flat` mají PŘEDNOST před
   * per-funnel mapou — když je break-even plošný, není co dohledávat podle funnelu.
   * ================================================================== */
  var BE_FALLBACK = { }   /* per-funnel výjimky: ŽÁDNÉ (mechanika žije, mapa je prázdná) */;
  var BE_DEFAULT  = 2.0;  /* plošně pro VŠECHNO (i náušnice) */

  /* Vlastní kopie ?action=config.
   * PROČ: app.js si syrový config drží v closure (`var _config`) a na window.ADS ho
   * NEVYSTAVUJE — přes ADS.TH prosakují jen `thresholds` (+ ručně propašované
   * estimating_days/new_ads_days). Kdyby druhý agent přidal `breakeven` TOP-LEVEL
   * (což je u něj pravděpodobné — new_ads_days je tam taky), neviděl bych ho vůbec
   * a tiše bych jel na fallbacku. Jeden request na config to řeší natvrdo.
   * Fallback hodnoty jsou správné (Filipovy), takže selhání fetche nic nerozbije. */
  var _cfg = null;
  function loadConfig(){
    if (_cfg) return Promise.resolve(_cfg);
    return ADS.api('config', {}).then(function(c){ _cfg = c || {}; return _cfg; })
      .catch(function(){ _cfg = {}; return _cfg; });
  }
  function beMap(){
    var c = _cfg || ADS.CONFIG || {};
    return c.breakeven || c.break_even || c.BREAKEVEN ||
           (c.thresholds && (c.thresholds.BREAKEVEN || c.thresholds.breakeven)) ||
           (ADS.TH && (ADS.TH.BREAKEVEN || ADS.TH.breakeven)) || null;
  }

  /* Minimální vzorek pro závěr „je to fakt špatné" — spočítaný SERVEREM
   * (api.php kill_min_sample: (1−p)^n < α, p = base rate rezervace→prodej).
   * Čteme ho z configu, ať se nerozejde, když se base rate přeměří. */
  function minSampleFor(tab){
    var g = (_cfg && _cfg.kill_guards && _cfg.kill_guards[tab || 'rings']) || null;
    var n = g && num(g.min_sample);
    return n != null ? n : 8;   // změřeno 16. 7.: p = 27,51 % → n ≥ 8 rezervací
  }
  /** Break-even pro funnel + jestli je to JISTÁ hodnota, nebo jen odhad.
   *
   * ⚠️ V PLOŠNÉM režimu (`flat:true`, dnešní stav) je hodnota JISTÁ i pro funnel,
   *    který v mapě není — plošné 2,0 platí i pro `---` a pro náušnice. Dřív se
   *    v takovém případě vracelo `sure:false` a dlaždice psala „(odhad — pro tenhle
   *    funnel break-even nemáme)", což by dnes byla lež: máme, pro všechny stejný.
   */
  function breakevenOf(funnel){
    var m = beMap();
    if (m && typeof m === 'object'){
      var def = num(m.default) != null ? num(m.default)
              : (num(m._default) != null ? num(m._default) : null);
      // `flat` = server explicitně říká „nevětvit podle funnelu"
      if (m.flat === true && def != null) return { be: def, sure: true };
      var fmap = (m.funnels && typeof m.funnels === 'object') ? m.funnels : m;
      if (num(fmap[funnel]) != null) return { be: num(fmap[funnel]), sure: true };
      if (def != null) return { be: def, sure: true };   // plošný default JE zadaná hodnota
    }
    if (num(BE_FALLBACK[funnel]) != null) return { be: num(BE_FALLBACK[funnel]), sure: true };
    return { be: BE_DEFAULT, sure: true };   // Filipova plošná 2,0 — není to odhad
  }

  /* ================================================================== *
   * 2) ZRALOST (FEEDBACK-3 A1) — INDIKÁTOR DŮVĚRY, NE VÝPOČET
   * ------------------------------------------------------------------
   * Filipova definice: zralost = pct_call × pct_schuzek
   *   = kolik % tržby REÁLNĚ proběhlo; zbytek je dopočet.
   * Příklad: 100 leadů → provoláno 50 % → 10 schůzek → proběhlo 50 %
   *          → tržba je na 25 % reálná (dopočet dělí 0,5 a 0,5).
   *
   * ⚠️ Do ROZHODOVÁNÍ zralost NEVSTUPUJE (dopočet ji už řeší uvnitř revenue_model).
   *    Tady je JEN jako indikátor důvěry: „je rozdíl, když je dopočteno z 25 %
   *    nebo z 90 %." Jediná výjimka = gate ⭐ vs 🌟 (viz bucketOf) — ke ŠKÁLOVÁNÍ
   *    chceme důkaz, a 15% zralost důkaz není.
   *
   * ⚠️⚠️ ZMĚŘENÝ ROZPOR (16. 7., 50 kreativ s tržbou, okno 30 d) — viz report:
   *    Filipův vzorec se s reálným poměrem revenue_real/revenue_model shoduje
   *    jen ve 4 % případů (medián rozdílu 24 pb). Důvod: server počítá dopočet
   *    NA DENNÍM ŘÁDKU a pak sčítá (parita s Lookerem, SPEC §1), takže identita
   *    „zralost = převrácený dopočet" na úrovni okna neplatí.
   *    Držíme se Filipovy definice (A0/A1 ji říká doslova) a real/model ukazujeme
   *    v detailu vedle ní, ať je rozpor VIDĚT a Filip může rozhodnout.
   * ================================================================== */
  var ZRAL_RED = 0.25, ZRAL_ORANGE = 0.50, ZRAL_YELLOW = 0.75;

  /** Zralost (0..1) nebo null, když ji nelze spočítat (0 rezervací).
   *
   * ⚠️ A0 — ZDROJ PRAVDY JE SERVEROVÉ `zralost`, ne vlastní počítání. api.php ho
   *    vrací u KAŽDÉHO řádku `?action=creatives` (ověřeno naostro 16. 7.:
   *    P-287-001 → zralost 0,3283 · zralost_basis „% provolaných × % proběhlých schůzek").
   *    Tabulky i wizard čtou totéž → jedno číslo, jedno jméno, všude stejné.
   *
   * ⚠️ FALLBACK ZE `leads` BYL ROZBITÝ (opraveno): počítal `pc = called / leads`,
   *    jenže jmenovatel %call je `called_base` = řádky s NEPRÁZDNÝM `called`
   *    (prázdné se IGNORUJÍ — závazný koncept). Naostro na P-287-001:
   *      called 196 / leads 220        = 0,891   ✗ (lže o 17,3 % NULL řádků)
   *      called 196 / called_base 199  = 0,985   ✓ = to, co posílá server
   *    Fallback teď jede na `called_base` a `leads` už nesáhne. */
  function zralostOf(d){
    /* 1) server (A0 zdroj pravdy).
     * ⚠️ FEEDBACK-6/D3 — `zralost: null` je ROZHODNUTÍ SERVERU („nejde spočítat,
     *    base = 0 → žádný dopočet"), ne chybějící data. Když klíč PŘIŠEL, věřím mu
     *    včetně null a NEDOPOČÍTÁVÁM si vlastní číslo z komponent — jinak bych
     *    serveru přepsal jeho „—" na vymyšlené procento. Proto hasOwnProperty,
     *    ne `!= null`: rozlišuje „server poslal null" od „starý server pole nemá". */
    if (Object.prototype.hasOwnProperty.call(d, 'zralost')){
      var z = num(d.zralost);
      return (z == null || z < 0) ? null : Math.min(1, z);
    }
    // 2) starý server bez pole `zralost` → týž vzorec z komponent
    var pc = num(d.pct_call), ps = num(d.pct_schuzek);
    if (pc == null){
      var base = num(d.called_base);
      if (base && base > 0) pc = (num(d.called) || 0) / base;
    }
    if (ps == null){
      var b = num(d.bookings), p = num(d.passed);
      if (b != null && b > 0 && p != null) ps = p / b;
      // F7/B: 0 rezervací → nic nevzniklo, není na co čekat → komponenta = 1 (ne „nevím")
      else if (d.schuzek_empty || b === 0) ps = 1;
    }
    if (pc == null || ps == null) return null;   // rezervace jsou, výsledek neznáme → „neznámá"
    return Math.max(0, Math.min(1, pc * ps));
  }

  /** Proběhl dopočet? (FEEDBACK-6: nové pole `modeled`)
   *
   * PROČ NA TOM ZÁLEŽÍ: `zralost = null` má DVA úplně opačné významy a bez `modeled`
   * je nerozeznáš:
   *   • dopočet NEPROBĚHL (base = 0) → roas_model ≡ roas_real → čísla jsou 100% REÁLNÁ
   *     = ten NEJDŮVĚRYHODNĚJŠÍ možný stav,
   *   • data prostě nejsou → nevíme nic.
   * Kdyby se „zralost null" paušálně brala jako nedůvěra, kreativa s plně reálnou
   * tržbou by spadla z ⭐ na 🌟 — přesně naopak, než jak to je.
   * Fallback bez `modeled`: model ≡ real (do koruny) taky znamená „nedopočítáno". */
  function isModeled(d){
    if (typeof d.modeled === 'boolean') return d.modeled;
    var rr = num(d.revenue_real), rm = num(d.revenue_model);
    if (rr != null && rm != null) return Math.abs(rm - rr) > 0.01;
    return true;   // nevíme → konzervativně „dopočteno" (nižší důvěra)
  }
  /** Dá se číslům věřit? Zralost nad červeným pásmem, NEBO se vůbec nedopočítávalo. */
  function dataTrusted(d){
    var z = zralostOf(d);
    if (z != null) return z >= ZRAL_RED;
    return !isModeled(d);
  }
  /** Skutečný podíl reálné tržby na modelové — to, co dopočet OPRAVDU udělal. */
  function realShareOf(d){
    var rr = num(d.revenue_real), rm = num(d.revenue_model);
    if (rr == null || rm == null || rm <= 0) return null;
    return rr / rm;
  }
  function zralBand(z){
    if (z == null) return 'na';
    if (z < ZRAL_RED)    return 'red';
    if (z < ZRAL_ORANGE) return 'orange';
    if (z < ZRAL_YELLOW) return 'yellow';
    return 'green';
  }
  var ZRAL_TXT = {
    red:    'pod 25 % — tržba je skoro celá DOPOČTENÁ, číslu se nedá věřit',
    orange: '25–50 % — většina tržby je dopočet',
    yellow: '50–75 % — většina tržby už reálně proběhla',
    green:  'nad 75 % — tržba je skoro celá reálná, dopočet skoro nic nepřidává',
    // FEEDBACK-6/D3: „base = 0 → žádný dopočet, zralost —". Neznámá zralost proto
    // NENÍ automaticky špatná zpráva — viz isModeled(). Text musí platit pro obě větve.
    na:     'nelze spočítat — není z čeho (žádné hovory ani schůzky k poměření)'
  };
  /** Doplňující věta ke zralosti „—": řekne, CO to znamená pro čísla. */
  function zralNaNote(d){
    return isModeled(d)
      ? 'Zralost nejde spočítat, ale dopočet přesto proběhl → ROAS model ber s rezervou.'
      : 'Nic se nedopočítávalo → <b>ROAS model = ROAS real</b>, čísla jsou plně reálná.';
  }

  /** Barevný kroužek zralosti (A3). r=13 → obvod 2πr ≈ 81.68.
   *  `size`: 'sm' (seznamový řádek, 26 px) · 'lg' (detail, 56 px) · jinak 32 px.
   *  ⚠️ 'sm' se dřív TIŠE ignorovalo (test byl jen na 'lg') → kroužek v řádku vyjel
   *     32px do 40px sloupce a rozhodil mřížku. Třída `.nz-sm` v newest.css existuje. */
  function zralRingHTML(z, size){
    var band = zralBand(z);
    var pct  = (z == null) ? 0 : Math.max(0, Math.min(1, z));
    var C    = 81.68;
    var dash = (pct * C).toFixed(2) + ' ' + C;
    var label = (z == null) ? '—' : Math.round(pct * 100) + '';
    var cls  = (size === 'lg') ? ' nz-lg' : (size === 'sm' ? ' nz-sm' : '');
    var tip = 'Zralost ' + (z == null ? 'neznámá' : Math.round(pct*100) + ' %') + ' = kolik % tržby reálně proběhlo ' +
              '(provoláno × schůzky proběhly). Zbytek je dopočet. ' + ZRAL_TXT[band];
    return '<span class="nz-ring nz-' + band + cls + '" title="' + esc(tip) + '">' +
      '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
      '<circle class="nz-trk" cx="16" cy="16" r="13"/>' +
      '<circle class="nz-val" cx="16" cy="16" r="13" stroke-dasharray="' + dash + '" transform="rotate(-90 16 16)"/>' +
      '</svg><b class="nz-num">' + esc(label) + '</b></span>';
  }

  /* ================================================================== *
   * 3) FILTRY SEKCE (G2 + G3)
   * ================================================================== */

  /* --- G2: CO JE VLASTNĚ „NOVÁ KREATIVA" -----------------------------------------
   * NÁLEZ (změřeno naostro 16. 7., okno 30 d, 51 kreativ v segment=new):
   *   api.php má DVA PROTICHŮDNÉ konce téže množiny reklam:
   *     • is_new   (zařazení do sekce) = MAX(created_time) přes ady kreativy ≥ dnes−10 d
   *                → „má aspoň jednu ČERSTVĚ NAHRANOU reklamu"
   *     • age_days (popisek „stáří")   = MIN(created_time)  → „kdy kód poprvé vyjel"
   *   Kreativa se starým kódem, které někdo přidal novou reklamu, tedy spadne mezi
   *   „nové" a zároveň nese stáří 260 dní. Odtud Filipovo „stáří 71.8 rezervací":
   *   wizard renderoval doslova „nová kreativa (spuštěná v posledních 10 dnech) ·
   *   stáří 71 d · už má první data (8 rez.)" u Z-185-001.
   *   Naměřeno: 15 z 51 „nových" kreativ má age_days > 10 (max 260 d).
   *   Navíc: všech 15 má nejnovější ad z 6. 7. se STEJNÝM copy_code jako ta stará
   *   a effective_status = WITH_ISSUES → není to nová kreativa, je to RE-UPLOAD.
   *
   * ŘEŠENÍ: „nová" = kód POPRVÉ vyjel v posledních NEW_ADS_DAYS dnech (age_days),
   *   protože přesně to Filip čte v nadpisu sekce. Re-uploady nezahazujeme (server
   *   je za nové považuje) → jdou do vlastního sbaleného pásma s vysvětlením.
   * ⚠️ Tohle je client-side záplata. Správné místo je api.php (`is_new`) → notes.
   * -------------------------------------------------------------------------------- */
  function newAdsDays(){ return num(ADS.NEW_ADS_DAYS) || th('NEW_ADS_DAYS', 10); }
  function isReupload(d){
    var a = num(d.age_days);
    return a != null && a > newAdsDays();
  }

  /* --- G3: „TĚM NEDAL FACEBOOK PROSTOR" ------------------------------------------
   * Filip: „Je jich hrozně moc a některé mají spend 10 Kč — těm nedal Facebook prostor."
   * ZMĚŘENO (16. 7., 51 kreativ / 266 826 Kč v sekci):
   *   spend <  50 Kč : 12 kreativ (24 %) …    368 Kč = 0,1 % spendu sekce
   *   spend < 300 Kč : 23 kreativ (45 %) …  2 537 Kč = 1,0 % spendu sekce
   *   spend < 450 Kč : 25 kreativ (49 %) …  3 320 Kč = 1,2 % spendu sekce  ← práh
   *   → POLOVINA dlaždic by ukazovala JEDNO PROCENTO peněz. Přesně ten šum,
   *     kvůli kterému je jich „hrozně moc". A 24 z těch 25 má 0 leadů.
   *
   * PROČ zrovna 450 a ne kulatých 500: 450 = EARLY_KILL_SPEND = SPEND_NO_LEAD_MIN,
   * což UŽ JE v configu kotva „pod tímhle spendem se kreativa nedá soudit, nekilluje se"
   * (SPEC §1 vrstva 1: „< 450 = čekáme data"). Není to práh od boku — je to TÁŽ hranice,
   * jen použitá symetricky: co se nedá soudit na kill, nedá se soudit ani na hvězdu.
   * Když se práh v configu pohne, pohne se i tady sám.
   * -------------------------------------------------------------------------------- */
  function spaceMin(){ return th('EARLY_KILL_SPEND', th('SPEND_NO_LEAD_MIN', 450)); }
  function noSpace(d){ return (num(d.spend) || 0) < spaceMin(); }

  /* ================================================================== *
   * 4) G5 — ROZDĚLENÍ DO SEKCÍ
   * ------------------------------------------------------------------
   * PRAHY JSOU ODVOZENÉ, NE OD BOKU. Kotva = break-even per funnel (C3).
   *
   *   🔻 Špatné       ROAS_model < break-even  A ZÁROVEŇ je to PROKÁZANÉ
   *   ➖ Průměr       break-even ≤ ROAS_model < 2,5 × break-even
   *   ⭐/🌟 Hvězdy    ROAS_model ≥ 2,5 × break-even
   *   ⏳ Čekáme data  zbytek (spend jede, ale na soud je brzo)
   *
   * PROČ NÁSOBEK 2,5 (STAR_MULT) — REPRODUKUJE STÁVAJÍCÍ PRÁH WINNERA:
   *   config WINNER_ROAS = 5,0 (dnešní definice winnera po bumpu 17. 7., SPEC §1).
   *   Snubní 30K: break-even 2,0 × 2,5 = 5,00  → PŘESNĚ WINNER_ROAS. ✅
   *   Zásnubní 49K: 1,5 × 2,5 = 3,75 → per-funnel zobecnění téhož pravidla
   *   (globální 5,0 je pro zásnubní zbytečně přísná — jiná marže).
   *   Tzn. nezavádím nový práh, jen dělám ze stávajícího winner=5 per-funnel verzi.
   *   ⚠️ STAR_MULT je NAPOJENÝ na winner: kdyby se WINNER_ROAS zase změnil, drž
   *      STAR_MULT = WINNER_ROAS / 2 (snubní break-even) v sync, jinak Hvězdy diverují.
   *
   * PROČ pásmo „Průměr" končí u 2,5× a ne dřív — Filip (C3):
   *   „není OK být kolem toho čísla nebo těsně nad ním" → těsně nad break-even
   *   NENÍ úspěch, je to průměr. Jedno pásmo [be, 2,5×be) tohle přesně vystihuje.
   *
   * ⚠️ MALÝ VZOREK — „kreativa se 2 leady a ROAS 12 NENÍ hvězda":
   *   ⭐ vyžaduje bookings ≥ WINNER_MIN_BOOKINGS (config 5) = stávající kotva
   *   „tohle není náhoda" (SPEC §1 winner) A zralost ≥ 25 % (Filipovo červené
   *   pásmo = „číslu se nedá věřit"). Kdo práh ROASu splní, ale důkaz ne → 🌟.
   *   Naostro to funguje: P-919-003 má ROAS_model 19,39 ale jen 2 rezervace
   *   → 🌟, ne ⭐. Přesně ten případ z briefu.
   *
   * ⚠️ SYMETRIE NA DRUHOU STRANU — „Špatné" taky potřebuje důkaz:
   *   ROAS_model = 0 u kreativy s 0 rezervacemi NENÍ důkaz selhání, to je
   *   CHYBĚJÍCÍ DATA (SPEC §1: „mladou kreativu nelze soudit ROASem").
   *   Bez tohohle guardu spadlo naostro 10 z 11 dlaždic do „Špatné" — nesmysl.
   *   Za důkaz selhání bereme to, co už říká server:
   *     kill_layer > 0 (prošlo VŠEMI serverovými guardy: grace, významnost,
   *     zralost okna, minimální vzorek)  NEBO  enough_sample (rezervace ≥ 8,
   *     spočítáno z (1−p)^n < 10 %, p = 27,5 % — api.php kill_min_sample).
   * ================================================================== */
  // STAR_MULT — násobek break-even pro hranici hvězdy. 2,5 reprodukuje WINNER_ROAS=5
  // pro snubní (break-even 2,0 × 2,5 = 5,0). Napojeno na winner: viz komentář výš.
  var STAR_MULT = 2.5;
  var BUCKETS = [
    { key:'star', ico:'⭐', title:'Hvězdy',
      sub:'ROAS nad 2,5× break-even + dost rezervací + důvěryhodná zralost → kandidát na škálování' },
    { key:'pot',  ico:'🌟', title:'Potenciální hvězdy',
      sub:'ROAS vypadá skvěle, ale důkaz zatím neunese (málo rezervací nebo nízká zralost) → sledovat, neškálovat' },
    { key:'avg',  ico:'➖', title:'Průměr',
      sub:'mezi break-even a 2,5× break-even — vydělává, ale nic extra' },
    { key:'bad',  ico:'🔻', title:'Špatné',
      sub:'pod break-even a je to prokázané → red flag, kandidát na kill' },
    { key:'wait', ico:'⏳', title:'Čekáme data',
      sub:'peníze už tečou, ale na soud je zatím brzo — nekillovat' }
  ];

  function bucketOf(d){
    var b   = breakevenOf(d.funnel).be;
    var rm  = num(d.roas_model);
    var z   = zralostOf(d);
    var bk  = num(d.bookings) || 0;
    var minBk = th('WINNER_MIN_BOOKINGS', 5);

    // Důkaz selhání = server už to potvrdil, nebo máme statisticky únosný vzorek.
    var provenBad = (num(d.kill_layer) || 0) > 0 || d.enough_sample === true;

    if (rm != null && rm >= b * STAR_MULT){
      // dataTrusted() = zralost ≥ 25 %, NEBO se vůbec nedopočítávalo (model ≡ real).
      // Druhá větev je nová (FEEDBACK-6/D3): plně reálná čísla nesmí padat na 🌟.
      var proven = (bk >= minBk) && dataTrusted(d);
      return proven ? 'star' : 'pot';
    }
    if (rm != null && rm >= b) return 'avg';
    if (provenBad) return 'bad';
    return 'wait';
  }

  /** Lidsky proč je dlaždice v tom pásmu (do detailu). */
  function bucketWhy(d, key){
    var r = breakevenOf(d.funnel), b = r.be;
    var rm = num(d.roas_model), z = zralostOf(d), bk = num(d.bookings) || 0;
    var minBk = th('WINNER_MIN_BOOKINGS', 5);
    var beTxt = roasTxt(b) + (r.sure ? '' : ' <i>(odhad — pro tenhle funnel break-even nemáme)</i>');
    var out = 'break-even <b>' + beTxt + '</b> · hranice hvězdy <b>' + roasTxt(b * STAR_MULT) + '</b> (2,5× break-even)';

    // ⚠️ z může být null i u ⭐ (nedopočítávalo se → čísla jsou reálná) → nikdy „0 %".
    if (key === 'star') return out + ' → ROAS <b>' + roasTxt(rm) + '</b> nad hranicí, ' +
      'rezervací <b>' + int(bk) + '</b> ≥ ' + int(minBk) + ', ' +
      (z != null
        ? 'zralost <b>' + Math.round(z*100) + ' %</b> ≥ 25 %'
        : 'tržba <b>nedopočítávaná</b> (model = realita)') +
      ' → důkaz sedí.';
    if (key === 'pot'){
      var miss = [];
      if (bk < minBk) miss.push('rezervací jen <b>' + int(bk) + '</b> (chce to ≥ ' + int(minBk) + ' — jinak je to náhoda)');
      if (z == null && isModeled(d)) miss.push('zralost <b>—</b> (nejde spočítat, ale dopočet proběhl → nevíme, kolik z tržby je reálné)');
      else if (z != null && z < ZRAL_RED) miss.push('zralost jen <b>' + Math.round(z*100) + ' %</b> (< 25 % → tržba je skoro celá dopočet)');
      return out + ' → ROAS <b>' + roasTxt(rm) + '</b> nad hranicí, ALE ' + miss.join(' a ') + '.';
    }
    if (key === 'avg') return out + ' → ROAS <b>' + roasTxt(rm) + '</b> je nad break-even, ale pod hranicí hvězdy. ' +
      'Filip: „není OK být kolem toho čísla nebo těsně nad ním."';
    if (key === 'bad'){
      var why = (num(d.kill_layer) || 0) > 0
        ? 'server ji má jako kill kandidáta: ' + esc(d.kill_reason || d.kill_rule || '—')
        : 'vzorek <b>' + int(d.sample_n != null ? d.sample_n : bk) + '</b> rezervací už závěr unese';
      return out + ' → ROAS <b>' + roasTxt(rm) + '</b> pod break-even a ' + why + '.';
    }
    return out + ' → ROAS <b>' + roasTxt(rm) + '</b> pod break-even, ALE zatím to NENÍ prokázané ' +
      '(rezervací <b>' + int(bk) + '</b>, potřeba ≥ ' + int(minSampleFor('rings')) +
      ' na statisticky únosný soud). Chybějící data ≠ špatná kreativa — nekillovat.';
  }

  /* ================================================================== *
   * 4b) STAV „BĚŽÍ / VYPNUTO" (K4/T9) + TYP MÉDIA (K6)
   * ================================================================== */

  /** Kolik reklam kreativy BĚŽÍ.
   *
   * ZDROJ PRAVDY = serverové `active_ads` (api.php: active_ads_count → počítá JEN
   * `effective_status === 'ACTIVE'`). Vlastní počítání z `ads[]` je jen fallback pro
   * odpovědi bez `active_ads`, a MUSÍ používat týž předikát:
   *   ⚠️ `ADSET_PAUSED` / `CAMPAIGN_PAUSED` obsahují „PAUSED", ale zároveň NEJSOU
   *      „ACTIVE" — reklama neběží (vypnuto o úroveň výš) a killnout ji nejde.
   *      Test na /ACTIVE/i by je vyhodnotil správně, ale test na /PAUSED/i by
   *      u „WITH_ISSUES" lhal opačně → jediný bezpečný test je rovnost s 'ACTIVE'.
   * Filip (K4): zelená = běží ASPOŇ JEDNA reklama té kreativy. */
  function runStateOf(d){
    var ads = d.ads || [];
    var total = ads.length;
    var act = num(d.active_ads);
    if (act == null){
      act = ads.filter(function(a){ return (a.effective_status || '') === 'ACTIVE'; }).length;
    }
    return { on: act > 0, active: act, total: total };
  }
  /** Ad_id běžících reklam — jen tyhle jde reálně killnout. */
  function activeAdIds(d){
    return (d.ads || [])
      .filter(function(a){ return (a.effective_status || '') === 'ACTIVE' && a.ad_id; })
      .map(function(a){ return a.ad_id; });
  }

  /* Ikonky stavu — SVG, ne emoji (Filip T9: „malá ikonka, NE emoji"). */
  var ICO_DOT   = '<svg viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg>';
  var ICO_PAUSE = '<svg viewBox="0 0 8 8" aria-hidden="true"><rect x="1" y="0" width="2.4" height="8" rx=".7"/>' +
                  '<rect x="4.6" y="0" width="2.4" height="8" rx=".7"/></svg>';
  var ICO_PLAY  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="npl-tri" d="M8 5.2v13.6L19 12 8 5.2z"/></svg>';
  var ICO_IMG   = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v14H3V5zm2 2v8.6l4.3-4.3 3.2 3.2 3.2-3.2L19 15.6V7H5zm11.5 1.5a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2z"/></svg>';

  function runBadgeHTML(d){
    var r = runStateOf(d);
    var tip = r.on
      ? 'Běží ' + int(r.active) + ' z ' + int(r.total) + ' ' + plural(r.total,'reklamy','reklam','reklam') + ' téhle kreativy'
      : 'Neběží — všech ' + int(r.total) + ' ' + plural(r.total,'reklama je vypnutá','reklamy jsou vypnuté','reklam je vypnutých');
    return '<span class="nt-run ' + (r.on ? 'is-on' : 'is-off') + '" title="' + esc(tip) + '">' +
      (r.on ? ICO_DOT : ICO_PAUSE) + (r.on ? 'běží' : 'vypnuto') + '</span>';
  }
  function runDotHTML(d){
    var r = runStateOf(d);
    var tip = r.on ? 'Běží ' + int(r.active) + ' z ' + int(r.total) : 'Neběží (vypnuto)';
    return '<span class="nr-run ' + (r.on ? 'is-on' : 'is-off') + '" title="' + esc(tip) + '">' +
      (r.on ? ICO_DOT : ICO_PAUSE) + '</span>';
  }

  /* --- K6: video vs statika ------------------------------------------------------
   * Filip: „v těch náhledech tam bude vlevo dole malej jakoby znáček play bílej
   * s černým stínem, aby na první dobrou bylo jasný, co je video a co je statika."
   *
   * ⚠️ DATA ZATÍM NEJSOU (ověřeno 17. 7. v kódu, ne odhadem):
   *     • `ads_meta` (schema.sql) NEMÁ sloupec `media_type` — jsou tam jen
   *       thumbnail (local/big), image_url, instagram_permalink, preview_link,
   *     • api.php (compute ads[]) ho tím pádem neposílá.
   *   FEEDBACK-6 ho má jako úkol pro api.php/lib/meta.php („Chybí sloupce v ads_meta
   *   → doplnit: media_type, instagram_permalink, effective_object_story_id").
   *   lib/meta.php přitom `object_type` i `video_id` z Mety UŽ TAHÁ (řádek 347) —
   *   chybí jen uložit a poslat.
   *
   * PROTO DEFENZIVNĚ: čtu VŠECHNY tvary, které můžou přijít, a když není ani jeden,
   * vracím null → nekreslí se NIC (žádná ikonka, žádný řádek v detailu).
   * Vymýšlet si typ z názvu kreativy nebo z poměru stran náhledu = workaround, který
   * by lhal — a lež je horší než prázdno. Až api.php pole doplní, tohle se rozsvítí
   * samo, bez zásahu.  → hlášeno v `blocked`. */
  function mediaTypeOf(d){
    var a = sampleAd(d) || {};
    var raw = d.media_type || a.media_type || d.mediaType || a.mediaType || '';
    if (raw){
      raw = String(raw).toLowerCase();
      if (raw === 'video') return 'video';
      if (raw === 'static' || raw === 'image' || raw === 'photo') return 'static';
    }
    // Meta `creative.object_type`: VIDEO → video · SHARE/PHOTO/… → statika (ověřeno
    // 16. 7. na ad_id 120247354441980781, viz FEEDBACK-6 „recepty").
    var ot = d.object_type || a.object_type || '';
    if (ot){
      ot = String(ot).toUpperCase();
      if (ot === 'VIDEO') return 'video';
      if (ot === 'SHARE' || ot === 'PHOTO' || ot === 'IMAGE') return 'static';
    }
    // Přítomnost video_id je nejtvrdší důkaz videa; jeho NEpřítomnost ale důkaz
    // statiky NENÍ (pole prostě nemusí dorazit) → jen pozitivní větev.
    if (d.video_id || a.video_id) return 'video';
    return null;   // NEVÍME → nekreslit nic
  }
  function playOverlayHTML(d, cls){
    if (mediaTypeOf(d) !== 'video') return '';   // statika i „nevíme" → nic
    return '<span class="' + (cls || 'nt-play') + '" aria-hidden="true" title="Video reklama">' + ICO_PLAY + '</span>';
  }

  /** K6 — barevný řádek „video reklama / statická reklama" v detailu.
   *
   * Filip: „po rozkliknutí by tam mohl bejt řádek "video reklama / statická reklama",
   * barevně zvýrazněný." Na dlaždici stačí play znak (video) / nic (statika), ale
   * v detailu chce Filip typ NAPSANÝ — proto tady rozlišujeme i statiku explicitně.
   *
   * ⚠️ „Nevíme" ≠ „statika". Dokud api.php `media_type` neposílá, vracíme prázdno →
   *    řádek se nevykreslí vůbec. Napsat „statická reklama“ jen proto, že pole chybí,
   *    by byla vymyšlená informace u KAŽDÉ reklamy — a Filip by podle ní soudil kreativy. */
  function mediaRowHTML(d){
    var t = mediaTypeOf(d);
    if (!t) return '';
    return t === 'video'
      ? '<div class="nd-mt nd-mt-video">' + ICO_PLAY + 'Video reklama</div>'
      : '<div class="nd-mt nd-mt-static">' + ICO_IMG + 'Statická reklama</div>';
  }

  /* ================================================================== *
   * 5) RENDER — DLAŽDICE (G4)
   * ================================================================== */
  function sampleAd(d){
    return d.sample_ad || (d.ads && d.ads[0]) || null;
  }
  /* N3 (FEEDBACK-5) — Filip: „dlaždice = PLNÁ kvalita náhledu, přednačítat;
   * list view = malé stačí." → DLAŽDICE BEROU `thumbnail_big` (cache/<id>_big.jpg,
   * max 900 px), ne malý 240px thumbnail. Malý zůstává jen jako fallback.
   *
   * PROČ to jde bez obav o rychlost (změřeno naostro 16. 7. na ostrém hostu):
   *   cache/120248943065760781.jpg      =  14 kB (malý)
   *   cache/120248943065760781_big.jpg  = 149 kB (velký)
   * Dlaždic je po filtrech ~11 (ne 51 — re-uploady a „bez prostoru" jdou do sbalených
   * pásem), takže rozdíl je ~1,5 MB na jedno načtení sekce, z lokální cache stejného
   * hostu. Za to Filip dostane náhled, na kterém je vidět kreativa, ne mozaika:
   * Meta u části reklam vrací `thumbnail_url` jen 64×64 (ověřeno na Z-267-001)
   * a ten se v dlaždici 178 px roztáhne na kaši.
   *
   * `big=true` (detail) → totéž, jen ještě `image_url` jako druhá volba. */
  /* ⚠️ ZDROJ POLITIKY = SHELL (`ADS.thumbs`), ne tenhle soubor.
   * app.js si N3 politiku („dlaždice = 900px + preload · list = 240px · hover = big")
   * postavil jako JEDNO místo pravdy a výslovně počítá s tím, že si ji moduly zavolají:
   *   ADS.thumbs.forMode(ad,'tiles') → velký · ADS.thumbs.big(ad) → hover/modal
   * Adoptuju ji místo vlastního řetězce — dvě soupeřící implementace téhož jsou přesně
   * ten problém, na který doplácí KONSOLIDACE.md („každá sekce měla vlastní podmínku").
   * Bonus: shell má v app.js přechodovou pojistku, která dlaždicím dopočítávala `_big`
   * z malého URL; tímhle voláním se stává no-op, jak si ji sám zadokumentoval.
   * Fallback (vlastní řetěz) zůstává pro případ, že by ADS.thumbs nebyl — ať sekce
   * nikdy neskončí bez náhledů jen proto, že se shell změnil. */
  function thumbOf(d, big){
    var a = sampleAd(d);
    if (!a) return '';
    var T = ADS.thumbs;
    if (T) return big ? (T.big(a) || '') : (T.forMode(a, 'tiles') || '');
    if (big) return a.thumbnail_big || a.image_url || a.thumbnail || a.thumbnail_url || '';
    return a.thumbnail_big || a.thumbnail || a.image_url || a.thumbnail_url || '';   // N3: plná kvalita first
  }

  /* N3 — PŘEDNAČÍTÁNÍ. Filip: „dlaždice = plná kvalita, přednačítat."
   * Preferuju `ADS.thumbs.preloadVisible(mount)` — má IntersectionObserver s 300px
   * rootMargin, deduplikaci a strop 60 URL, takže přednačte jen to, na co se Filip
   * reálně dívá. Můj původní „stáhni všechno hned" byl hrubší a při 200 dlaždicích
   * by zaplavil spojení.
   * Fallback (bez ADS.thumbs): stáhni přes new Image(); `_pre` drží referenci, aby GC
   * neodstřelil objekt před doběhnutím requestu. */
  var _pre = [];
  function preloadThumbs(rows, mount){
    var T = ADS.thumbs;
    if (T && mount && typeof T.preloadVisible === 'function') { T.preloadVisible(mount, '[data-thumb-big]'); return; }
    if (T && typeof T.preload === 'function') { T.preload((rows || []).map(thumbOf).filter(Boolean)); return; }
    (rows || []).forEach(function(r){
      var u = thumbOf(r);
      if (!u) return;
      var im = new Image();
      im.decoding = 'async';
      im.src = u;
      _pre.push(im);
    });
    if (_pre.length > 400) _pre = _pre.slice(-200);
  }
  function createdOf(d){
    // NEJSTARŠÍ ad = kdy kód poprvé vyjel (= to, co měří age_days). Sekce mluví
    // o „spuštění kreativy", takže tady musí být stejný konec jako v age_days,
    // jinak vzniká přesně ten rozpor z G2.
    var best = '';
    (d.ads || []).forEach(function(a){
      if (a.created_time && (!best || a.created_time < best)) best = a.created_time;
    });
    return best;
  }
  function newestAdOf(d){
    var best = '';
    (d.ads || []).forEach(function(a){
      if (a.created_time && a.created_time > best) best = a.created_time;
    });
    return best;
  }

  function tileHTML(d){
    var img  = thumbOf(d);
    var z    = zralostOf(d);
    var rm   = num(d.roas_model);
    var sem  = ADS.semafor ? ADS.semafor(rm || 0) : 'red';
    var age  = num(d.age_days);
    var bk   = num(d.bookings) || 0;

    /* N3 — plná kvalita + eager. Sekce je defaultně SBALENÁ (.sec-body: max-height:0),
     * takže `loading="lazy"` by načtení odložilo až na rozbalení → Filip by koukal na
     * šedé čtverce, které doskakují. `data-thumb-big` je kontrakt shellu:
     * ADS.thumbs.preloadVisible() si podle něj najde, co přednačíst. */
    var media = img
      ? '<img class="nt-img" src="' + esc(img) + '" alt="" loading="eager" decoding="async" ' +
        'data-thumb-big="' + esc(img) + '" onerror="this.classList.add(&quot;is-off&quot;)">'
      : '<div class="nt-img is-off"></div>';
    media += playOverlayHTML(d);     // K6 — play znak vlevo dole (jen u videa)
    media += runBadgeHTML(d);        // K4 — běží / vypnuto vpravo nahoře

    var funnelChip = d.funnel
      ? '<span class="nt-fn' + (d.funnel_derived ? ' is-derived' : '') + '" title="' +
        esc(d.funnel + (d.funnel_derived ? ' (odvozeno z prefixu kódu — kreativa nemá v BQ ani jeden lead)' : '')) +
        '">' + esc(d.funnel) + (d.funnel_derived ? ' ?' : '') + '</span>'
      : '';

    /* K2 (FEEDBACK-6) — Filip: „ty tam píšeš 0 rezervací a nevidím tam kolik je lídů.
     * V těch kartách by bylo třeba CPL tolik, tolik v závorce (jeden lead). CPA tolik,
     * tolik Kč v závorce (jeden). A pod tím by byl spend."
     * → přesně tenhle tvar: dva řádky ceny s POČTEM v závorce, spend pod nimi.
     *
     * PROČ počet v závorce rozhoduje: „CPA 1 910 Kč" samo o sobě neřekne, jestli je to
     * z jedné náhody nebo z padesáti rezervací — a to je přesně rozdíl mezi „škáluj"
     * a „nesahej na to". Dřív tady visel jen počet rezervací v patičce a leady nikde.
     *
     * ⚠️ Cena umí být 0/null = „ještě se nestalo" → pomlčka, NIKDY „0 Kč" (to by se
     *    četlo jako nejlevnější kreativa v účtu, ne jako chybějící data).
     *    POČET se naopak ukazuje VŽDY, i nulový — právě ta nula je ta informace,
     *    která Filipovi chyběla. `d.cpa` je Lookerova CPA; `cps` je starší název. */
    var cplV = num(d.cpl);
    var cpaV = num(d.cpa != null ? d.cpa : d.cps);
    var lds  = num(d.leads) || 0;
    var costs =
      costCells('CPL', cplV, lds + ' ' + plural(lds, 'lead', 'leady', 'leadů'), lds,
        'Cena za lead = spend / počet leadů. V závorce počet leadů' +
        (lds ? '.' : ' — zatím žádný.')) +
      costCells('CPA', cpaV, int(bk), bk,
        'Lookerova CPA = spend / (rezervace × % hovorů). V závorce počet rezervací' +
        (bk ? '.' : ' — zatím žádná.'));

    return '' +
      '<button class="ntile" type="button" data-c="' + esc(d.creative) + '" ' +
        'title="Klikni pro detail — ' + esc(d.creative) + '">' +
        '<span class="nt-media">' + media +
          '<span class="nt-age">' + (age != null ? esc(int(age)) + ' d' : '—') + '</span>' +
        '</span>' +
        '<span class="nt-body">' +
          '<span class="nt-top"><b class="nt-code">' + esc(d.creative) + '</b>' + funnelChip + '</span>' +
          '<span class="nt-nums">' +
            '<span class="nt-roas sem-' + sem + '">' + esc(roasTxt(rm)) + '</span>' +
            zralRingHTML(z) +
          '</span>' +
          '<span class="nt-costs">' + costs + '</span>' +
          '<span class="nt-foot">' +
            '<span class="nt-fl">Spend</span>' +
            '<span class="nt-spend">' + esc(money(d.spend)) + '</span>' +
          '</span>' +
        '</span>' +
      '</button>';
  }

  /** Jeden řádek ceny na dlaždici = 3 buňky gridu (popisek · hodnota · počet).
   *  `title` nese každá buňka zvlášť — obal s display:contents by tooltip zabil. */
  function costCells(label, val, cntTxt, cntNum, tip){
    var t = ' title="' + esc(tip) + '"';
    return '<i class="nt-cl"' + t + '>' + esc(label) + '</i>' +
           '<b class="nt-cv"' + t + '>' + (val ? esc(money(val)) : '—') + '</b>' +
           '<span class="nt-cn' + (cntNum ? '' : ' is-zero') + '"' + t + '>(' + esc(cntTxt) + ')</span>';
  }

  /** Malý náhled (240 px) do seznamových řádků — N3 politika: „list view = malé stačí". */
  function thumbSmallOf(d){
    var a = sampleAd(d);
    if (!a) return '';
    var T = ADS.thumbs;
    if (T) return T.forMode(a, 'list') || '';
    return a.thumbnail || a.thumbnail_url || a.image_url || a.thumbnail_big || '';
  }

  /* --- K3: seznamový řádek --------------------------------------------------------
   * Filip o „Nedostaly prostor": „ty jsou taky dobrý. A tam chci, aby po rozkliknutí
   * jsem je viděl aspoň v tom seznamovém VIEW a mohl se podívat, co je to zač… chci
   * přesně vidět, který to byly, a ne jenom ty názvy, takže aby tam byl celý ten
   * řádek a možnost se ji rozkliknout a tak dále jako u těch ostatních."
   *
   * → Dřív tu byly JEN chipy „kód + spend". Teď plnohodnotný řádek se stejnými čísly
   *   jako na dlaždici (stav · náhled · kód · funnel · ROAS · zralost · spend · leady ·
   *   rezervace · CPL · CPA) a klik otevře TÝŽ detail jako dlaždice (K5 „sjednotit
   *   view reklamy — ať ji otevřu z karty nebo z řádku, stejný").
   * Pásmo zůstává defaultně sbalené: pořád je to šum (polovina kreativ = 1 % peněz),
   * jen se na něj teď dá pořádně podívat, ne jen přečíst názvy.
   * ------------------------------------------------------------------------------ */
  function rowHTML(d){
    var img  = thumbSmallOf(d);
    var rm   = num(d.roas_model);
    var sem  = ADS.semafor ? ADS.semafor(rm || 0) : 'red';
    var bk   = num(d.bookings) || 0;
    var lds  = num(d.leads) || 0;
    var cplV = num(d.cpl);
    var cpaV = num(d.cpa != null ? d.cpa : d.cps);

    var thumb = '<span class="nr-thw">' +
      (img ? '<img class="nr-th" src="' + esc(img) + '" alt="" loading="lazy" decoding="async" ' +
             'onerror="this.classList.add(&quot;is-off&quot;)">'
           : '<span class="nr-th is-off"></span>') +
      playOverlayHTML(d, 'nr-play') + '</span>';

    return '' +
      '<button class="nrow" type="button" data-c="' + esc(d.creative) + '" ' +
        'title="' + esc(d.creative + ' — klikni pro detail') + '">' +
        runDotHTML(d) +
        thumb +
        '<span class="nr-c">' + esc(d.creative) + '</span>' +
        '<span class="nr-fn' + (d.funnel_derived ? ' is-derived' : '') + '">' +
          esc(d.funnel || '—') + (d.funnel_derived ? ' ?' : '') + '</span>' +
        '<span class="nr-roas sem-' + sem + '">' + esc(roasTxt(rm)) + '</span>' +
        zralRingHTML(zralostOf(d), 'sm') +
        '<span class="nr-n is-spend">' + esc(money(d.spend)) + '</span>' +
        '<span class="nr-n' + (lds ? '' : ' is-dim') + '">' + esc(int(lds)) + '</span>' +
        '<span class="nr-n' + (bk ? '' : ' is-dim') + '">' + esc(int(bk)) + '</span>' +
        // Pomlčka místo „0 Kč" — stejný důvod jako na dlaždici (chybí data ≠ nula).
        '<span class="nr-n' + (cplV ? '' : ' is-dim') + '">' + (cplV ? esc(money(cplV)) : '—') + '</span>' +
        '<span class="nr-n' + (cpaV ? '' : ' is-dim') + '">' + (cpaV ? esc(money(cpaV)) : '—') + '</span>' +
      '</button>';
  }

  var LIST_HEAD =
    '<div class="nlist-hd">' +
      '<span title="Běží aspoň jedna reklama téhle kreativy?">Stav</span>' +
      '<span></span>' +
      '<span>Kreativa</span><span>Funnel</span><span>ROAS</span><span title="Zralost">Zral.</span>' +
      '<span>Spend</span><span>Leadů</span><span>Rez.</span><span>CPL</span><span>CPA</span>' +
    '</div>';

  /* --- Sbalené pásmo (re-upload / bez prostoru) — hlavička + PLNÝ seznam (K3) --- */
  function stripHTML(id, ico, title, sub, rows){
    if (!rows.length) return '';
    var spend = rows.reduce(function(s, r){ return s + (num(r.spend) || 0); }, 0);
    // Řadíme spendem desc — i tady platí „kde je nejvíc peněz, to řeš první".
    var list  = rows.slice().sort(function(x, y){ return (num(y.spend)||0) - (num(x.spend)||0); });
    return '' +
      '<div class="nstrip" data-strip="' + esc(id) + '">' +
        '<button class="nstrip-h" type="button" aria-expanded="false">' +
          '<span class="nstrip-chev" aria-hidden="true">▸</span>' +
          '<span class="nstrip-ico" aria-hidden="true">' + ico + '</span>' +
          '<b class="nstrip-t">' + esc(title) + '</b>' +
          '<span class="nstrip-n">' + rows.length + ' ' + plural(rows.length,'kreativa','kreativy','kreativ') + '</span>' +
          '<span class="nstrip-s">' + esc(money(spend)) + '</span>' +
          '<span class="nstrip-sub">' + esc(sub) + '</span>' +
        '</button>' +
        '<div class="nstrip-b">' +
          '<div class="nlist"><div class="nlist-in">' + LIST_HEAD + list.map(rowHTML).join('') + '</div></div>' +
        '</div>' +
      '</div>';
  }

  function groupHTML(b, rows){
    if (!rows.length) return '';
    var spend = rows.reduce(function(s, r){ return s + (num(r.spend) || 0); }, 0);
    return '' +
      '<section class="ngrp ngrp-' + b.key + '">' +
        '<header class="ngrp-h">' +
          '<span class="ngrp-ico" aria-hidden="true">' + b.ico + '</span>' +
          '<b class="ngrp-t">' + esc(b.title) + '</b>' +
          '<span class="ngrp-n">' + rows.length + '</span>' +
          '<span class="ngrp-s">' + esc(money(spend)) + '</span>' +
          '<span class="ngrp-sub">' + esc(b.sub) + '</span>' +
        '</header>' +
        '<div class="ngrid">' + rows.map(tileHTML).join('') + '</div>' +
      '</section>';
  }

  /* ================================================================== *
   * 6) DETAIL REKLAMY — JEDEN SPOLEČNÝ RENDERER (K5)
   * ------------------------------------------------------------------
   * Filip (K5): „obecně chci, aby byl sjednocený ten view, který se mi u té reklamy
   * ukáže — ať ji rozkliknu jako kartu, nebo jako řádek."
   * → JEDNA cesta pro VŠECHNY vstupy: dlaždice, seznamový řádek v pásmu „Nedostaly
   *   prostor" i řádek tabulky (tables.js volá ADS.renderAdDetail — viz konec souboru).
   *   Kdyby si každá sekce stavěla vlastní, znovu se rozejdou — přesně tuhle bolest
   *   popisuje KONSOLIDACE.md („každá sekce měla vlastní podmínku").
   * ================================================================== */
  function kv(label, value, tip){
    return '<div class="nd-kv"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      '<span class="nd-k">' + esc(label) + '</span><span class="nd-v">' + value + '</span></div>';
  }

  /** K1 — pojmenovaný blok detailu.
   *
   * Filip: „ty obdélníčky dole… je tam moc informací. Chtěl bych to nějak zpřehlednit,
   * aby to bylo seskupený víc do nějakejch skupinek, aby se mi to na první dobrou líp
   * skenovalo." → 12 rovnocenných buněk v jedné mřížce nedává oku ŽÁDNOU kotvu: všechny
   * mají stejnou váhu, takže se musí číst jedna po druhé. Nadpis bloku řekne, na co se
   * dívám (peníze / funnel / důvěra / stav), a uvnitř bloku spolu čísla souvisí →
   * dají se porovnávat mezi sebou, ne přes celou mřížku.
   *
   * `raw` = obsah NENÍ mřížka buněk (používá blok „Kvalita dat" s kroužkem zralosti). */
  function blk(ico, title, inner, raw){
    if (!inner) return '';
    return '<div class="nd-blk">' +
      '<div class="nd-blk-h"><span class="nd-blk-i" aria-hidden="true">' + ico + '</span>' +
        '<span class="nd-blk-t">' + esc(title) + '</span></div>' +
      (raw ? inner : '<div class="nd-grid">' + inner + '</div>') +
    '</div>';
  }

  /** Stav „běží / vypnuto" jako hodnota do mřížky (T9: ikonka, NE emoji). */
  function runKvHTML(d){
    var r = runStateOf(d);
    return '<span class="nd-run ' + (r.on ? 'is-on' : 'is-off') + '">' +
      (r.on ? ICO_DOT : ICO_PAUSE) + '<b>' + (r.on ? 'Běží' : 'Vypnuto') + '</b></span>';
  }

  function detailHTML(d){
    var z    = zralostOf(d);
    var rs   = realShareOf(d);
    var key  = bucketOf(d);
    var b    = BUCKETS.filter(function(x){ return x.key === key; })[0] || BUCKETS[4];
    var img  = thumbOf(d, true);
    var a    = sampleAd(d);
    var pc   = num(d.pct_call), ps = num(d.pct_schuzek);
    var r    = runStateOf(d);

    var media = img
      ? '<img class="nd-img" src="' + esc(img) + '" alt="" onerror="this.style.display=&quot;none&quot;">'
      : '';
    var mediaRow = mediaRowHTML(d);   // K6 — „video reklama / statická reklama"

    // Zralost — rozpad na Filipovy dvě složky + skutečný poměr real/model vedle.
    var zral =
      '<div class="nd-zral">' +
        zralRingHTML(z, 'lg') +
        '<div class="nd-zt">' +
          '<b>Zralost ' + (z == null ? 'neznámá' : Math.round(z*100) + ' %') + '</b>' +
          '<span>' + esc(ZRAL_TXT[zralBand(z)]) + '</span>' +
          /* F7/B — tři různé případy, ne dva (Filip 23. 7., L-173-001):
           *   a) 0 rezervací  → druhý krok se NEČEKÁ, zralost = jen % hovorů (dřív „—")
           *   b) obě složky známé → klasický součin
           *   c) nevíme       → „—"
           * ⚠️ Ve větvi (a) NEPSAT „schůzky proběhly 100 %" — server tam sice 1.0 posílá,
           *    ale je dosazená (schuzek_empty), ne naměřená. */
          (d.schuzek_empty && pc != null
            ? '<span class="nd-zf">provoláno <b>' + Math.round(pc*100) + ' %</b> · žádná rezervace zatím ' +
              'nevznikla, takže se na schůzky nečeká → zralost je <b>' + Math.round(pc*100) + ' %</b></span>'
            : pc != null && ps != null
            ? '<span class="nd-zf">provoláno <b>' + Math.round(pc*100) + ' %</b> × schůzky proběhly <b>' +
              Math.round(ps*100) + ' %</b> = <b>' + Math.round((pc*ps)*100) + ' %</b> tržby reálně proběhlo, ' +
              'zbytek je dopočet</span>'
            : '<span class="nd-zf">nemá rezervace → nedá se spočítat</span>') +
          (rs != null
            ? '<span class="nd-zr" title="Server počítá dopočet na denním řádku a pak sčítá (parita s Lookerem, SPEC §1), ' +
              'takže tenhle poměr se s Filipovým vzorcem nemusí shodovat. Změřeno: shoda ve 4 % případů, medián rozdílu 24 pb.">' +
              'skutečně: tržba reálná ' + esc(money(d.revenue_real)) + ' / modelová ' + esc(money(d.revenue_model)) +
              ' = <b>' + Math.round(Math.min(rs,9.99)*100) + ' %</b>' +
              (rs > 1 ? ' ⚠ model je NIŽŠÍ než realita (díra v dopočtu)' : '') + '</span>'
            : '') +
        '</div>' +
      '</div>';

    var verdict =
      '<div class="nd-verdict nd-v-' + key + '">' +
        '<b>' + b.ico + ' ' + esc(b.title) + '</b>' +
        '<span>' + bucketWhy(d, key) + '</span>' +
      '</div>';

    /* K1 — ČTYŘI BLOKY MÍSTO JEDNÉ MŘÍŽKY.
     * Dělení není estetické, ale podle OTÁZKY, na kterou blok odpovídá:
     *   💰 Peníze     — „vydělává to?"        (spend proti tržbě a ROASu)
     *   🔻 Funnel     — „kde se to láme?"     (lead → rezervace + cena za obojí)
     *   🔬 Kvalita    — „dá se tomu věřit?"   (zralost = kolik z toho je dopočet)
     *   🚦 Stav       — „co s tím je teď?"    (běží? odkdy? kolik reklam?)
     * ROAS je schválně u peněz, ne u funnelu: je to poměr tržba/spend, takže se čte
     * spolu s nimi. CPL/CPA naopak patří k funnelu — jsou to ceny za jeho kroky. */
    var mBlk = blk('💰', 'Peníze',
      kv('Spend', esc(money(d.spend)), 'kolik Meta na tuhle kreativu utratila za zvolené období') +
      kv('ROAS model', '<span class="sem-' + (ADS.semafor ? ADS.semafor(num(d.roas_model)||0) : 'red') + '">' +
         esc(roasTxt(d.roas_model)) + '</span>', 'modelová (dopočtená) ROAS — prahy jsou kotvené sem (SPEC §1)') +
      kv('ROAS real', esc(roasTxt(d.roas_real)), 'ROAS jen ze skutečně přitečených peněz, bez dopočtu') +
      kv('Tržba real', esc(money(d.revenue_real)), 'skutečně přitečené peníze') +
      kv('Tržba model', esc(money(d.revenue_model)), 'dopočtená tržba (Looker „Tržba celkem")'));

    var fBlk = blk('🔻', 'Funnel',
      kv('Leadů', esc(int(d.leads)), 'počet lead řádků (Looker lead_rows)') +
      kv('CPL', (num(d.cpl) ? esc(money(d.cpl)) : '—'), 'cena za lead = spend / počet leadů') +
      kv('Rezervací', esc(int(d.bookings)), 'vytvořené schůzky — jmenovatel CPA a zároveň vzorek pro statistiku') +
      kv('CPA', (num(d.cpa != null ? d.cpa : d.cps) ? esc(money(d.cpa != null ? d.cpa : d.cps)) : '—') +
         (num(d.bookings) ? ' <i class="nd-sm">(' + esc(int(d.bookings)) + ')</i>' : ''),
         'Lookerova CPA = spend / (rezervace × % hovorů). V závorce počet rezervací.'));

    var qBlk = blk('🔬', 'Kvalita dat', zral, true);

    /* F7/C1 — SPEND ZA POSLEDNÍCH 7 DNÍ (Filip 23. 7.: „aspoň spend za posledních sedm dnů,
     * že by bylo pole u toho stavu, jak jsou tam ty dlaždice").
     * Dolní blok „Stav" odpovídá na „co s tím je TEĎ", a právě sem to patří: ostatní čísla
     * v detailu jsou za okno z horní lišty (klidně 180 dní), takže z nich nepoznáš, jestli
     * kreativa pořád žere, nebo dojela. Načítá se AŽ po otevření detailu (wireDetail) —
     * denní řádky pro všechny kreativy v tabulce by byly zbytečně drahé. */
    var sBlk = blk('🚦', 'Stav',
      kv('Spend 7 dní', '<span class="nd-sp7 is-load">načítám…</span>',
         'kolik kreativa utratila za posledních 7 dní — vlastní okno, nezávislé na období nahoře') +
      '<div class="nd-sp7bars" hidden></div>' +
      kv('Reklamy', runKvHTML(d), 'zeleně, když běží aspoň jedna reklama téhle kreativy') +
      kv('Běží / celkem', esc(int(r.active)) + ' <i class="nd-sm">z ' + esc(int(r.total)) + '</i>',
         'kolik reklam s tímhle kódem je ACTIVE ze všech, co existují') +
      kv('Poprvé spuštěno', esc(dateTxt(createdOf(d))) + (num(d.age_days) != null ? ' <i class="nd-sm">(' + esc(int(d.age_days)) + ' d)</i>' : ''),
         'nejstarší reklama s tímhle kódem = kdy kreativa poprvé vyjela') +
      kv('Poslední ad nahrán', esc(dateTxt(newestAdOf(d))),
         'nejnovější reklama s tímhle kódem — kvůli tomuhle datu server kreativu považuje za „novou"'));

    var grid = '<div class="nd-blks">' + mBlk + fBlk + qBlk + sBlk + '</div>';

    var reup = isReupload(d)
      ? '<div class="nd-warn">⚠️ <b>Tohle není nová kreativa.</b> Kód poprvé vyjel před <b>' +
        esc(int(d.age_days)) + ' dny</b>; do „Nejnovějších" spadl jen proto, že mu ' +
        esc(dateTxt(newestAdOf(d))) + ' někdo nahrál další reklamu se stejným kódem. ' +
        'Čísla níž jsou tedy za celou historii kódu, ne za nový test.</div>'
      : '';

    var ads = (d.ads || []).slice().sort(function(x, y){
      return String(y.created_time || '').localeCompare(String(x.created_time || ''));
    });
    var adsHTML = ads.length
      ? '<div class="nd-ads"><b class="nd-ads-h">Jednotlivé reklamy (' + ads.length + ')</b>' +
        ads.map(function(x){
          var camp  = (x.campaign_name || '').trim();
          var adset = (x.adset_name || '').trim();
          // Filip: u každé reklamy vidět, KDE běží = kampaň + ad set (event + cílení).
          var metaLine = (camp || adset)
            ? '<div class="nd-ad-meta">' +
                '<span class="nd-ad-mi"><span class="nd-ad-mk">📣 Kampaň</span>' + esc(camp || '—') + '</span>' +
                '<span class="nd-ad-mi"><span class="nd-ad-mk">👥 Ad set</span>' + esc(adset || '—') + '</span>' +
              '</div>'
            : '<div class="nd-ad-meta nd-ad-meta-wait">kampaň / ad set se doplní při nejbližším Meta refreshi</div>';
          return '<div class="nd-ad">' +
            '<div class="nd-ad-top">' +
              '<span class="nd-ad-d">' + esc(dateTxt(x.created_time)) + '</span>' +
              '<span class="nd-ad-st st-' + (/PAUSED/i.test(x.effective_status||'') ? 'off' :
                 /ACTIVE/i.test(x.effective_status||'') ? 'on' : 'mid') + '">' + esc(x.effective_status || '—') + '</span>' +
              '<span class="nd-ad-c">' + esc(x.copy_code || '—') + '</span>' +
              '<span class="nd-ad-s">' + esc(money(x.spend)) + '</span>' +
              // F7/C1: spend TÉHLE reklamy za 7 dní — doplní wireDetail (viz nd-sp7)
              '<span class="nd-ad-s7" data-ad7="' + esc(x.ad_id || '') + '"></span>' +
              (x.adsmanager_link ? '<a class="nd-ad-l" href="' + esc(x.adsmanager_link) + '" target="_blank" rel="noopener">Meta ↗</a>' : '') +
            '</div>' +
            metaLine +
          '</div>';
        }).join('') + '</div>'
      : '';

    /* K4 — kill až tady, ne na dlaždici. Filip: „Nemusí být to tlačítko na té kartě,
     * ale může to být po rozkliknutí. Nebo right click." Tlačítko je vlevo (CSS
     * `.nd-kill{margin-right:auto}`), odděleně od neškodných odkazů vpravo — ať se
     * nedá trefit omylem při snaze otevřít náhled. */
    var actions = '';
    if (killableIds(d).length){
      actions += '<button class="btn btn-sm btn-danger nd-kill" type="button">Vypnout kreativu</button>';
    }
    // F1-top: přiřadit funnel přímo z detailu (stejný modal jako right-click). „---" =
    // netrackovaný agregát → nejde (ADS.assignFunnel si to navíc pohlídá i sám).
    if (d.creative && d.creative !== '---' && typeof ADS.assignFunnel === 'function'){
      actions += '<button class="btn btn-sm nd-funnel" type="button">🎯 Přiřadit funnel</button>';
    }
    if (a){
      if (a.preview_link) actions += '<a class="btn btn-sm" href="' + esc(a.preview_link) + '" target="_blank" rel="noopener">Přehrát / FB náhled</a>';
      if (a.ig)           actions += '<a class="btn btn-sm" href="' + esc(a.ig) + '" target="_blank" rel="noopener">Otevřít na IG</a>';
      if (a.adsmanager_link) actions += '<a class="btn btn-sm btn-primary" href="' + esc(a.adsmanager_link) + '" target="_blank" rel="noopener">Otevřít v Meta</a>';
    }

    /* F7/D7 — FLAGY (trvalé poznámky ke kreativě).
     * Filip 23. 7.: „aby se tam dala dát poznámka (…) já si můžu napsat poznámku, aby jsme
     * tu kreativu kontrolovali, hlídali a tak, to je užitečný. A zároveň k tomu flagu,
     * aby tam bylo datum toho flagu a mohli se tam dávat víc flagů."
     * Detail je JEDINÉ místo, kde se flagy zakládají a mažou — sloupec v tabulce a denní
     * check je jen ukazují, takže se správa nerozpadne do tří různě se chovajících míst.
     * Seznam plní wireDetail() ze sdíleného storu (může být ještě nenačtený). */
    var flagsBox =
      '<div class="nd-flags">' +
        '<b class="nd-flags-h">🚩 Poznámky ke kreativě</b>' +
        '<div class="nd-flags-list">načítám…</div>' +
        '<div class="nd-flags-add">' +
          '<input class="nd-flag-in" type="text" maxlength="500" ' +
            'placeholder="Co si o téhle kreativě pamatovat? (např. hlídat CPA po víkendu)">' +
          '<button class="btn btn-sm nd-flag-save" type="button">Přidat</button>' +
        '</div>' +
      '</div>';

    return (media ? '<div class="nd-media">' + media + '</div>' : '') +
      mediaRow + reup + verdict + grid + adsHTML + flagsBox +
      (actions ? '<div class="nd-actions">' + actions + '</div>' : '');
  }

  /* F7/D7 — vykreslení seznamu flagů + drátování přidat/smazat. */
  function flagRowHTML(f){
    return '<div class="nd-flag" data-fid="' + esc(f.id) + '">' +
      '<span class="nd-flag-d">' + esc(dateTxt(f.created_at)) + '</span>' +
      '<span class="nd-flag-t">' + esc(f.note || '') + '</span>' +
      (f.who ? '<span class="nd-flag-w">' + esc(f.who) + '</span>' : '') +
      (f.source === 'wizard' ? '<span class="nd-flag-src" title="Vznikl v denním checku">check</span>' : '') +
      '<button class="nd-flag-x" type="button" title="Smazat poznámku" aria-label="Smazat">×</button>' +
    '</div>';
  }
  function paintFlags(node, d){
    var list = node.querySelector('.nd-flags-list');
    if (!list) return;
    var fl = (ADS.flags && ADS.flags.get(d.creative)) || [];
    list.innerHTML = fl.length
      ? fl.map(flagRowHTML).join('')
      : '<div class="nd-flags-none">Zatím žádná poznámka.</div>';
  }
  function wireFlags(node, d){
    if (!ADS.flags || !d || !d.creative) return;
    // store nemusí být ještě načtený (detail se dá otevřít hned po loadu)
    ADS.flags.load().then(function(){ paintFlags(node, d); });

    var input = node.querySelector('.nd-flag-in');
    var save  = node.querySelector('.nd-flag-save');
    function add(){
      var note = (input.value || '').trim();
      // Server prázdnou poznámku odmítne (400) — nemá cenu ho tím obtěžovat
      if (!note){ input.focus(); return; }
      save.disabled = true; input.disabled = true;
      ADS.flags.add(d.creative, note, { source: 'manual' }).then(function(){
        input.value = '';
        paintFlags(node, d);
        if (ADS.toast) ADS.toast('Poznámka přidána ✓', 'success');
      }).catch(function(err){
        console.error('[flags] přidání selhalo', err);
        if (ADS.toast) ADS.toast('Poznámku se nepodařilo uložit: ' + errMsg(err), 'error');
      }).finally(function(){
        save.disabled = false; input.disabled = false; input.focus();
      });
    }
    if (save)  save.addEventListener('click', add);
    if (input) input.addEventListener('keydown', function(e){ if (e.key === 'Enter') add(); });

    var listEl = node.querySelector('.nd-flags-list');
    if (listEl) listEl.addEventListener('click', function(e){
      var x = e.target.closest('.nd-flag-x');
      if (!x) return;
      var row = x.closest('.nd-flag');
      var id  = row && row.getAttribute('data-fid');
      if (!id) return;
      x.disabled = true;
      ADS.flags.remove(id).then(function(){
        paintFlags(node, d);
      }).catch(function(err){
        console.error('[flags] mazání selhalo', err);
        if (ADS.toast) ADS.toast('Nepodařilo se smazat: ' + errMsg(err), 'error');
        x.disabled = false;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * K4 — VYPNUTÍ KREATIVY Z DETAILU
   * ------------------------------------------------------------------
   * Kontrakt killu je stejný jako v tables.js (ověřeno tam naostro): POST `kill`
   * pro KAŽDÉ ad_id zvlášť, pak se čeká, až Meta potvrdí PAUSED — API vrací OK
   * dřív, než se změna projeví, takže bez pollingu bych Filipovi hlásil úspěch,
   * který se nemusel stát. `killed` na busu pak překreslí celou sekci.
   * ------------------------------------------------------------------ */
  function killableIds(d){ return activeAdIds(d); }
  function sleep(ms){ return new Promise(function(res){ setTimeout(res, ms); }); }
  function errMsg(e){ return (e && (e.message || e.error)) ? String(e.message || e.error) : 'neznámá chyba'; }

  function performKill(ids, creative, reason){
    // Sériově, ne Promise.all: kill je mutace na cizím API — když třetí spadne,
    // chci vědět, které prošly, ne poslat pět requestů naráz a hádat.
    var chain = Promise.resolve();
    ids.forEach(function(id){
      chain = chain.then(function(){
        return ADS.api('kill', { ad_id: id, creative: creative, reason: reason }, { method: 'POST' });
      });
    });
    return chain
      .then(function(){ return pollAllPaused(ids.slice()); })
      .then(function(ok){
        if (!ok) throw new Error('Meta nepotvrdila vypnutí do 30 s — zkontroluj to v Ads Manageru.');
        return true;
      });
  }
  /** Čeká, až všechna ad_id hlásí PAUSED. Max 30 s, pak vzdát (ne nekonečno). */
  function pollAllPaused(ids){
    var deadline = Date.now() + 30000;
    function round(){
      if (!ids.length) return Promise.resolve(true);
      if (Date.now() > deadline) return Promise.resolve(false);
      return sleep(1500).then(function(){
        return Promise.all(ids.map(function(id){
          return ADS.api('ad_status', { ad_id: id })
            .then(function(res){
              var st = (res && (res.effective_status || res.status)) || '';
              return /PAUSED/i.test(st) ? id : null;   // ADSET_PAUSED taky = neběží
            })
            .catch(function(){ return null; });        // přechodná chyba → další kolo
        }));
      }).then(function(done){
        ids = ids.filter(function(id){ return done.indexOf(id) === -1; });
        return round();
      });
    }
    return round();
  }
  /** Lokální projev killu, než doběhne refetch přes bus — ať karta nelže. */
  function markKilledLocal(d){
    (d.ads || []).forEach(function(x){
      if ((x.effective_status || '') === 'ACTIVE') x.effective_status = 'PAUSED';
    });
    d.active_ads = 0;
  }
  function busKilled(detail){
    if (ADS.bus && typeof ADS.bus.dispatchEvent === 'function'){
      ADS.bus.dispatchEvent(new CustomEvent('killed', { detail: detail }));
    }
  }

  /* Potvrzení je INLINE pruh uvnitř detailu, ne druhý modal.
   * PROČ: ADS._modal() na začátku volá _closeModal() → druhý modal by zavřel detail,
   * ze kterého jsem kill spustil, a po „Zrušit" by Filip koukal na prázdno. */
  function openKillConfirm(node, d, btn){
    var ids = killableIds(d);
    if (!ids.length){
      if (ADS.toast) ADS.toast('Žádné běžící reklamy k vypnutí.', 'warn');
      return;
    }
    var box = document.createElement('div');
    box.className = 'nk-box';
    box.innerHTML =
      '<div class="nk-t">Vypnout <b>' + esc(d.creative || '') + '</b>? Zastaví ' +
        esc(int(ids.length)) + ' ' + plural(ids.length, 'běžící reklamu', 'běžící reklamy', 'běžících reklam') +
        ' · dosud utraceno ' + esc(money(d.spend)) + '.</div>' +
      '<label class="nk-r">Důvod <span>(volitelné)</span>' +
        '<textarea rows="2" placeholder="mladá / čekám data / strategická…"></textarea></label>' +
      '<div class="nk-a">' +
        '<button class="btn btn-sm nk-cancel" type="button">Zrušit</button>' +
        '<button class="btn btn-sm btn-danger nk-ok" type="button">Ano, vypnout</button>' +
      '</div>' +
      '<p class="nk-note">Vypne reklamy v Metě (PAUSED) a počká na potvrzení — pár sekund. ' +
        'Kreativa se nemaže, jde znovu zapnout v Ads Manageru.</p>';

    var actions = node.querySelector('.nd-actions');
    if (actions) node.insertBefore(box, actions); else node.appendChild(box);
    btn.disabled = true;

    var ta     = box.querySelector('textarea');
    var okBtn  = box.querySelector('.nk-ok');
    var cancel = box.querySelector('.nk-cancel');
    setTimeout(function(){ try { ta.focus(); } catch (_) {} }, 30);

    cancel.addEventListener('click', function(){
      if (box.parentNode) box.parentNode.removeChild(box);
      btn.disabled = false;
    });
    okBtn.addEventListener('click', function(){
      okBtn.disabled = true; cancel.disabled = true;
      okBtn.textContent = 'Vypínám…';
      performKill(ids, d.creative, ta.value.trim()).then(function(){
        if (ADS.toast) ADS.toast('„' + d.creative + '" vypnutá ✓', 'success');
        markKilledLocal(d);
        busKilled({ scope: 'creative', creative: d.creative, ad_ids: ids });
        if (ADS._closeModal) ADS._closeModal();   // sekce se překreslí sama přes bus
      }).catch(function(err){
        console.error('[newest] kill selhal', err);
        if (ADS.toast) ADS.toast('Kill selhal: ' + errMsg(err), 'error');
        okBtn.disabled = false; cancel.disabled = false;
        okBtn.textContent = 'Ano, vypnout';       // ať to jde zkusit znovu
      });
    });
  }

  /* F7/C1 — doplnit spend za 7 dní (dlaždice + denní proužky + per-ad).
   * Až PO otevření detailu, jedním dotazem na ?action=creative_spend.
   * Selhání je NEŠKODNÉ: dlaždice napíše „—", zbytek detailu funguje dál — kvůli
   * doplňkovému číslu nemá smysl shodit celý modal. */
  function fillSpend7(node, d){
    var tile = node.querySelector('.nd-sp7');
    if (!tile || !d || !d.creative) return;
    ADS.api('creative_spend', { creative: d.creative, days: 7 }).then(function(res){
      if (!res) throw new Error('prázdná odpověď');
      tile.classList.remove('is-load');
      tile.textContent = money(res.total);
      if (!num(res.total)) tile.classList.add('nd-sp7-zero');

      // denní proužky — 7 sloupečků, výška podle podílu na maximu (bez grafové knihovny)
      var bars = node.querySelector('.nd-sp7bars');
      var days = (res.daily || []);
      if (bars && days.length){
        var mx = 0;
        days.forEach(function(x){ var v = num(x.spend) || 0; if (v > mx) mx = v; });
        bars.innerHTML = days.map(function(x){
          var v = num(x.spend) || 0;
          var h = mx > 0 ? Math.max(3, Math.round(v / mx * 26)) : 3;
          return '<span class="nd-sp7b' + (v > 0 ? '' : ' is-off') + '" style="height:' + h + 'px" ' +
            'title="' + esc(dateTxt(x.datum) + ' · ' + money(v)) + '"></span>';
        }).join('');
        bars.hidden = false;
      }

      // per-ad rozpad — Filip chtěl denní spend „u těch jednotlivých reklam"
      var byAd = res.by_ad || {};
      node.querySelectorAll('[data-ad7]').forEach(function(el){
        var id = el.getAttribute('data-ad7');
        var v  = id && Object.prototype.hasOwnProperty.call(byAd, id) ? byAd[id] : null;
        if (v == null || !num(v)) return;             // reklama za 7 dní neutratila nic → nic nepiš
        el.textContent = '7 d: ' + money(v);
        el.classList.add('is-on');
      });
    }).catch(function(err){
      console.warn('[newest] spend 7 d se nenačetl', err);
      tile.classList.remove('is-load');
      tile.textContent = '—';
      tile.title = 'Spend za 7 dní se nepodařilo načíst';
    });
  }

  function wireDetail(node, d){
    fillSpend7(node, d);   // F7/C1
    wireFlags(node, d);    // F7/D7
    var btn = node.querySelector('.nd-kill');
    if (btn) btn.addEventListener('click', function(){
      if (node.querySelector('.nk-box')) return;   // potvrzení už je otevřené
      openKillConfirm(node, d, btn);
    });
    // F1-top
    var fn = node.querySelector('.nd-funnel');
    if (fn) fn.addEventListener('click', function(){
      if (typeof ADS.assignFunnel === 'function') ADS.assignFunnel(d);
    });
  }

  /** K5 — JEDINÝ vstup do detailu (dlaždice, řádek pásma, řádek tabulky).
   *  `o.kill` = rovnou otevřít potvrzení killu (pravý klik → „Vypnout kreativu"). */
  function openDetail(d, o){
    var node = document.createElement('div');
    node.className = 'ndet';
    node.innerHTML = detailHTML(d);
    wireDetail(node, d);
    if (ADS._modal){
      ADS._modal(node, { title: (d.creative || 'Reklama') + (d.funnel ? ' · ' + d.funnel : '') });
      if (o && o.kill){
        var kb = node.querySelector('.nd-kill');
        if (kb) kb.click();
      }
    } else if (ADS.openPreview){
      ADS.openPreview(sampleAd(d) || {});
    }
  }

  /* ================================================================== *
   * 7) SEKCE
   * ================================================================== */
  var _rows = [];     // poslední načtená data (pro rozklik)

  function mountEl(){ return document.querySelector(MOUNT); }

  /* Scaffold se pozná podle `.nwrap` = MŮJ marker, NE podle `.ads-sec-head`.
   * Proč: `.ads-sec-head` staví do stejného mountu i tables.js (ensureScaffold).
   * Kdybych testoval na něj, tak ve chvíli, kdy tables.js doběhne první, bych ho
   * uviděl, vrátil se → `.nwrap` by neexistoval → paint() by TIŠE nic neudělal.
   * (Ověřeno naostro: po reloadu vyhrál tables.js a sekce ukázala jeho tabulku
   * s „51 nových" místo mých 11 dlaždic.) */
  function scaffold(m){
    m.classList.add('ads-sec', 'newest-sec');
    if (m.querySelector('.nwrap')) return;
    m.innerHTML =
      '<div class="ads-sec-head">' +
        '<div class="ash-l"><span class="ash-emoji">🆕</span>' +
        '<span class="ash-title">Nejnovější reklamy</span>' +
        '<span class="ash-count"></span></div>' +
        '<div class="ash-r"><span class="ash-sub"></span></div>' +
      '</div>' +
      '<div class="ads-status" style="display:none"></div>' +
      '<div class="nwrap"></div>';
  }
  function setCount(m, t){ var e = m.querySelector('.ash-count'); if (e) e.textContent = t; }
  function setSub(m, t){ var e = m.querySelector('.ash-sub'); if (e) e.textContent = t; }
  function setStatus(m, state){
    var s = m.querySelector('.ads-status'); if (!s) return;
    if (!state){ s.style.display = 'none'; s.innerHTML = ''; return; }
    s.style.display = '';
    s.innerHTML = state === 'loading'
      ? '<span class="ld">Načítám dlaždice…</span>'
      : '<span class="err">Nepodařilo se načíst nejnovější reklamy.</span>';
  }

  function render(){
    var m = mountEl();
    if (!m) return;
    if ((ADS.state && ADS.state.tab) === 'earrings') return;   // sekce je jen pro prsteny

    scaffold(m);
    setStatus(m, 'loading');

    // config MUSÍ být dřív než bucketOf() — jinak by první render spočítal pásma
    // na fallback break-evenu a po doběhnutí configu by kreativy přeskákaly jinam.
    Promise.all([
      loadConfig(),
      ADS.api('creatives', { from: ADS.state.from, to: ADS.state.to, tab: 'rings', segment: 'new' })
    ]).then(function(res){
      var rows = res[1];
      _rows = Array.isArray(rows) ? rows : [];
      setStatus(m, null);
      paint(m, _rows);
    }).catch(function(e){
      console.error('[newest] fetch selhal', e);
      setStatus(m, 'error');
    });
  }

  function paint(m, rows){
    // scaffold() je idempotentní (staví jen když `.nwrap` chybí) → tímhle si beru mount
    // zpátky i v případě, že mě mezi render() a doběhnutím fetche přepsal tables.js.
    // Bez toho by `.nwrap` chybělo a paint by TIŠE spadl pod stůl (ověřeno naostro).
    scaffold(m);
    var wrap = m.querySelector('.nwrap');
    if (!wrap) return;

    var D = newAdsDays();

    // G2 → re-uploady ven; G3 → „bez prostoru" ven; zbytek = dlaždice.
    var reups   = rows.filter(isReupload);
    var fresh   = rows.filter(function(r){ return !isReupload(r); });
    var nospace = fresh.filter(noSpace);
    var tiles   = fresh.filter(function(r){ return !noSpace(r); });

    var by = {};
    BUCKETS.forEach(function(b){ by[b.key] = []; });
    tiles.forEach(function(r){ by[bucketOf(r)].push(r); });
    // V rámci pásma řadíme spendem desc — kde je nejvíc peněz, to řeš první.
    Object.keys(by).forEach(function(k){
      by[k].sort(function(x, y){ return (num(y.spend)||0) - (num(x.spend)||0); });
    });

    var html = '';
    html += '<p class="nlead">Kreativy, jejichž kód <b>poprvé vyjel v posledních ' + D + ' dnech</b>. ' +
            'Barevný kroužek = <b>zralost</b> (kolik % tržby reálně proběhlo; zbytek je dopočet). ' +
            'Klikni na dlaždici pro detail.</p>';

    BUCKETS.forEach(function(b){ html += groupHTML(b, by[b.key]); });

    if (!tiles.length){
      html += '<div class="nempty">Za tohle období nemá ani jedna nová kreativa dost spendu na vyhodnocení.</div>';
    }

    html += stripHTML('nospace', '💤', 'Nedostaly prostor',
      'Facebook jim dal pod ' + money(spaceMin()) + ' — na jakýkoli závěr je to málo (SPEC: pod tímhle prahem se ani nekilluje)',
      nospace);

    html += stripHTML('reup', '♻️', 'Není nová kreativa (re-upload)',
      'starý kód, kterému někdo nahrál novou reklamu — server je proto považuje za nové, ale kreativa běží déle než ' + D + ' dní',
      reups);

    wrap.innerHTML = html;
    guardMount(m);
    preloadThumbs(tiles, wrap);   // N3 — náhledy v cache dřív, než Filip sekci rozbalí

    setCount(m, tiles.length + ' ' + plural(tiles.length,'nová','nové','nových'));
    var parts = [];
    if (by.star.length) parts.push('⭐ ' + by.star.length);
    if (by.pot.length)  parts.push('🌟 ' + by.pot.length);
    if (by.bad.length)  parts.push('🔻 ' + by.bad.length);
    if (nospace.length) parts.push('💤 ' + nospace.length);
    setSub(m, parts.length ? parts.join(' · ') : 'čerstvé kreativy');

    wire(wrap);
  }

  /* ------------------------------------------------------------------ *
   * DOČASNÁ POJISTKA VLASTNICTVÍ MOUNTU (smazat, až integrátor vypne
   * `renderNewest()` v tables.js — viz notes_for_integrator).
   * ------------------------------------------------------------------
   * Do #newest dnes renderují DVA moduly a oba jsou ASYNCHRONNÍ (každý si
   * sám fetchne a pak přepíše innerHTML). Pořadí <script> tagů proto NIC
   * negarantuje — rozhoduje, čí fetch doběhne POZDĚJI, a to je při každém
   * načtení jinak. Ověřeno naostro: první load vyhrály dlaždice, po reloadu
   * tabulka z tables.js.
   * Řešení do doby integrace: jednorázový MutationObserver. Když mi někdo
   * `.nwrap` z mountu vykopne, překreslím se z už načtených dat (bez fetche).
   * Observer se po zásahu odpojí → žádná smyčka, i kdyby to eskalovalo.
   * ------------------------------------------------------------------ */
  var _guard = null;
  function guardMount(m){
    if (_guard){ _guard.disconnect(); _guard = null; }
    if (!window.MutationObserver) return;
    _guard = new MutationObserver(function(){
      if (m.querySelector('.nwrap')) return;      // pořád můj → klid
      _guard.disconnect(); _guard = null;
      console.warn('[newest] mount přepsal jiný modul (nejspíš tables.js renderNewest) → překresluji dlaždice.');
      scaffold(m); setStatus(m, null); paint(m, _rows);
    });
    _guard.observe(m, { childList: true, subtree: false });
  }

  function rowByCode(code){
    for (var i = 0; i < _rows.length; i++){
      if (_rows[i].creative === code) return _rows[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * K4 — KONTEXTOVÉ MENU (pravý klik na dlaždici i na řádku)
   * ------------------------------------------------------------------
   * Filip: „chtěl bych tam mít možnost kilnout přímo z té karty. Nemusí být to
   * tlačítko na té kartě, ale může to být po rozkliknutí. Nebo right click."
   * → tlačítko na kartě NENÍ (tlouklo by se se stavovou tečkou a dalo by se
   *   trefit omylem), kill je v detailu A tady.
   * Menu je JEDNO na dokument — druhé otevření to první zavře, takže v DOMu
   * nikdy nezůstane viset víc menu najednou.
   * ------------------------------------------------------------------ */
  var _ctx = null;
  function closeCtx(){
    if (_ctx && _ctx.parentNode) _ctx.parentNode.removeChild(_ctx);
    _ctx = null;
  }

  function openCtx(x, y, d){
    closeCtx();
    var ids = killableIds(d);
    var a   = sampleAd(d) || {};
    var items = [{ k: 'detail', ico: '🔍', label: 'Otevřít detail' }];
    if (ids.length){
      items.push({ k: 'kill', ico: '🔴', danger: true,
        label: 'Vypnout kreativu' + (ids.length > 1 ? ' (' + ids.length + ' reklam)' : '') });
    }
    // F1-newest-rmb: přiřazení funnelu i z pravého kliku (jako v tabulce). „---" = agregát → ne.
    if (d.creative && d.creative !== '---' && typeof ADS.assignFunnel === 'function'){
      items.push({ k: 'funnel', ico: '🎯', label: 'Přiřadit k funnelu…' });
    }
    if (a.adsmanager_link) items.push({ k: 'meta', ico: '↗', label: 'Otevřít v Ads Manageru', href: a.adsmanager_link });
    if (a.ig)              items.push({ k: 'ig',   ico: '↗', label: 'Otevřít na Instagramu',  href: a.ig });
    if (a.preview_link)    items.push({ k: 'fb',   ico: '↗', label: 'Náhled na Facebooku',    href: a.preview_link });

    var m = document.createElement('div');
    m.className = 'nctx';
    m.innerHTML =
      '<div class="nctx-h">' + esc(d.creative || '') + '</div>' +
      items.map(function(it){
        var inner = '<span class="nctx-ico" aria-hidden="true">' + it.ico + '</span>' + esc(it.label);
        return it.href
          ? '<a class="nctx-i" href="' + esc(it.href) + '" target="_blank" rel="noopener">' + inner + '</a>'
          : '<button class="nctx-i' + (it.danger ? ' is-danger' : '') + '" type="button" data-k="' +
            esc(it.k) + '">' + inner + '</button>';
      }).join('');
    document.body.appendChild(m);
    _ctx = m;

    // Umístění až PO vložení do DOMu — u pravého/dolního okraje by se menu jinak
    // oříznulo a poslední položka (často zrovna kill) by nešla trefit.
    var r  = m.getBoundingClientRect();
    var px = Math.min(x, window.innerWidth  - r.width  - 8);
    var py = Math.min(y, window.innerHeight - r.height - 8);
    m.style.left = Math.max(8, px) + 'px';
    m.style.top  = Math.max(8, py) + 'px';

    m.addEventListener('click', function(ev){
      var b = ev.target.closest('.nctx-i');
      if (!b) return;
      var k = b.getAttribute('data-k');
      closeCtx();
      if (k === 'detail')    openDetail(d);
      else if (k === 'kill') openDetail(d, { kill: true });
      else if (k === 'funnel' && typeof ADS.assignFunnel === 'function') ADS.assignFunnel(d);
      // položky s href si otevře prohlížeč sám (target=_blank)
    });
  }

  /* Zavření menu: klik jinam · Escape · scroll (jinak by viselo mimo dlaždici).
   * Registruje se JEDNOU na dokument, ne při každém otevření — jinak by se
   * posluchače hromadily s každým pravým klikem. */
  document.addEventListener('mousedown', function(ev){
    if (_ctx && !_ctx.contains(ev.target)) closeCtx();
  }, true);
  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape') closeCtx();
  });
  window.addEventListener('scroll', closeCtx, true);

  function wire(wrap){
    wrap.onclick = function(ev){
      var strip = ev.target.closest('.nstrip-h');
      if (strip){
        var box = strip.parentNode;
        var open = box.classList.toggle('is-open');
        strip.setAttribute('aria-expanded', open ? 'true' : 'false');
        return;
      }
      /* K3 + K5 — řádek pásma se rozklikne stejně jako dlaždice a ukáže TÝŽ detail.
       * Filip: „…a možnost se ji rozkliknout a tak dále jako u těch ostatních."
       * Dřív se tu chytala jen `.ntile` → řádky se vykreslily, ale klik nic nedělal. */
      var t = ev.target.closest('.ntile,.nrow');
      if (!t) return;
      var d = rowByCode(t.getAttribute('data-c'));
      if (d) openDetail(d);
    };

    wrap.oncontextmenu = function(ev){
      var t = ev.target.closest('.ntile,.nrow');
      if (!t) return;
      var d = rowByCode(t.getAttribute('data-c'));
      if (!d) return;
      ev.preventDefault();
      openCtx(ev.clientX, ev.clientY, d);
    };
  }

  /* ================================================================== *
   * 7b) NÁUŠNICE — SOUHRN SLEPÉ SKVRNY (FEEDBACK-5, bod 6 Filipových odpovědí)
   * ------------------------------------------------------------------
   * Filip: „nemaj leady, ale když spálí víc než ~2× průměrný cost per reservation,
   * označit jako špatné… + přidat souhrnný řádek 'X kreativ bez poptávky spálilo Y Kč'
   * s rozklikem."
   *
   * PROČ TO MUSÍ BÝT SOUHRN A NE PRÁH (rozbor z config.sample.php G1 + FEEDBACK-5):
   *   Slepá skvrna NENÍ pár drahých kreativ — je to DLOUHÝ OCAS levných. Změřeno
   *   naostro 16. 7. (30 d, 55 kreativ, 43 809 Kč spendu náušnic):
   *     44 kreativ má 0 poptávek a spálilo 11 689 Kč (26,7 % spendu tabu)
   *     z toho 42 kreativ / 8 298 Kč (18,9 %) NECHYTÍ ŽÁDNÝ PRÁH — každá je
   *     jednotlivě legitimně v pásmu „čekáme data" (medián ~260 Kč, 30 z nich < 500 Kč).
   *   Žádný PER-KREATIVA práh na to nedosáhne. Je to PORTFOLIOVÝ problém → jediná
   *   poctivá odpověď je sečíst to a ukázat jako JEDNO číslo.
   *
   * ZDROJ ČÍSEL: `overview.blind_spot` {creatives, spend, pct_of_spend}, až ho api.php
   * začne posílat (16. 7. ho ostrý server NEPOSÍLÁ — ověřeno curlem, vrací null).
   * Dokud nedorazí, počítá se TOTÉŽ client-side z `?action=creatives`. Seznam kreativ
   * do rozkliku se bere z creatives VŽDY (overview seznam nenese). Když se serverové
   * a spočítané číslo rozejdou, VĚŘÍ SE SERVERU a rozdíl se napíše — nikdy potichu.
   * ================================================================== */
  var BS_MOUNT_ID = 'earrings-blindspot';
  var _bsRows = [];

  /** Kreativy, které tečou naprázdno: 0 poptávek A ZÁROVEŇ je nechytá žádný práh.
   *  `kill_layer > 0` = server je už flagnul → ty do slepé skvrny NEPATŘÍ (jsou vidět
   *  v „Na kill"). Slepá skvrna je z definice to, co jinak NIKDE nevyskočí. */
  function blindRows(rows){
    return rows.filter(function(r){
      return (num(r.leads) || 0) === 0 && (num(r.kill_layer) || 0) === 0;
    });
  }

  function bsMount(){
    var host = document.getElementById('earrings-root');
    if (!host) return null;
    var el = document.getElementById(BS_MOUNT_ID);
    if (el) return el;
    el = document.createElement('section');
    el.id = BS_MOUNT_ID;
    el.className = 'section bs-sec';
    // Nahoru nad „Na kill": je to otázka „kam tečou peníze, aniž by to někde vyskočilo",
    // takže musí být VIDĚT dřív než tabulky, ne schovaná pod nimi.
    host.insertBefore(el, host.firstElementChild);
    return el;
  }

  function renderBlindSpot(){
    if ((ADS.state && ADS.state.tab) !== 'earrings'){
      var old = document.getElementById(BS_MOUNT_ID);
      if (old) old.innerHTML = '';      // jiný tab → nic (jen náušnice, dle zadání)
      return;
    }
    var m = bsMount();
    if (!m) return;

    Promise.all([
      ADS.api('overview',  { from: ADS.state.from, to: ADS.state.to, tab: 'earrings' }).catch(function(){ return {}; }),
      ADS.api('creatives', { from: ADS.state.from, to: ADS.state.to, tab: 'earrings', segment: 'all' })
    ]).then(function(res){
      var ov   = res[0] || {};
      var rows = Array.isArray(res[1]) ? res[1] : [];
      _bsRows = blindRows(rows).sort(function(x, y){ return (num(y.spend)||0) - (num(x.spend)||0); });

      var totalSpend = rows.reduce(function(s, r){ return s + (num(r.spend) || 0); }, 0);
      var myN    = _bsRows.length;
      var mySp   = _bsRows.reduce(function(s, r){ return s + (num(r.spend) || 0); }, 0);
      var myPct  = totalSpend > 0 ? (mySp / totalSpend) : 0;

      // server má přednost, když ho pošle (task api.php #35)
      var srv = ov.blind_spot || (ov.overview && ov.overview.blind_spot) || null;
      var n   = (srv && num(srv.creatives) != null) ? num(srv.creatives) : myN;
      var sp  = (srv && num(srv.spend) != null)     ? num(srv.spend)     : mySp;
      var pct = (srv && num(srv.pct_of_spend) != null) ? num(srv.pct_of_spend) : myPct;
      if (pct > 1) pct = pct / 100;                 // server může poslat 19 místo 0,19
      var mismatch = (srv && (n !== myN || Math.abs(sp - mySp) > 1));

      paintBlindSpot(m, { n: n, spend: sp, pct: pct, mismatch: mismatch, myN: myN, mySpend: mySp });
    }).catch(function(e){
      console.error('[newest] blind_spot fetch selhal', e);
      m.innerHTML = '';
    });
  }

  function paintBlindSpot(m, o){
    if (!o.n){
      m.innerHTML = '';
      return;   // žádná slepá skvrna → neotravuj prázdnou kartou
    }
    var codes = _bsRows.map(function(r){
      return '<span class="bs-c" title="' + esc(r.creative + ' · ' + money(r.spend) +
             ' · ' + int(r.age_days) + ' d') + '">' +
             esc(r.creative) + ' <i>' + esc(money(r.spend)) + '</i></span>';
    }).join('');

    m.innerHTML =
      '<div class="bs-card">' +
        '<button class="bs-h" type="button" aria-expanded="false" aria-controls="bs-body">' +
          '<span class="bs-chev" aria-hidden="true">▸</span>' +
          '<span class="bs-ico" aria-hidden="true">🕳️</span>' +
          '<span class="bs-txt">' +
            '<b class="bs-t">' + esc(int(o.n)) + ' ' + plural(o.n,'kreativa','kreativy','kreativ') +
            ' bez jediné poptávky spálilo ' + esc(money(o.spend)) + '</b>' +
            '<span class="bs-sub">= <b>' + esc(Math.round(o.pct * 100)) + ' %</b> spendu náušnic. ' +
            'Jednotlivě je žádný práh nechytí — každá je sama o sobě moc levná na to, ' +
            'aby se dala soudit. Dohromady je to ale díra. <u>Rozklikni seznam</u>.</span>' +
          '</span>' +
          '<span class="bs-pct">' + esc(Math.round(o.pct * 100)) + '&nbsp;%</span>' +
        '</button>' +
        '<div class="bs-b" id="bs-body">' +
          '<p class="bs-note">Řazeno podle spálených peněz. „Bez poptávky" = 0 poptávek za ' +
          'zvolené období a zároveň kreativu neflagnul žádný kill práh (ty jsou v sekci ' +
          '<b>Náušnice — na kill</b>). Je to <b>portfoliový</b> pohled, ne seznam ke killu: ' +
          'jednotlivé kreativy tu můžou být legitimně čerstvé.' +
          (o.mismatch
            ? ' <b class="bs-warn">⚠ Server hlásí ' + esc(int(o.n)) + ' kreativ / ' +
              esc(money(o.spend)) + ', spočítáno z řádků vychází ' + esc(int(o.myN)) + ' / ' +
              esc(money(o.mySpend)) + ' — zobrazeno serverové číslo, seznam je ze řádků.</b>'
            : '') +
          '</p>' +
          '<div class="bs-codes">' + codes + '</div>' +
        '</div>' +
      '</div>';

    var h = m.querySelector('.bs-h');
    h.addEventListener('click', function(){
      var open = m.querySelector('.bs-card').classList.toggle('is-open');
      h.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ================================================================== *
   * 8) REGISTRACE + STYLY
   * ================================================================== */
  /* P1-B (K5-root) — bohatý detail reklamy sdílený i HLAVNÍ tabulkou (tables.js).
   * Dřív měla hlavní tabulka jen starý „Náhled kreativy" (app.js openPreview) bez
   * play badge / video-statika řádku / kroužku zralosti / K1 skupin. Tady to
   * vystavíme na window.ADS, ať tables.js otevírá TENTÝŽ detail.
   * Guard: detail počítá pásma z configu (break-even, prahy). Když config ještě
   * nemáme (uživatel klikl dřív, než se vykreslila sekce Nejnovější), dotáhneme ho
   * a teprve pak otevřeme — jinak by pásma spadla na fallback break-even. */
  ADS.openDetail = function(d, o){
    if (!d) return;
    loadConfig().then(function(){ openDetail(d, o); })
                .catch(function(){ openDetail(d, o); });
  };

  ADS.onReady(function(){ render(); renderBlindSpot(); });

  if (ADS.bus && typeof ADS.bus.addEventListener === 'function'){
    ADS.bus.addEventListener('killed', function(){ render(); renderBlindSpot(); });
  }

  injectStyles();

  function injectStyles(){
    if (document.getElementById('ads-newest-css')) return;
    var css = `
.newest-sec .nlead{margin:0 2px 14px;font-size:12.5px;color:var(--text-2);line-height:1.5}
.newest-sec .nempty{padding:16px;color:var(--text-3);font-size:13px;background:var(--surface-2);
  border:1px dashed var(--border);border-radius:var(--r-md);margin-bottom:12px}

/* --- skupina (pásmo) --- */
.ngrp{margin:0 0 18px}
.ngrp-h{display:flex;align-items:baseline;gap:8px;margin:0 2px 8px;padding-bottom:6px;
  border-bottom:1px solid var(--border);flex-wrap:wrap}
.ngrp-ico{font-size:14px}
.ngrp-t{font-size:14px;font-weight:700;letter-spacing:-.01em}
.ngrp-n{font-size:11.5px;font-weight:700;color:var(--text-inv);background:var(--text-3);
  border-radius:var(--r-pill);padding:1px 7px;min-width:18px;text-align:center}
.ngrp-s{font-size:12px;color:var(--text-2);font-variant-numeric:tabular-nums;font-weight:600}
.ngrp-sub{font-size:11.5px;color:var(--text-3);font-style:italic;flex:1 1 220px;min-width:0}
.ngrp-star .ngrp-n{background:var(--green)}
.ngrp-pot  .ngrp-n{background:var(--lgreen)}
.ngrp-avg  .ngrp-n{background:var(--text-3)}
.ngrp-bad  .ngrp-n{background:var(--red)}
.ngrp-wait .ngrp-n{background:var(--info)}

/* --- mřížka dlaždic --- */
.ngrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:10px}

.ntile{display:flex;flex-direction:column;text-align:left;padding:0;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);
  box-shadow:var(--shadow-xs);overflow:hidden;font:inherit;color:inherit;
  transition:box-shadow .14s ease,transform .14s ease,border-color .14s ease}
.ntile:hover{box-shadow:var(--shadow-md);transform:translateY(-2px);border-color:var(--border-strong)}
.ntile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* Náhled má PEVNÝ čtverec, ať dlaždice v řádku lícují.
   ⚠️ aspect-ratio SAMO NESTAČÍ (ověřeno naostro): obrázek v normálním toku s
   height:100% neumí rozřešit procento vůči aspect-derived výšce → spadne na auto,
   vykreslí se v přirozeném poměru (192×240 → 226 px) a min-height:auto nechá box
   NARŮST přes aspect-ratio. Naměřeno: media 181×226 u portrétů vs 181×181 u
   čtvercových 64×64 náhledů → dlaždice v řádku nelícovaly.
   Řešení: obrázek ven z toku (position:absolute) → box si drží 1:1 vždy. */
.nt-media{position:relative;display:block;aspect-ratio:1/1;background:var(--surface-3);overflow:hidden}
.nt-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.nt-img.is-off{background:repeating-linear-gradient(45deg,var(--surface-3),var(--surface-3) 6px,var(--surface-2) 6px,var(--surface-2) 12px)}
.nt-age{position:absolute;top:6px;left:6px;font-size:10.5px;font-weight:700;
  background:rgba(35,38,46,.72);color:#fff;border-radius:var(--r-pill);padding:1px 6px;
  font-variant-numeric:tabular-nums;letter-spacing:.01em}

.nt-body{display:flex;flex-direction:column;gap:6px;padding:8px 9px 9px}
.nt-top{display:flex;align-items:center;gap:5px;min-width:0}
.nt-code{font-family:var(--mono);font-size:11.5px;font-weight:700;letter-spacing:-.02em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nt-fn{font-size:9.5px;font-weight:600;color:var(--text-2);background:var(--surface-3);
  border-radius:var(--r-pill);padding:1px 5px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:78px;flex:0 1 auto}
.nt-fn.is-derived{border:1px dashed var(--border-strong);background:transparent;font-style:italic}

.nt-nums{display:flex;align-items:center;justify-content:space-between;gap:6px}
.nt-roas{font-size:17px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.nt-roas.sem-green{color:var(--green)} .nt-roas.sem-lgreen{color:var(--lgreen)}
.nt-roas.sem-yellow{color:var(--yellow)} .nt-roas.sem-orange{color:var(--orange)}
.nt-roas.sem-red{color:var(--red)}

/* --- N8: CPL + CPA na dlaždici ---
   Dva peněžní údaje vedle sebe potřebují popisek, jinak se nepoznají (CPA bývá
   10–50x CPL). Popisek (i) je malý a tlumený, hodnota nese váhu.
   POZOR: tenhle blok je uvnitř template literalu — ŽÁDNÉ zpětné apostrofy v komentáři,
   ukončily by řetězec (přesně to se tu 16. 7. stalo). */
.nt-costs{display:flex;align-items:center;gap:6px;justify-content:space-between}
.nt-cost{display:inline-flex;align-items:baseline;gap:4px;min-width:0;
  font-size:11px;font-weight:700;color:var(--text-2);font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:help}
.nt-cost i{font-style:normal;font-size:9px;font-weight:700;color:var(--text-3);
  letter-spacing:.04em;text-transform:uppercase;flex:0 0 auto}

.nt-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;
  font-size:11px;color:var(--text-2);font-variant-numeric:tabular-nums;
  border-top:1px solid var(--border);padding-top:6px}
.nt-spend{font-weight:700}
.nt-bk{color:var(--text-3)}

/* --- kroužek zralosti (A3): <25 č · 25-50 o · 50-75 ž · >75 z --- */
.nz-ring{position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;flex:0 0 auto;cursor:help}
.nz-ring svg{width:100%;height:100%;display:block}
.nz-trk{fill:none;stroke:var(--surface-3);stroke-width:4}
.nz-val{fill:none;stroke-width:4;stroke-linecap:round;transition:stroke-dasharray .3s ease}
.nz-num{position:absolute;font-size:9.5px;font-weight:800;font-variant-numeric:tabular-nums;
  letter-spacing:-.03em}
.nz-red    .nz-val{stroke:var(--red)}    .nz-red    .nz-num{color:var(--red)}
.nz-orange .nz-val{stroke:var(--orange)} .nz-orange .nz-num{color:var(--orange)}
.nz-yellow .nz-val{stroke:var(--yellow)} .nz-yellow .nz-num{color:var(--yellow)}
.nz-green  .nz-val{stroke:var(--green)}  .nz-green  .nz-num{color:var(--green)}
.nz-na     .nz-val{stroke:transparent}   .nz-na     .nz-num{color:var(--text-3)}
.nz-lg{width:56px;height:56px;flex:0 0 auto}
.nz-lg .nz-num{font-size:15px}

/* --- sbalené pásmo --- */
.nstrip{border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-2);
  margin:0 0 8px;overflow:hidden}
.nstrip-h{display:flex;align-items:center;gap:8px;width:100%;padding:9px 11px;cursor:pointer;
  background:none;border:0;font:inherit;color:inherit;text-align:left;flex-wrap:wrap}
.nstrip-h:hover{background:var(--surface-3)}
.nstrip-chev{font-size:10px;color:var(--text-3);transition:transform .15s ease;display:inline-block}
.nstrip.is-open .nstrip-chev{transform:rotate(90deg)}
.nstrip-t{font-size:13px;font-weight:700}
.nstrip-n{font-size:11.5px;font-weight:700;color:var(--text-2);background:var(--surface-3);
  border-radius:var(--r-pill);padding:1px 7px}
.nstrip-s{font-size:12px;font-weight:700;color:var(--text-2);font-variant-numeric:tabular-nums}
.nstrip-sub{font-size:11.5px;color:var(--text-3);font-style:italic;flex:1 1 200px;min-width:0}
/* Rozbalení pásma = TVRDÝ display toggle, ŽÁDNÁ max-height animace.
   PROČ (ověřeno naostro): sekce „Nejnovější" je defaultně SBALENÁ (.sec-body má
   max-height:0 + visibility:hidden), takže se pásmo vždycky vyrábí uvnitř neviditelného
   podstromu. Transition max-height z 0 na 640px, nastartovaný v takovém stavu, zůstane
   zaseknutý na 0px — computed max-height držel 0px i po kliknutí, obsah (64 px) se
   nezobrazil, a vypnutí transition ho okamžitě vrátilo na 640px = důkaz příčiny.
   Filipa by to trefilo při KAŽDÉM načtení, tak radši žádná animace než zaseknuté pásmo. */
.nstrip-b{display:none}
.nstrip.is-open .nstrip-b{display:block;max-height:640px;overflow:auto}
.nstrip-codes{display:flex;flex-wrap:wrap;gap:5px;padding:4px 11px 11px}
.nstrip-c{font-family:var(--mono);font-size:10.5px;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r-xs);padding:2px 6px;white-space:nowrap}
.nstrip-c i{color:var(--text-3);font-style:normal;font-variant-numeric:tabular-nums}

/* --- detail modal --- */
.ndet{display:flex;flex-direction:column;gap:12px}
.nd-media{text-align:center}
.nd-img{max-width:100%;max-height:280px;border-radius:var(--r-sm);display:inline-block}
.nd-warn{font-size:12.5px;line-height:1.5;background:var(--yellow-bg);border:1px solid var(--yellow-bd);
  border-radius:var(--r-sm);padding:9px 11px;color:var(--text)}
.nd-verdict{display:flex;flex-direction:column;gap:3px;padding:9px 11px;border-radius:var(--r-sm);
  border:1px solid var(--border);background:var(--surface-2)}
.nd-verdict b{font-size:13.5px}
.nd-verdict span{font-size:12px;color:var(--text-2);line-height:1.5}
.nd-v-star{background:var(--green-bg);border-color:var(--green-bd)}
.nd-v-pot{background:var(--lgreen-bg);border-color:var(--lgreen-bd)}
.nd-v-bad{background:var(--red-bg);border-color:var(--red-bd)}
.nd-v-wait{background:var(--info-bg);border-color:var(--info-bd)}

.nd-zral{display:flex;align-items:flex-start;gap:12px;padding:10px 11px;border:1px solid var(--border);
  border-radius:var(--r-sm);background:var(--surface-2)}
.nd-zt{display:flex;flex-direction:column;gap:3px;min-width:0}
.nd-zt b{font-size:13px}
.nd-zt span{font-size:11.5px;color:var(--text-2);line-height:1.5}
.nd-zf{color:var(--text-2)}
.nd-zr{color:var(--text-3) !important;cursor:help;border-top:1px dashed var(--border);padding-top:4px;margin-top:2px}

.nd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden}
.nd-kv{display:flex;flex-direction:column;gap:2px;padding:7px 9px;background:var(--surface)}
.nd-k{font-size:10.5px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.nd-v{font-size:13.5px;font-weight:700;font-variant-numeric:tabular-nums}
.nd-v .sem-green{color:var(--green)} .nd-v .sem-lgreen{color:var(--lgreen)}
.nd-v .sem-yellow{color:var(--yellow)} .nd-v .sem-orange{color:var(--orange)}
.nd-v .sem-red{color:var(--red)}
.nd-sm{font-size:11px;color:var(--text-3);font-weight:500;font-style:normal}

.nd-ads{border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden}
.nd-ads-h{display:block;font-size:11.5px;padding:6px 9px;background:var(--surface-2);
  border-bottom:1px solid var(--border)}
.nd-ad{display:flex;flex-direction:column;gap:4px;padding:6px 9px;font-size:11.5px;
  border-bottom:1px solid var(--border)}
.nd-ad:last-child{border-bottom:0}
.nd-ad-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* Filip: kampaň + ad set (event + cílení) u každé reklamy — druhý řádek pod hlavičkou. */
.nd-ad-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;color:var(--text-2)}
.nd-ad-mi{display:inline-flex;align-items:baseline;gap:5px;min-width:0}
.nd-ad-mk{color:var(--text-3);font-weight:700;white-space:nowrap}
.nd-ad-meta-wait{color:var(--text-3);font-style:italic}
.nd-ad-d{color:var(--text-2);font-variant-numeric:tabular-nums;min-width:74px}
.nd-ad-st{font-size:10px;font-weight:700;border-radius:var(--r-pill);padding:1px 6px}
.nd-ad-st.st-on{background:var(--green-bg);color:var(--green)}
.nd-ad-st.st-off{background:var(--surface-3);color:var(--text-3)}
.nd-ad-st.st-mid{background:var(--yellow-bg);color:var(--yellow)}
.nd-ad-c{font-family:var(--mono);font-size:10.5px;color:var(--text-2);flex:1 1 90px;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd-ad-s{font-weight:700;font-variant-numeric:tabular-nums;margin-left:auto}
.nd-ad-l{font-size:10.5px;color:var(--accent);text-decoration:none;white-space:nowrap}
.nd-ad-l:hover{text-decoration:underline}
.nd-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}

/* --- NÁUŠNICE: souhrn slepé skvrny (FEEDBACK-5) ---
   Není to alarm (nic se nemá killnout), je to UPOZORNĚNÍ na portfoliovou díru →
   žlutá, ne červená. Červená je v tomhle dashboardu vyhrazená pro „kill teď". */
.bs-sec{margin-bottom:14px}
.bs-card{border:1px solid var(--yellow-bd);background:var(--yellow-bg);
  border-radius:var(--r-md);overflow:hidden}
.bs-h{display:flex;align-items:center;gap:10px;width:100%;padding:11px 13px;cursor:pointer;
  background:none;border:0;font:inherit;color:inherit;text-align:left}
.bs-h:hover{background:rgba(0,0,0,.03)}
.bs-h:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.bs-chev{font-size:11px;color:var(--text-3);transition:transform .15s ease;flex:0 0 auto}
.bs-card.is-open .bs-chev{transform:rotate(90deg)}
.bs-ico{font-size:17px;flex:0 0 auto}
.bs-txt{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.bs-t{font-size:13.5px;font-weight:700;line-height:1.35}
.bs-sub{font-size:11.5px;color:var(--text-2);line-height:1.5}
.bs-sub u{text-underline-offset:2px}
.bs-pct{font-size:22px;font-weight:800;color:var(--orange);flex:0 0 auto;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bs-b{display:none}
.bs-card.is-open .bs-b{display:block;border-top:1px solid var(--yellow-bd);
  background:var(--surface);max-height:340px;overflow:auto}
.bs-note{margin:0;padding:9px 13px 6px;font-size:11.5px;color:var(--text-2);line-height:1.55}
.bs-warn{color:var(--orange)}
.bs-codes{display:flex;flex-wrap:wrap;gap:5px;padding:4px 13px 12px}
.bs-c{font-family:var(--mono);font-size:10.5px;background:var(--surface-2);
  border:1px solid var(--border);border-radius:var(--r-xs);padding:2px 6px;white-space:nowrap}
.bs-c i{color:var(--text-3);font-style:normal;font-variant-numeric:tabular-nums}

@media(max-width:640px){
  .ngrid{grid-template-columns:repeat(auto-fill,minmax(142px,1fr))}
  .ngrp-sub,.nstrip-sub{display:none}
  .bs-sub{display:none}
  .bs-pct{font-size:18px}
}
`;
    var style = document.createElement('style');
    style.id = 'ads-newest-css';
    style.textContent = css;
    document.head.appendChild(style);
  }
}
