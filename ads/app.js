/* =====================================================================
   NK Ads Dashboard — FRONTEND SHELL (app.js)
   ---------------------------------------------------------------------
   Definuje GLOBÁLNÍ kontrakt window.ADS, který konzumují tables.js,
   charts.js a wizard.js. NEODCHYLUJ signatury (viz SPEC §5 + FE kontrakt).

   Zodpovědnosti SHELLu:
   - window.ADS: state, api(), fmt, semafor, TH/FUNNELS/BQ_RANGE/USERS,
     openPreview(), toast(), el(), bus, onReady()
   - LOGIN flow (klíč + Vojta/Filip -> action=login)
   - N1 SIDEBAR + ROUTING (#/dashboard, #/nastaveni, #/kalendar): ADS.route,
     ADS.ROUTES, ADS.go(), ADS.registerRoute(), event 'routechange' na ADS.bus
   - Horní lišta: picker období (N4/N5), přepínač Prsteny/Náušnice, Obnovit teď
   - N3 NÁHLEDY: ADS.thumbs (small/big/forMode/preload) — jedna politika pro
     všechny moduly (dlaždice = plná kvalita + přednačítání, list = malý)
   - HECK banner (#heck-banner) -> otevře wizard
   - HEALTH řádek (#health-root) z action=overview
   - ANOMÁLIE banner (#anomaly-banner) z overview
   - Na periodchange/tabchange volá ADS.onReady callbacky (sekce se překreslí)

   Ostatní moduly renderují do svých mount kontejnerů (viz index.html):
   #section-kill #section-winners #charts-root #topspenders #newest #alltime
   #earrings-root #wizard-root #view-settings #view-calendar
   ===================================================================== */

(function () {
  'use strict';

  /* ---- Režim: ?mock=1 (nebo fetch fail) -> fixtury z mock.js ---------- */
  var IS_MOCK = /[?&]mock=1\b/.test(location.search);

  /* ---- Interní stav SHELLu ------------------------------------------- */
  var _config   = null;      // odpověď action=config
  var _ready    = false;     // app namountována + config + state
  var _readyCbs = [];        // registr onReady()
  var _overviewCache = null;  // poslední overview (pro shell sekce)

  /* ---- Datové helpery ------------------------------------------------ */
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function ymd(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function todayStr(){ return ymd(new Date()); }
  function addDaysStr(base, delta){
    var d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    return ymd(d);
  }
  function daysBetween(a, b){
    var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000) + 1; // inkluzivně
  }
  function clone(x){ return x == null ? x : JSON.parse(JSON.stringify(x)); }

  /* ---- Formátovače (Intl, česky, CZK) -------------------------------- */
  var _nf0   = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
  var _money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 });
  var _roas  = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  var fmt = {
    money: function (n){ return _money.format(Math.round(Number(n) || 0)); },
    int:   function (n){ return _nf0.format(Math.round(Number(n) || 0)); },
    roas:  function (n){
      var v = Number(n);
      if (!isFinite(v)) v = 0;
      return _roas.format(v) + '×';
    },
    pct:   function (n01){    // vstup 0..1
      var v = Number(n01);
      if (!isFinite(v)) v = 0;
      return _nf0.format(Math.round(v * 100)) + ' %';
    },
    date:  function (s){
      if (!s) return '';
      var str = String(s).slice(0, 10);
      var p = str.split('-');
      if (p.length === 3) return Number(p[2]) + '. ' + Number(p[1]) + '. ' + p[0];
      return str;
    }
  };

  /* =====================================================================
     ZRALOST TRŽBY (SPEC §1) — sdílený kontrakt pro charts.js / tables.js
     ---------------------------------------------------------------------
     Tržba DOZRÁVÁ ~8 týdnů: lead z dneška má naběhnutých ~6 % své konečné
     hodnoty, lead starý 56+ dní ~100 %. ČERSTVÁ DATA PROTO VŽDY VYPADAJÍ HŮŘ,
     než jaká doopravdy jsou — a to není detail: bez tohohle přiznání si Filip
     přečte dozrávání jako propad výkonu a začne řezat funkční kreativy
     (NALEZY #3 a #4). Křivka je ověřená naostro, zdroj pravdy = SPEC §1.

     ⚠️ Zdroj pravdy pro CELÝ frontend je TENHLE blok (shell vlastní kontrakt).
        charts.js si drží jen defenzivní kopii pro případ, že by se načetl bez
        shellu. Když se křivka změní, mění se v SPEC §1 → tady → v charts.js.
     ===================================================================== */
  var RIPE_CURVE = [           // [max. stáří leadu ve dnech, podíl dozrálé tržby]
    { maxAge: 6,  ripe: 0.06 },
    { maxAge: 13, ripe: 0.34 },
    { maxAge: 20, ripe: 0.47 },
    { maxAge: 27, ripe: 0.61 },
    { maxAge: 34, ripe: 0.67 },
    { maxAge: 41, ripe: 0.72 },
    { maxAge: 48, ripe: 0.71 },   // (ne, není to překlep — křivka tu má vlnku)
    { maxAge: 55, ripe: 0.82 }
  ];
  var RIPE_FULL_AGE   = 56;    // 56+ dní ≈ 100 % zralosti
  var RIPE_WARN_BELOW = 0.90;  // pod tím UI VŽDY přizná, že číslo je podhodnocené
  var RIPE_TOO_FRESH  = 0.20;  // pod tím je dopočet ×5 a víc → jen šum, ROAS nehodnotit

  function ripeForAge(age){
    age = Number(age);
    if (!isFinite(age) || age < 0) return 1;
    for (var i = 0; i < RIPE_CURVE.length; i++) if (age <= RIPE_CURVE[i].maxAge) return RIPE_CURVE[i].ripe;
    return 1;
  }
  function ripeForDate(dateStr, today){
    if (!dateStr) return 1;
    return ripeForAge(daysBetween(String(dateStr).slice(0, 10), today || todayStr()) - 1);
  }

  /* Zralost OKNA = průměr denní zralosti přes dny okna.
     ⚠️ Přesně by se vážilo denním spendem: ROAS_okna = R × Σ(zralost_d × spend_d)/Σ spend_d.
     Ověřeno na ostrých datech 16.7.: rovnoměrný průměr 39,0 % vs. spendem vážený 42,4 %
     (30d okno) — spend je týden co týden skoro plochý (~350 k), takže rozdíl < 4 p.b.
     Za ty 4 p.b. NEplatíme dalším API requestem; „~" v popisku říká, že je to odhad.
     Až to server bude posílat (overview.maturity), čti radši jeho. */
  function ripeOfWindow(from, to){
    if (!from || !to) return 1;
    var today = todayStr();
    var n = daysBetween(from, to);
    if (!(n > 0)) return 1;
    var sum = 0, cnt = 0;
    for (var i = 0; i < n; i++){
      var d = addDaysStr(from, i);
      if (d > today) break;                 // budoucí dny neexistují → neředit jimi průměr
      sum += ripeForDate(d, today); cnt++;
    }
    return cnt ? (sum / cnt) : 1;
  }

  /* ---- Prahy z ADS.TH -------------------------------------------------
     KANONICKY: api.php ?action=config posílá `thresholds` s VELKÝMI klíči
     (ROAS_GREEN, HEALTH_YELLOW, …) — server je zdroj pravdy, čteme VELKÁ.
     Malá varianta zůstává jen jako pojistka pro starší/cizí fixtury.
     (tables.js čte stejně: th('ROAS_GREEN', …).)                          */
  function thNum(upper, lower, d){
    var t = ADS.TH || {};
    var v = (t[upper] != null) ? t[upper] : t[lower];
    return num(v, d);
  }

  /* ---- Semafor (ROAS_model) dle ADS.TH ------------------------------- */
  function semafor(roas){
    var g  = thNum('ROAS_GREEN',  'roas_green',  3.0),
        lg = thNum('ROAS_LGREEN', 'roas_lgreen', 2.0),
        y  = thNum('ROAS_YELLOW', 'roas_yellow', 1.3),
        o  = thNum('ROAS_ORANGE', 'roas_orange', 1.0);
    var r = Number(roas) || 0;
    if (r >= g)  return 'green';
    if (r >= lg) return 'lgreen';
    if (r >= y)  return 'yellow';
    if (r >= o)  return 'orange';
    return 'red';
  }
  function num(v, d){ v = Number(v); return isFinite(v) ? v : d; }

  /* ---- el() ---------------------------------------------------------- */
  function el(sel){ return document.querySelector(sel); }
  function makeEl(tag, cls, html){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* =====================================================================
     API — fetch api.php?action=..  (credentials:'include')
     - ?mock=1  -> fixtury z ADS._mock
     - fetch fail na GET -> fallback na mock (read-only; SPEC FE kontrakt)
     - fetch fail na POST (mutace: kill/login/refresh/wizard_save) -> THROW
       (kill nástroj NESMÍ falešně hlásit úspěch — bezpečnostní odchylka)
     - !res.ok nebo body.ok===false -> throw (err.status, err.body)
     ===================================================================== */
  function toQuery(params){
    var parts = [];
    Object.keys(params || {}).forEach(function (k){
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.join('&');
  }

  function mockKey(action, params){
    // POZOR na tab: bez něj dostal náušnicový tab PRSTENOVÉ kreativy.
    // Klíče: creatives_<segment> (rings) / earrings_<segment> (earrings).
    if (action === 'creatives'){
      var t = (params && params.tab === 'earrings') ? 'earrings_' : 'creatives_';
      return t + ((params && params.segment) || 'all');
    }
    return action;
  }
  function mockRespond(action, params){
    var m = window.ADS._mock || {};
    var key = mockKey(action, params);
    var data = (key in m) ? m[key] : (action in m ? m[action] : undefined);
    if (data === undefined){
      // rozumné defaulty pro mutace, aby mock režim nikde nespadl
      switch (action){
        // echo uživatele zpět (jako api.php) — NIKDY nedosazovat 'Filip'
        case 'login':       data = { ok: true, user: (params && params.user) || '' }; break;
        case 'kill':        data = { ok: true, effective_status: 'PAUSED' }; break;
        case 'reactivate':  data = { ok: true, effective_status: 'ACTIVE' }; break;
        case 'ad_status':   data = { ad_id: params && params.ad_id, effective_status: 'PAUSED' }; break;
        case 'refresh':     data = { started: true, last_refresh: nowStamp() }; break;
        case 'wizard_save': data = { ok: true }; break;
        default:            data = { ok: true };
      }
    }
    return Promise.resolve(clone(data));
  }

  function api(action, params, opts){
    params = params || {};
    opts   = opts   || {};
    var method = (opts.method || 'GET').toUpperCase();
    var isMutation = method !== 'GET';

    if (IS_MOCK) return mockRespond(action, params);

    var url = 'api.php?action=' + encodeURIComponent(action);
    var fetchOpts = { method: method, credentials: 'include', headers: {} };

    if (method === 'GET'){
      var qs = toQuery(params);
      if (qs) url += '&' + qs;
    } else {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(opts.body || params || {});
    }

    return fetch(url, fetchOpts).then(function (res){
      if (!res.ok){
        return res.json().catch(function(){ return null; }).then(function (body){
          var e = new Error('HTTP ' + res.status);
          e.status = res.status; e.body = body;
          throw e;
        });
      }
      return res.json().catch(function(){ return null; }).then(function (json){
        if (json && json.ok === false){
          var e = new Error((json && json.error) || 'not ok');
          e.status = res.status; e.body = json;
          throw e;
        }
        return json;
      });
    }).catch(function (err){
      // Síťová chyba (žádný err.status) -> fallback na mock JEN pro čtení
      if (err && err.status === undefined && !isMutation && window.ADS._mock){
        console.warn('[ADS] api("' + action + '") fetch selhal → mock fallback', err && err.message);
        return mockRespond(action, params);
      }
      throw err;
    });
  }

  function nowStamp(){
    var d = new Date();
    return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* =====================================================================
     TOAST
     ===================================================================== */
  function toast(msg, type){
    var root = el('#toast-root');
    if (!root) return;
    var ico = { success:'✓', error:'✕', warn:'⚠', info:'i' }[type] || '';
    var t = makeEl('div', 'toast toast-' + (type || 'info'));
    t.innerHTML = (ico ? '<span class="t-ico">' + ico + '</span>' : '') +
                  '<span class="t-msg">' + esc(msg) + '</span>';
    root.appendChild(t);
    var ttl = type === 'error' ? 6000 : 3600;
    setTimeout(function (){
      t.classList.add('leaving');
      setTimeout(function (){ if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, ttl);
  }

  /* =====================================================================
     MODAL (interní helper; openPreview + moduly ho můžou využít)
     ADS._modal(contentHTML|Node, {title, size, foot, onClose}) -> closeFn
     ===================================================================== */
  var _modalClose = null;
  function _modal(content, o){
    o = o || {};
    _closeModal();
    var root = el('#modal-root');
    if (!root) return function(){};

    var overlay = makeEl('div', 'modal-overlay');
    var panel   = makeEl('div', 'modal' + (o.size === 'sm' ? ' modal-sm' : ''));

    var head = '';
    if (o.title !== false){
      head = '<div class="modal-head"><h3>' + esc(o.title || '') + '</h3>' +
             '<button class="modal-close" type="button" aria-label="Zavřít">✕</button></div>';
    }
    panel.innerHTML = head + '<div class="modal-body"></div>' +
                      (o.foot ? '<div class="modal-foot"></div>' : '');

    var body = panel.querySelector('.modal-body');
    if (typeof content === 'string') body.innerHTML = content;
    else if (content) body.appendChild(content);

    if (o.foot){
      var foot = panel.querySelector('.modal-foot');
      if (typeof o.foot === 'string') foot.innerHTML = o.foot;
      else foot.appendChild(o.foot);
    }

    overlay.appendChild(panel);
    root.appendChild(overlay);
    document.documentElement.classList.add('ads-modal-open');   // zámek scrollu pozadí

    function close(){
      if (!overlay.parentNode) return;
      overlay.parentNode.removeChild(overlay);
      document.documentElement.classList.remove('ads-modal-open');
      document.removeEventListener('keydown', onKey);
      _modalClose = null;
      if (typeof o.onClose === 'function') o.onClose();
    }
    function onKey(ev){ if (ev.key === 'Escape') close(); }

    overlay.addEventListener('mousedown', function (ev){ if (ev.target === overlay) close(); });
    var xBtn = panel.querySelector('.modal-close');
    if (xBtn) xBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    _modalClose = close;
    return close;
  }
  function _closeModal(){ if (_modalClose) _modalClose(); }

  /* Meta effective_status → česky. Zdroj hodnot: Graph API v21.0 (SPEC §0/B).
     Neznámý stav vrátíme, jak přišel — radši syrový enum než vymyšlený překlad. */
  var STATUS_CZ = {
    ACTIVE:           'Běží',
    PAUSED:           'Vypnutá',
    ADSET_PAUSED:     'Vypnutá (celá sada)',
    CAMPAIGN_PAUSED:  'Vypnutá (celá kampaň)',
    ARCHIVED:         'Archivovaná',
    DELETED:          'Smazaná',
    PENDING_REVIEW:   'Čeká na schválení',
    IN_PROCESS:       'Zpracovává se',
    DISAPPROVED:      'Zamítnutá Metou',
    WITH_ISSUES:      'Běží s problémem',
    PREAPPROVED:      'Předschválená',
    PENDING_BILLING_INFO: 'Chybí fakturační údaje'
  };
  function statusCz(s){
    var k = String(s || '').toUpperCase();
    return STATUS_CZ[k] || s;
  }

  /* =====================================================================
     openPreview(ad) — náhled kreativy/ad v modalu
     ad: { thumbnail|thumbnail_url|image_url, preview_link, instagram_permalink|ig,
           object_type, adsmanager_link, ad_name, copy_code, creative, funnel,
           status, effective_status, created_time, spend }
     ===================================================================== */
  function openPreview(ad){
    ad = ad || {};
    var img = ad.image_url || ad.thumbnail || ad.thumbnail_url || '';
    var ig  = ad.instagram_permalink || ad.ig || '';
    var prev = ad.preview_link || '';
    var isVideo = /VIDEO/i.test(ad.object_type || '') || (!!ig && !img);
    var code = ad.creative || ad.copy_code || ad.ad_name || 'Náhled';

    var media = img
      ? '<img class="preview-media" src="' + esc(img) + '" alt="' + esc(code) + '" ' +
        'onerror="this.style.display=&quot;none&quot;">'
      : '<div class="preview-media" style="min-height:220px;display:flex;align-items:center;' +
        'justify-content:center;color:var(--text-3);font-weight:600">' +
        (isVideo ? '▶ Video — otevři v Meta / IG' : 'Bez náhledu') + '</div>';

    var rows = '';
    if (ad.ad_name)  rows += '<div class="pm-row">' + esc(ad.ad_name) + '</div>';
    if (ad.funnel)   rows += '<div class="pm-row">Funnel: <b>' + esc(ad.funnel) + '</b></div>';
    var st = ad.effective_status || ad.status;
    if (st){
      // Meta posílá stav jako ENUM (ACTIVE / ADSET_PAUSED / DISAPPROVED…). V českém UI
      // to je cizí slovo — a hlavně u „ADSET_PAUSED" není z názvu poznat, že samotná
      // reklama běží a vypnutá je až sada. Původní enum zůstává v title (kdyby ho
      // Vojta hledal v Ads Manageru).
      rows += '<div class="pm-row">Stav: <b title="' + esc(st) + '">' + esc(statusCz(st)) + '</b></div>';
    }
    if (ad.created_time) rows += '<div class="pm-row">Vytvořeno: ' + esc(fmt.date(ad.created_time)) + '</div>';
    if (ad.spend != null) rows += '<div class="pm-row">Spend: ' + esc(fmt.money(ad.spend)) + '</div>';

    var actions = '';
    if (prev) actions += '<a class="btn btn-sm" href="' + esc(prev) + '" target="_blank" rel="noopener">Přehrát / FB náhled</a>';
    if (ig)   actions += '<a class="btn btn-sm" href="' + esc(ig) + '" target="_blank" rel="noopener">Otevřít na IG</a>';
    var aml = ad.adsmanager_link || (ad.ad_id ? 'https://www.facebook.com/adsmanager/manage/ads?act=842525630619928&selected_ad_ids=' + encodeURIComponent(ad.ad_id) : '');
    if (aml)  actions += '<a class="btn btn-sm btn-primary" href="' + esc(aml) + '" target="_blank" rel="noopener">Otevřít v Meta</a>';

    var body =
      media +
      '<div class="preview-meta"><div class="pm-code">' + esc(code) + '</div>' + rows + '</div>' +
      (actions ? '<div class="preview-actions">' + actions + '</div>' : '');

    _modal(body, { title: 'Náhled kreativy', size: 'sm' });
  }

  /* =====================================================================
     BUS (EventTarget) — sdílené eventy mezi moduly
     'periodchange','tabchange','refreshed','killed','wizardclose'
     + navíc SHELL vysílá 'wizardopen' (HECK -> wizard.js poslouchá)
     ===================================================================== */
  var bus = new EventTarget();
  function emit(name, detail){ bus.dispatchEvent(new CustomEvent(name, { detail: detail })); }

  /* =====================================================================
     F7/D7 — FLAGY (trvalé poznámky ke kreativám) — SDÍLENÝ STORE
     ---------------------------------------------------------------------
     Filip 23. 7.: „to flagování bych chtěl zahrnout ke všem kreativám (…) byl by to
     i jako volitelný sloupec, který by se propisoval NAPŘÍČ VŠEMA ZOBRAZENÍMA."

     Právě to „napříč zobrazeními" je důvod, proč store bydlí tady a ne v tables.js:
     flagy čte tabulka (sloupec), detail kreativy (seznam + přidání) i denní check.
     Kdyby si každý modul držel vlastní kopii, po přidání flagu v detailu by ho tabulka
     neviděla, dokud by se nepřenačetla — a Filip by hlásil, že „flag zmizel".

     Cache je JEDNA mapa creative → [flagy]; každá změna ji přenačte a vyšle 'flagschange',
     na který si moduly překreslí, co potřebují.
     ===================================================================== */
  var _flags = { map: {}, loaded: false, inflight: null };

  function flagsLoad(force){
    if (_flags.inflight) return _flags.inflight;
    if (_flags.loaded && !force) return Promise.resolve(_flags.map);
    _flags.inflight = api('flags_list')
      .then(function (r){
        _flags.map = (r && r.by_creative) || {};
        _flags.loaded = true;
        return _flags.map;
      })
      .catch(function (e){
        // Flagy jsou doplněk — když se nenačtou, dashboard musí jet dál (sloupec zůstane prázdný).
        console.warn('[flags] načtení selhalo', e);
        _flags.loaded = true;          // ať se to nezkouší donekonečna při každém překreslení
        return _flags.map;
      })
      .finally(function (){ _flags.inflight = null; });
    return _flags.inflight;
  }
  function flagsGet(creative){
    if (!creative) return [];
    return _flags.map[String(creative)] || [];
  }
  function flagsRefresh(){
    return flagsLoad(true).then(function (m){ emit('flagschange', { map: m }); return m; });
  }
  var ADS_FLAGS = {
    load:    flagsLoad,
    get:     flagsGet,
    all:     function (){ return _flags.map; },
    loaded:  function (){ return _flags.loaded; },
    refresh: flagsRefresh,
    add: function (creative, note, opts){
      var b = { creative: creative, note: note };
      if (opts && opts.ad_id) b.ad_id = opts.ad_id;
      if (opts && opts.source) b.source = opts.source;
      return api('flag_add', b, { method: 'POST' }).then(function (r){
        return flagsRefresh().then(function (){ return r; });
      });
    },
    remove: function (id){
      return api('flag_delete', { id: id }, { method: 'POST' }).then(function (r){
        return flagsRefresh().then(function (){ return r; });
      });
    }
  };

  /* =====================================================================
     onReady registr + fireReady
     ===================================================================== */
  function onReady(cb){
    if (typeof cb !== 'function') return;
    _readyCbs.push(cb);
    if (_ready){ try { cb(ADS.state); } catch (e){ console.error(e); } }
  }
  function fireReady(){
    renderShell();                     // health/anomaly/heck (SHELL vlastní)
    _readyCbs.forEach(function (cb){
      try { cb(ADS.state); } catch (e){ console.error('[ADS] onReady cb error', e); }
    });
  }

  /* =====================================================================
     WINDOW.ADS — LOCKED KONTRAKT
     ===================================================================== */
  var ADS = window.ADS = {
    // aktuální období + tab + uživatel + preset
    state: {
      from: null, to: null,
      tab: 'rings',              // 'rings' | 'earrings'
      user: null,
      preset: 30,                // číslo dní | 'custom'
      lastRefresh: null
    },
    TH: {},                      // prahy/semafor z action=config (VELKÁ písmena, dle serveru)
    ESTIMATING_DAYS: 3,          // z action=config (top-level) — zrcadlí se i do TH.ESTIMATING_DAYS
    NEW_ADS_DAYS: 10,            // z action=config (top-level) — zrcadlí se i do TH.NEW_ADS_DAYS
    FUNNELS: [],                 // z action=config
    EVENTS: [],                  // z action=config (bonus)
    BQ_RANGE: { min: null, max: null },
    USERS: ['Vojta', 'Filip'],

    /* P1 (iterace 6) — V LIŠTĚ ZŮSTÁVÁ JEN 30 · 90 · 180. Filip: „těch 14 vyhoď úplně
       z těch variant, jak jsou tam předefinovaný… takže 14 pryč a nechat 30, 90, 180."
       PROČ (navazuje na N4, kde odešla 7): krátké okno je zralé ~6–10 % (SPEC §1, křivka
       dozrávání), takže jeho ROAS je systematicky podhodnocený. Chip vedle „30" svádí
       k porovnání dvou čísel, která porovnat NELZE → tlačí k zabíjení funkčních kreativ.
       60 a 120 nezmizely — přesunuly se do rychlých voleb v pickeru (P2, quickRanges).
       Lišta = 3 rozhodovací okna, zbytek na dvě kliknutí. Default zůstává 30.

       ⚠️ ALLOWLIST, ne minimum. Server v ?action=config pořád posílá presets
          [7,14,30,60,90,120,180] (api.php:3592) a přepisuje tenhle seznam. Filtr na
          „>= PRESET_MIN_DAYS" by 14/60/120 pustil zpátky do lišty → 14 by se vrátila
          a zadání by tiše padlo. Proto se ze serveru bere jen PRŮNIK s PRESET_ALLOWED.
          Až se api.php srovná, průnik je no-op (viz notes_for_integrator). */
    PRESETS: [30, 60, 90, 180],
    PRESET_ALLOWED: [30, 60, 90, 180],   // co smí do lišty (zdroj pravdy, přebíjí i server)
    PRESET_MIN_DAYS: 14,             // ponecháno v kontraktu: pojistka proti krátkým oknům

    /* N1 ROUTING — sidebar položky. Registr = zdroj pravdy pro menu i pro mounty.
       Filip: „budeme to furt rozšiřovat" → přidat sekci = přidat řádek sem
       (nebo zavolat ADS.registerRoute z modulu), ne sahat do HTML.
       `mount` = ID kontejneru v index.html; když v DOM není, app.js ho vyrobí. */
    ROUTES: [
      { key: 'dashboard', label: 'Hlavní dashboard', icon: '📊', mount: 'view-dashboard' },
      { key: 'nastaveni', label: 'Nastavení',        icon: '⚙️', mount: 'view-settings'  },
      { key: 'kalendar',  label: 'Kalendář',         icon: '📅', mount: 'view-calendar'  }
    ],
    route: 'dashboard',          // aktuální routa (čtení; zápis přes ADS.go)

    api: api,
    fmt: fmt,
    semafor: semafor,
    openPreview: openPreview,
    toast: toast,
    el: el,
    bus: bus,
    onReady: onReady,
    flags: ADS_FLAGS,            // F7/D7 — sdílený store flagů (tabulka + detail + denní check)

    // N1 ROUTING — moduly: ADS.bus.addEventListener('routechange', e => e.detail.route)
    go:            function (k){ return go(k); },
    registerRoute: function (d){ return registerRoute(d); },

    // Meta effective_status → česky ('ADSET_PAUSED' → 'Vypnutá (celá sada)').
    // Ať se enum nepřekládá pětkrát jinak v každém modulu.
    statusCz: statusCz,

    // N3 NÁHLEDY — jedna politika pro všechny moduly (viz blok N3 výš).
    //   ADS.thumbs.forMode(ad, 'tiles')  -> 900px  (+ preload)
    //   ADS.thumbs.forMode(ad, 'list')   -> 240px
    //   ADS.thumbs.big(ad)               -> hover / modal
    thumbs: {
      BIG_PX:   THUMB_BIG_PX,
      SMALL_PX: THUMB_SMALL_PX,
      big:      thumbBig,
      small:    thumbSmall,
      forMode:  thumbForMode,
      preload:  preloadThumbs,        // (pole adů|URL, {limit}) -> kolik se jich poslalo
      preloadVisible: preloadVisible, // (mount, selektor='[data-thumb-big]')
      bigFromSmallUrl: bigFromSmallUrl
    },

    // ZRALOST TRŽBY (SPEC §1) — přírůstek ke kontraktu, nic starého nemění.
    // charts.js: zralost týdne v F4 grafu · tables.js: může kotvit ROAS prahy.
    ripeness: {
      CURVE:      RIPE_CURVE,
      FULL_AGE:   RIPE_FULL_AGE,
      WARN_BELOW: RIPE_WARN_BELOW,
      TOO_FRESH:  RIPE_TOO_FRESH,
      forAge:     ripeForAge,     // stáří ve dnech        -> 0..1
      forDate:    ripeForDate,    // 'YYYY-MM-DD'          -> 0..1
      ofWindow:   ripeOfWindow    // (from, to)            -> 0..1
    },

    // interní utility (moduly je smí využít; podtržítko = ne v LOCKED kontraktu)
    _mock: null,                 // naplní mock.js
    _modal: _modal,
    _closeModal: _closeModal,
    _esc: esc,
    _makeEl: makeEl,
    _emit: emit,
    IS_MOCK: IS_MOCK
  };

  /* =====================================================================
     N3 — NÁHLEDY PODLE REŽIMU (ADS.thumbs)
     ---------------------------------------------------------------------
     Filip: „v Card View potřebujeme plnou kvalitu přednačítat; v list view
     malé (nízká kvalita) stačí, ale o 30 % větší."
     → Politika je JEDNA a bydlí tady (shell), ne pětkrát v každém modulu:

       dlaždice / karta  -> thumbnail_big (cache/{ad}_big.jpg, 900 px) + PRELOAD
       list / tabulka    -> thumbnail     (cache/{ad}.jpg, 240 px)   — lazy
       hover / modal     -> thumbnail_big (velký pop-up)

     Fallback řetěz je stejný jako měly moduly u sebe (tables.js/newest.js/
     wizard.js), takže adopce je 1:1 náhrada jejich lokální funkce:
       big:   thumbnail_big -> image_url -> thumbnail -> thumbnail_url
       small: thumbnail -> thumbnail_url -> image_url  (a když nic, tak big)

     PROČ preload a ne `loading="lazy"`: v dlaždicích jde o 900px JPEGy, které
     se dotahují po vykreslení mřížky → bez přednačtení Filip kouká na rozmazaný
     240px obrázek, který doskočí až po chvíli. `new Image()` je stáhne do cache
     prohlížeče dřív, než je někdo potřebuje, a `<img>` je pak vezme z cache.
     ===================================================================== */
  var THUMB_BIG_PX   = 900;   // = config THUMB_BIG_PX (refresh.php: cache/{ad}_big.jpg)
  var THUMB_SMALL_PX = 240;   // = config THUMB_SMALL_PX (cache/{ad}.jpg)

  function thumbBig(ad){
    if (!ad) return '';
    return ad.thumbnail_big || ad.thumbnail_big_url || ad.image_url ||
           ad.thumbnail || ad.thumbnail_url || '';
  }
  function thumbSmall(ad){
    if (!ad) return '';
    return ad.thumbnail || ad.thumbnail_url || ad.image_url ||
           ad.thumbnail_big || '';
  }
  /* mode: 'tiles'|'card'|'grid' -> velký · 'list'|'table'|'row' -> malý */
  function thumbForMode(ad, mode){
    return /^(tiles?|card|grid)$/i.test(String(mode || '')) ? thumbBig(ad) : thumbSmall(ad);
  }

  /* Přednačtení: bere pole adů/URL, deduplikuje a stáhne do cache prohlížeče.
     Drží se stropu, ať 200 dlaždic nezaplaví spojení — přednačítáme jen to,
     co je reálně na obrazovce (viz preloadVisible). */
  var _preloaded = Object.create(null);
  function preloadThumbs(list, opts){
    opts = opts || {};
    var limit = num(opts.limit, 60);
    var urls = (list || []).map(function (x){
      return (typeof x === 'string') ? x : thumbBig(x && x.sample_ad ? x.sample_ad : x);
    }).filter(function (u){
      if (!u || _preloaded[u]) return false;
      _preloaded[u] = 1; return true;
    }).slice(0, limit);
    urls.forEach(function (u){ var im = new Image(); im.decoding = 'async'; im.src = u; });
    return urls.length;
  }

  /* Přednačti VIDITELNÉ dlaždice v kontejneru + doplň, co doroluje.
     Modul si zavolá ADS.thumbs.preloadVisible(mount) po renderu mřížky;
     IntersectionObserver zařídí zbytek. Idempotentní (element si nese příznak). */
  function preloadVisible(root, sel){
    root = (typeof root === 'string') ? el(root) : root;
    if (!root) return 0;
    var nodes = [].slice.call(root.querySelectorAll(sel || '[data-thumb-big]'));
    if (!nodes.length) return 0;
    if (!window.IntersectionObserver){
      return preloadThumbs(nodes.map(function (n){ return n.getAttribute('data-thumb-big'); }));
    }
    var io = new IntersectionObserver(function (entries){
      entries.forEach(function (e){
        if (!e.isIntersecting) return;
        preloadThumbs([e.target.getAttribute('data-thumb-big')]);
        io.unobserve(e.target);
      });
    }, { rootMargin: '300px' });      // 300px = přednačti těsně před doscrollováním
    nodes.forEach(function (n){
      if (n.__adsPre) return;
      n.__adsPre = 1; io.observe(n);
    });
    return nodes.length;
  }

  /* ---------------------------------------------------------------------
     AUTO-UPGRADE DLAŽDIC (přechodová pojistka, ne trvalý stav)
     ---------------------------------------------------------------------
     Dlaždice dnes renderuje newest.js a bere do nich MALÝ náhled (240 px).
     Na Filipově retina displeji je 240px obrázek v ~178px dlaždici viditelně
     rozmazaný — přesně to, co má N3 řešit. newest.js je cizí soubor, takže
     ho neopravuju; místo toho shell po renderu dlaždice povýší: dopočítá
     velkou variantu (cache/{ad}.jpg -> cache/{ad}_big.jpg), přednačte ji
     a teprve po ÚSPĚŠNÉM stažení prohodí src. Když velká varianta neexistuje
     (404), zůstane malá → nikdy prázdná dlaždice.

     ⚠️ Až modul dlaždic začne volat ADS.thumbs.forMode(ad,'tiles'), tahle
        funkce se stane no-op (src už na `_big.jpg` končí) — viz notes.        */
  function bigFromSmallUrl(u){
    if (!u || /_big\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) return '';   // už je velký
    if (!/\/cache\//.test(u)) return '';                               // cizí/CDN URL neřešíme
    return u.replace(/\.(jpg|jpeg|png|webp)(\?|$)/i, '_big.$1$2');
  }
  function upgradeTileImg(img){
    if (!img || img.__adsBig) return;
    img.__adsBig = 1;
    var big = img.getAttribute('data-thumb-big') || bigFromSmallUrl(img.getAttribute('src') || '');
    if (!big) return;
    var probe = new Image();
    probe.onload = function (){        // až když je velká varianta jistě v cache
      if (img.isConnected) img.src = big;
    };
    probe.decoding = 'async';
    probe.src = big;
  }
  var _tileObs = null;
  function autoUpgradeTiles(){
    // Dlaždice = .ngrid .nt-img (newest.js). Selektor je držený schválně úzce:
    // list/tabulka (.prev-img) se NEpovyšuje — tam Filip chtěl malé.
    var TILE_SEL = '.ngrid .nt-img, .ads-tiles img[data-thumb-big], [data-view-mode="tiles"] img';
    function scan(){
      var imgs = [].slice.call(document.querySelectorAll(TILE_SEL));
      if (!imgs.length) return;
      if (!window.IntersectionObserver){ imgs.forEach(upgradeTileImg); return; }
      if (!_tileObs){
        _tileObs = new IntersectionObserver(function (entries){
          entries.forEach(function (e){
            if (!e.isIntersecting) return;
            upgradeTileImg(e.target); _tileObs.unobserve(e.target);
          });
        }, { rootMargin: '300px' });
      }
      imgs.forEach(function (im){ if (!im.__adsObs){ im.__adsObs = 1; _tileObs.observe(im); } });
    }
    scan();
    if (!window.MutationObserver) return;
    var queued = false;
    new MutationObserver(function (){
      if (queued) return;                       // debounce: moduly při renderu mutují DOM hodně
      queued = true;
      requestAnimationFrame(function (){ queued = false; scan(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* =====================================================================
     N1 — ROUTING (hash) + SIDEBAR
     ---------------------------------------------------------------------
     Bez knihovny: hash '#/klic' -> ADS.route -> [hidden] na .route-view.
     Moduly se připojí přes ADS.bus 'routechange' (detail {route, prev}) —
     settings.js/calendar.js si tak vykreslí obsah teprve, když je routa
     vidět (a nemusí řešit, že mount je schovaný).
     ===================================================================== */
  var LS_NAV = 'ads.nav.collapsed.v1';

  function routeByKey(k){
    for (var i = 0; i < ADS.ROUTES.length; i++) if (ADS.ROUTES[i].key === k) return ADS.ROUTES[i];
    return null;
  }
  function routeFromHash(){
    var h = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
    return routeByKey(h) ? h : 'dashboard';
  }
  function mountOf(r){
    var id = r.mount || ('view-' + r.key);
    var m = document.getElementById(id);
    if (!m){                       // routa bez HTML mountu (registrovaná za běhu)
      m = makeEl('section', 'route-view');
      m.id = id; m.hidden = true;
      var main = el('.content');
      if (main) main.appendChild(m);
    }
    return m;
  }

  function buildSidenav(){
    var nav = el('#sn-nav');
    if (!nav) return;
    nav.innerHTML = '';
    ADS.ROUTES.forEach(function (r){
      var a = makeEl('a', 'sn-item');
      a.href = '#/' + r.key;
      a.setAttribute('data-route', r.key);
      a.title = r.label;                       // ve sbaleném stavu je vidět jen ikona
      a.innerHTML = '<span class="sn-ico" aria-hidden="true">' + esc(r.icon || '•') + '</span>' +
                    '<span class="sn-label">' + esc(r.label) + '</span>';
      nav.appendChild(a);
    });
    markRoute();

    var t = el('#sn-toggle');
    if (t && !t.__wired){
      t.__wired = 1;
      t.addEventListener('click', function (){ setNavCollapsed(!isNavCollapsed()); });
    }
    applyNavCollapsed(isNavCollapsed());
  }

  function isNavCollapsed(){
    try { return localStorage.getItem(LS_NAV) === '1'; } catch (_) { return false; }
  }
  function setNavCollapsed(v){
    try { localStorage.setItem(LS_NAV, v ? '1' : '0'); } catch (_) {}
    applyNavCollapsed(v);
    // Sidebar mění šířku obsahu → Tabulator/ECharts si musí přepočítat plátno.
    setTimeout(function (){ try { window.dispatchEvent(new Event('resize')); } catch (_) {} }, 220);
  }
  function applyNavCollapsed(v){
    var app = el('#app');
    if (app) app.classList.toggle('nav-collapsed', !!v);
    var t = el('#sn-toggle');
    if (t){
      t.setAttribute('aria-expanded', v ? 'false' : 'true');
      t.title = v ? 'Rozbalit menu' : 'Sbalit menu';
    }
  }

  function markRoute(){
    var nav = el('#sn-nav');
    if (nav) nav.querySelectorAll('.sn-item').forEach(function (a){
      var on = a.getAttribute('data-route') === ADS.route;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var r = routeByKey(ADS.route);
    var t = el('#route-title');
    if (t && r) t.textContent = r.label;
    // Ovládání dashboardu (období + Prsteny/Náušnice) patří JEN dashboardu.
    var dc = el('#dash-controls');
    if (dc) dc.hidden = (ADS.route !== 'dashboard');
    var ps = el('#period-summary');
    if (ps) ps.hidden = (ADS.route !== 'dashboard');
  }

  /* Placeholder, když modul routy ještě není nasazený — ať Filip nekouká
     na prázdnou bílou plochu a hlavně ať pozná, že to není rozbité. */
  function routePlaceholder(r, mount){
    if (mount.getAttribute('data-owned') === '1') return;   // modul si obsah vykreslil sám
    if (mount.children.length) return;
    mount.innerHTML =
      '<div class="route-empty">' +
        '<div class="re-ico" aria-hidden="true">' + esc(r.icon || '•') + '</div>' +
        '<div class="re-title">' + esc(r.label) + '</div>' +
        '<div class="re-text">Tahle sekce se právě dodělává. Data se nikam neztratila — ' +
          'najdeš je na hlavním dashboardu.</div>' +
        '<a class="btn btn-sm" href="#/dashboard">Zpět na dashboard</a>' +
      '</div>';
  }

  function applyRoute(next, silent){
    var prev = ADS.route;
    ADS.route = routeByKey(next) ? next : 'dashboard';
    ADS.ROUTES.forEach(function (r){
      var m = mountOf(r);
      var on = (r.key === ADS.route);
      m.hidden = !on;
      if (on) routePlaceholder(r, m);
    });
    markRoute();
    if (!silent && prev !== ADS.route){
      emit('routechange', { route: ADS.route, prev: prev });
      // Skryté sekce mají 0px plátna → po přepnutí na dashboard je potřeba přeměřit.
      setTimeout(function (){ try { window.dispatchEvent(new Event('resize')); } catch (_) {} }, 60);
    }
  }

  function go(key){
    if (!routeByKey(key)) key = 'dashboard';
    if (location.hash !== '#/' + key) location.hash = '#/' + key;   // hashchange -> applyRoute
    else applyRoute(key);
  }

  function registerRoute(def){
    if (!def || !def.key || routeByKey(def.key)) return false;
    ADS.ROUTES.push({ key: def.key, label: def.label || def.key, icon: def.icon || '•',
                      mount: def.mount || ('view-' + def.key) });
    buildSidenav();
    applyRoute(ADS.route, true);
    return true;
  }

  function wireRouting(){
    window.addEventListener('hashchange', function (){ applyRoute(routeFromHash()); });
    applyRoute(routeFromHash(), true);
  }

  /* =====================================================================
     CONFIG -> aplikace prahů/funnelů/rozsahu
     ===================================================================== */
  function applyConfig(cfg){
    _config = cfg || {};

    // Prahy: server posílá `thresholds` (VELKÁ písmena). Kopírujeme (ne referenci),
    // ať doplnění odvozených klíčů níž nemutuje původní config objekt.
    var src = _config.thresholds || _config.th || {};
    var th = {};
    Object.keys(src).forEach(function (k){ th[k] = src[k]; });

    // POZOR: estimating_days / new_ads_days chodí ze serveru TOP-LEVEL (mimo thresholds).
    // charts.js je čte jako TH(['ESTIMATING_DAYS','estimating_days']) → propašuj je do TH,
    // jinak spadne na hardcoded default a šrafovaný pás nesedí s configem.
    if (th.ESTIMATING_DAYS == null && _config.estimating_days != null) th.ESTIMATING_DAYS = _config.estimating_days;
    if (th.NEW_ADS_DAYS    == null && _config.new_ads_days    != null) th.NEW_ADS_DAYS    = _config.new_ads_days;

    ADS.TH = th;
    ADS.ESTIMATING_DAYS = num(th.ESTIMATING_DAYS, 3);
    ADS.NEW_ADS_DAYS    = num(th.NEW_ADS_DAYS, 10);

    ADS.FUNNELS  = _config.funnels || [];
    ADS.EVENTS   = _config.events || [];
    ADS.BQ_RANGE = _config.bq_range || _config.bqRange || { min: null, max: null };
    ADS.USERS    = _config.users || ADS.USERS;

    // P1: do lišty smí JEN to, co je v PRESET_ALLOWED (30/90/180) — ani když server
    // pošle víc (api.php dnes posílá [7,14,30,60,90,120,180]). Bereme PRŮNIK, ne to,
    // co přijde: server tak může sadu zúžit, ale nikdy ne propašovat 14 zpátky.
    // Filtrujeme až tady, ať je pravidlo na jednom místě a nečeká se na deploy backendu.
    if (Array.isArray(_config.presets) && _config.presets.length){
      var ps = _config.presets.map(function (d){ return num(d, 0); }).filter(function (d){
        return d >= ADS.PRESET_MIN_DAYS && ADS.PRESET_ALLOWED.indexOf(d) !== -1;
      });
      if (ps.length) ADS.PRESETS = ps;
    }
  }

  /* =====================================================================
     LOGIN GATE
     ===================================================================== */
  function buildLoginUsers(){
    var box = el('#login-users');
    if (!box) return;
    box.innerHTML = '';
    var sel = ADS.state.user || (ADS.USERS && ADS.USERS[ADS.USERS.length - 1]) || 'Filip';
    (ADS.USERS || ['Vojta','Filip']).forEach(function (u){
      var b = makeEl('button', 'user-pill' + (u === sel ? ' is-active' : ''), esc(u));
      b.type = 'button';
      b.setAttribute('data-user', u);
      b.addEventListener('click', function (){
        ADS.state.user = u;
        box.querySelectorAll('.user-pill').forEach(function (x){ x.classList.remove('is-active'); });
        b.classList.add('is-active');
      });
      box.appendChild(b);
    });
    if (!ADS.state.user) ADS.state.user = sel;
  }

  function showLogin(msg){
    el('#app').hidden = true;
    var gate = el('#login-gate');
    gate.hidden = false;
    buildLoginUsers();
    var errEl = el('#login-error');
    if (errEl) errEl.textContent = msg || '';
    var keyEl = el('#login-key');
    if (keyEl){ keyEl.value = ''; setTimeout(function(){ keyEl.focus(); }, 40); }
  }

  function wireLogin(){
    var form = el('#login-form');
    if (!form) return;
    form.addEventListener('submit', function (ev){
      ev.preventDefault();
      var key = (el('#login-key').value || '').trim();
      var user = ADS.state.user || 'Filip';
      var errEl = el('#login-error');
      if (!key){ if (errEl) errEl.textContent = 'Zadej přístupový klíč.'; return; }
      var submit = el('#login-submit');
      submit.disabled = true; submit.textContent = 'Přihlašuji…';
      if (errEl) errEl.textContent = '';

      api('login', {}, { method: 'POST', body: { key: key, user: user } })
        .then(function (r){
          ADS.state.user = (r && r.user) || user;
          return enterApp();
        })
        .catch(function (e){
          submit.disabled = false; submit.textContent = 'Vstoupit';
          if (errEl) errEl.textContent = (e && e.status === 401)
            ? 'Špatný klíč.' : 'Přihlášení selhalo. Zkus to znovu.';
        });
    });
  }

  function logout(){
    // Serverová session je HttpOnly cookie; klientsky jen resetujeme UI.
    api('logout', {}, { method: 'POST' }).catch(function(){ /* endpoint volitelný */ });
    _ready = false;
    ADS.state.from = ADS.state.to = null;
    showLogin('');
  }

  /* =====================================================================
     VSTUP DO APLIKACE (po loginu / při platné session)
     ===================================================================== */
  function enterApp(){
    var pre = _config ? Promise.resolve(_config) : api('config');
    return pre.then(function (cfg){
      applyConfig(cfg);
      // Uživatel = kdo je přihlášený dle SERVERU (config vrací `user` ze session cookie).
      // NIKDY netvrdit 'Filip' natvrdo — po reloadu by se Vojta viděl jako Filip.
      if (!ADS.state.user) ADS.state.user = (cfg && cfg.user) || '';

      el('#login-gate').hidden = true;
      el('#app').hidden = false;

      buildSidenav();       // N1: menu z ADS.ROUTES
      wireRouting();        // N1: hash -> ADS.route (silent, ať se neemituje do prázdna)
      buildPeriodChips();
      buildDatePop();       // N5: popover s rychlými volbami + kalendářem
      wireTopbar();
      autoUpgradeTiles();   // N3: dlaždice na plnou kvalitu (přechodová pojistka)
      if (ADS.state.preset === 'custom') { /* zachovat */ }
      else setPeriod(ADS.state.preset || 30, true);   // default 30 (bez emitu, fireReady níž)
      updateUserLabel();

      /* F7/D7: flagy načíst hned po vstupu do appky (jeden lehký dotaz) a emitnout
       * 'flagschange', ať si sloupec v tabulce překreslí buňky, i když už byla vykreslená.
       * Schválně BEZ await — dashboard na flagy čekat nemá, jsou to doplňkové poznámky. */
      flagsLoad().then(function (m){ emit('flagschange', { map: m }); });

      _ready = true;
      fireReady();
      return true;
    });
  }

  /* =====================================================================
     TOPBAR — období, tab, refresh, jméno
     ===================================================================== */
  function buildPeriodChips(){
    var box = el('#period-chips');
    if (!box) return;
    box.innerHTML = '';
    ADS.PRESETS.forEach(function (d){
      var c = makeEl('button', 'chip', String(d));
      c.type = 'button';
      c.setAttribute('data-days', d);
      c.title = 'Posledních ' + d + ' dní';
      c.addEventListener('click', function (){ setPeriod(d); });
      box.appendChild(c);
    });
  }

  /* =====================================================================
     N5 — DATE PICKER (Filip: „date picker není user-friendly" → předělat)
     ---------------------------------------------------------------------
     Co bylo špatně: chip „Vlastní" odkryl 186px readonly input, ve kterém
     vyskočil DEFAULTNÍ flatpickr — anglicky („July", „Su Mo Tu"), 307 px
     široký, jeden měsíc, bez potvrzení: první klik = od, druhý klik = do,
     zavřít = rovnou aplikovat. Omyl ve druhém kliku znamenal načtení celého
     dashboardu se špatným obdobím a znovu od začátku.

     Co je teď:
       • POPOVER pod chipem: vlevo rychlé volby, vpravo kalendář 2 měsíce
       • ČESKY (locale níž — vendor flatpickr žádnou `cs` nemá, ověřeno grepem)
       • čitelný readout „Od → Do" + počet dní, aktualizuje se při klikání
       • POTVRZENÍ: manuální rozsah se aplikuje až tlačítkem „Použít"
         (rychlé volby jsou jednoznačné → aplikují se hned, jedním klikem)
       • Esc / klik mimo = zavřít BEZ změny období
     ===================================================================== */
  var FP_CS = {                       // flatpickr `cs` locale (vendor ho nemá zabundlovaný)
    weekdays: {
      shorthand: ['Ne','Po','Út','St','Čt','Pá','So'],
      longhand:  ['Neděle','Pondělí','Úterý','Středa','Čtvrtek','Pátek','Sobota']
    },
    months: {
      shorthand: ['Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
      longhand:  ['Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen',
                  'Září','Říjen','Listopad','Prosinec']
    },
    firstDayOfWeek: 1,               // pondělí — ne neděle
    rangeSeparator: ' – ',
    weekAbbreviation: 'Týd.',
    scrollTitle: 'Rolováním změníš',
    toggleTitle: 'Přepnout',
    yearAriaLabel: 'Rok',
    monthAriaLabel: 'Měsíc',
    time_24hr: true,
    ordinal: function () { return '.'; }
  };

  var _fp = null;          // flatpickr instance (inline v popoveru)
  var _pending = null;     // {from,to} rozpracovaný výběr — aplikuje se až „Použít"
  /* Pod touhle šířkou okna se popover přepne na JEDEN měsíc.
     ⚠️ MUSÍ sedět s @media (max-width:860px) ve styles.css (.period-pop → sloupec).
     Kdyby se rozešly, buď kalendář přeteče z okna, nebo zbude prázdné místo. */
  var PP_ONE_MONTH_BELOW = 860;

  function monthStart(d){ return ymd(new Date(d.getFullYear(), d.getMonth(), 1)); }
  function monthEnd(d){   return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
  function dayMonth(s){                       // '2026-06-17' -> '17. 6.'
    if (!s) return '—';
    var p = String(s).slice(0,10).split('-');
    return p.length === 3 ? (Number(p[2]) + '. ' + Number(p[1]) + '.') : s;
  }

  /* Rychlé volby. `all` bere MIN z BQ (SPEC §0: historie od 2025-12-31) —
     nikdy ne pevné datum, ať se to samo posouvá, jak přibývá historie.

     P2 (iterace 6): 60 a 120 dní přibyly SEM, protože zmizely z lišty (P1). Jsou první,
     ať je nahrazení chipu na jedno otevření pickeru — pořadí drží Filipovo zadání:
     60 · 120 · tento měsíc · minulý měsíc · posledních 90 · tento rok · celá historie.
     Rychlá volba jde přes setCustom() (preset='custom') stejně jako zbytek seznamu —
     tzn. chip „Vlastní" pak ukazuje konkrétní rozsah. Záměrně: základ pickeru se nemění.
     Odečítá se N-1 dní (dnešek se počítá) — stejná matematika jako setPeriod(). */
  function quickRanges(){
    var now = new Date(), today = todayStr();
    var prevM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var bqMin = (ADS.BQ_RANGE && ADS.BQ_RANGE.min) || null;
    var list = [
      { key: 'last-60',    label: 'Posledních 60 dní',  from: addDaysStr(today, -59),  to: today },
      { key: 'last-120',   label: 'Posledních 120 dní', from: addDaysStr(today, -119), to: today },
      { key: 'this-month', label: 'Tento měsíc',       from: monthStart(now),  to: today },
      { key: 'last-month', label: 'Minulý měsíc',      from: monthStart(prevM), to: monthEnd(prevM) },
      { key: 'last-90',    label: 'Posledních 90 dní', from: addDaysStr(today, -89), to: today },
      { key: 'this-year',  label: 'Tento rok',         from: ymd(new Date(now.getFullYear(),0,1)), to: today }
    ];
    if (bqMin){
      list.push({ key: 'all', label: 'Celá historie', from: bqMin, to: today,
                  note: 'od ' + fmt.date(bqMin) });
    }
    // Nic pod minimem BQ nedává smysl (server tam nemá data) → ořízni.
    return list.map(function (r){
      if (bqMin && r.from < bqMin) r.from = bqMin;
      return r;
    }).filter(function (r){ return r.from <= r.to; });
  }

  function buildDatePop(){
    var pop = el('#period-pop');
    if (!pop) return;

    pop.innerHTML =
      '<div class="pp-quick">' +
        '<div class="pp-quick-h">Rychlé volby</div>' +
        quickRanges().map(function (r){
          return '<button class="pp-q" type="button" data-q="' + esc(r.key) + '">' +
                 '<span class="pp-q-l">' + esc(r.label) + '</span>' +
                 (r.note ? '<span class="pp-q-n">' + esc(r.note) + '</span>' : '') +
                 '</button>';
        }).join('') +
      '</div>' +
      '<div class="pp-main">' +
        '<div class="pp-readout">' +
          '<div class="pp-ro"><span class="pp-ro-l">Od</span><b class="pp-ro-v" id="pp-from">—</b></div>' +
          '<span class="pp-arrow" aria-hidden="true">→</span>' +
          '<div class="pp-ro"><span class="pp-ro-l">Do</span><b class="pp-ro-v" id="pp-to">—</b></div>' +
          '<span class="pp-days" id="pp-days"></span>' +
        '</div>' +
        '<div class="pp-cal" id="pp-cal">' +
          '<input id="period-custom" class="pp-anchor" type="text" readonly tabindex="-1" aria-hidden="true">' +
        '</div>' +
        '<div class="pp-foot">' +
          '<span class="pp-hint" id="pp-hint">Vyber první a poslední den</span>' +
          '<button class="btn btn-sm" id="pp-cancel" type="button">Zrušit</button>' +
          '<button class="btn btn-sm btn-primary" id="pp-apply" type="button" disabled>Použít</button>' +
        '</div>' +
      '</div>';

    var input = el('#period-custom'), mount = el('#pp-cal');
    if (input && typeof flatpickr !== 'undefined'){
      _fp = flatpickr(input, {
        inline: true,
        appendTo: mount,
        mode: 'range',
        dateFormat: 'Y-m-d',
        showMonths: window.innerWidth < PP_ONE_MONTH_BELOW ? 1 : 2,  // úzké okno → 1 měsíc
        monthSelectorType: 'static',
        minDate: (ADS.BQ_RANGE && ADS.BQ_RANGE.min) || undefined,
        maxDate: todayStr(),                            // budoucí dny = prázdná data
        locale: FP_CS,
        onChange: function (sel){ onPickChange(sel); }
      });
    }

    pop.addEventListener('click', function (ev){
      var q = ev.target.closest && ev.target.closest('.pp-q');
      if (q){
        var def = quickRanges().filter(function (r){ return r.key === q.getAttribute('data-q'); })[0];
        if (def){ closeDatePop(); setCustom(def.from, def.to); }   // rychlá volba = hned
        return;
      }
      if (ev.target.closest('#pp-cancel')){ closeDatePop(); return; }
      if (ev.target.closest('#pp-apply')){
        if (_pending){ var p = _pending; closeDatePop(); setCustom(p.from, p.to); }
      }
    });

    // Enter = Použít (když je co použít). Esc řeší globální handler níž.
    pop.addEventListener('keydown', function (ev){
      if (ev.key === 'Enter' && _pending){
        ev.preventDefault();
        var p = _pending; closeDatePop(); setCustom(p.from, p.to);
      }
    });
  }

  function onPickChange(sel, silent){
    var from = sel && sel[0] ? ymd(sel[0]) : null;
    var to   = sel && sel[1] ? ymd(sel[1]) : null;
    var f = el('#pp-from'), t = el('#pp-to'), d = el('#pp-days'),
        a = el('#pp-apply'), h = el('#pp-hint');
    if (f) f.textContent = from ? fmt.date(from) : '—';
    if (t) t.textContent = to   ? fmt.date(to)   : '—';
    if (from && to){
      _pending = { from: from, to: to };
      var n = daysBetween(from, to);
      if (d) d.textContent = n + ' ' + plural(n, 'den', 'dny', 'dní');
      if (h) h.textContent = 'Potvrď tlačítkem Použít';
      // Focus na „Použít" = Enter hned potvrdí. Při PŘEDvyplnění (silent) ne —
      // to by ukradlo focus kalendáři, ve kterém chce uživatel teprve klikat.
      if (a){ a.disabled = false; if (!silent) a.focus(); }
    } else {
      _pending = null;
      if (d) d.textContent = '';
      if (h) h.textContent = from ? 'Teď vyber poslední den' : 'Vyber první a poslední den';
      if (a) a.disabled = true;
    }
  }
  function plural(n, one, few, many){
    n = Math.abs(Number(n) || 0);
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  }

  function openDatePop(){
    var pop = el('#period-pop'), btn = el('#period-custom-btn');
    if (!pop) return;
    pop.hidden = false;
    // Viewport clamp (Filip: popover vytékal přes okraj a kalendář byl mimo obrazovku).
    // Default kotvení je CSS `right:0`; když se popover nevejde, přepočítáme `left` tak,
    // aby zůstal celý v okně s 12px rezervou.
    pop.style.left = ''; pop.style.right = '';
    requestAnimationFrame(function () {
      if (pop.hidden) return;
      var r = pop.getBoundingClientRect(), pad = 12;
      if (r.left < pad || r.right > window.innerWidth - pad) {
        var pr = (pop.offsetParent || document.body).getBoundingClientRect();
        var desiredLeft = Math.max(pad, Math.min(window.innerWidth - pad - pop.offsetWidth, r.left));
        pop.style.right = 'auto';
        pop.style.left = Math.round(desiredLeft - pr.left) + 'px';
      }
    });
    if (btn) btn.setAttribute('aria-expanded', 'true');
    // Předvyplň aktuálním obdobím → Filip vidí, odkud se posouvá.
    if (_fp){
      // Na úzkém okně se 2 měsíce nevejdou → přepni dřív, než se popover ukáže.
      var wantMonths = window.innerWidth < PP_ONE_MONTH_BELOW ? 1 : 2;
      if (_fp.config.showMonths !== wantMonths) _fp.set('showMonths', wantMonths);
      _fp.setDate([ADS.state.from, ADS.state.to], false);
      // Skoč o měsíc zpět: se 2 panely by `to` (= dnešek) otevřelo [dnešní měsíc,
      // PŘÍŠTÍ měsíc] — a příští měsíc je celý za maxDate, tedy prázdný šedý panel.
      // Takhle je vidět [minulý měsíc, dnešek] = přesně tam, kde jsou data.
      var jt = new Date(String(ADS.state.to).slice(0,10) + 'T00:00:00');
      jt.setDate(1); jt.setMonth(jt.getMonth() - (wantMonths > 1 ? 1 : 0));
      _fp.jumpToDate(jt);
      onPickChange(_fp.selectedDates || [], true);
      // Předvyplněné = nic nového nevybráno → „Použít" nemá co potvrzovat.
      _pending = null;
      var a = el('#pp-apply'); if (a) a.disabled = true;
      var h = el('#pp-hint');  if (h) h.textContent = 'Vyber první a poslední den';
    }
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onPopKey, true);
  }
  function closeDatePop(){
    var pop = el('#period-pop'), btn = el('#period-custom-btn');
    if (pop) { pop.hidden = true; pop.style.left = ''; pop.style.right = ''; }   // reset clampu
    if (btn) btn.setAttribute('aria-expanded', 'false');
    _pending = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onPopKey, true);
  }
  function isDatePopOpen(){ var p = el('#period-pop'); return p && !p.hidden; }
  function onDocDown(ev){
    var pop = el('#period-pop'), btn = el('#period-custom-btn');
    if (!pop || pop.hidden) return;
    if (pop.contains(ev.target) || (btn && btn.contains(ev.target))) return;
    closeDatePop();
  }
  function onPopKey(ev){ if (ev.key === 'Escape'){ ev.stopPropagation(); closeDatePop(); } }

  function wireTopbar(){
    // Prsteny / Náušnice
    var seg = el('#tab-switch');
    if (seg){
      seg.querySelectorAll('.seg-btn').forEach(function (b){
        b.addEventListener('click', function (){ setTab(b.getAttribute('data-tab')); });
      });
    }
    // Vlastní období (N5) — popover s rychlými volbami + kalendářem
    var customBtn = el('#period-custom-btn');
    if (customBtn){
      customBtn.addEventListener('click', function (){
        if (isDatePopOpen()) closeDatePop(); else openDatePop();
      });
    }
    // Obnovit teď
    var rb = el('#btn-refresh');
    if (rb) rb.addEventListener('click', refreshNow);
    // Odhlásit
    var lo = el('#btn-logout');
    if (lo) lo.addEventListener('click', logout);
  }

  function markChips(){
    var box = el('#period-chips');
    if (box){
      box.querySelectorAll('.chip').forEach(function (c){
        c.classList.toggle('is-active', Number(c.getAttribute('data-days')) === ADS.state.preset);
      });
    }
    var cb = el('#period-custom-btn');
    var isCustom = (ADS.state.preset === 'custom');
    if (cb){
      cb.classList.toggle('is-active', isCustom);
      // N5: když je aktivní vlastní období, chip UKAZUJE rozsah — ne slovo „Vlastní".
      // Bez toho nešlo z lišty poznat, jaké období je vlastně zvolené.
      var lbl = el('#period-custom-label');
      if (lbl) lbl.textContent = isCustom
        ? (dayMonth(ADS.state.from) + ' – ' + dayMonth(ADS.state.to))
        : 'Vlastní';
      cb.title = isCustom
        ? (fmt.date(ADS.state.from) + ' – ' + fmt.date(ADS.state.to) +
           ' (' + daysBetween(ADS.state.from, ADS.state.to) + ' dní) — klikni pro změnu')
        : 'Vlastní období — rychlé volby nebo kalendář';
    }
  }

  function updatePeriodSummary(){
    var box = el('#period-summary');
    if (!box) return;
    var n = daysBetween(ADS.state.from, ADS.state.to);
    var lbl = ADS.state.preset === 'custom'
      ? 'Vlastní období'
      : 'Posledních ' + ADS.state.preset + ' dní';
    box.textContent = lbl + ' · ' + fmt.date(ADS.state.from) + ' – ' + fmt.date(ADS.state.to) + ' (' + n + ' dní)';
  }

  function setPeriod(days, silent){
    ADS.state.preset = days;
    ADS.state.to = todayStr();
    ADS.state.from = addDaysStr(ADS.state.to, -(days - 1));
    markChips(); updatePeriodSummary();
    if (!silent){ emit('periodchange', clone(ADS.state)); fireReady(); }
  }

  function setCustom(from, to){
    if (from > to){ var t = from; from = to; to = t; }
    ADS.state.preset = 'custom';
    ADS.state.from = from; ADS.state.to = to;
    markChips(); updatePeriodSummary();
    emit('periodchange', clone(ADS.state)); fireReady();
  }

  function setTab(tab){
    if (tab !== 'rings' && tab !== 'earrings') return;
    if (ADS.state.tab === tab) return;
    ADS.state.tab = tab;
    // přepnout viditelnost view
    var rings = el('#rings-view'), ear = el('#earrings-root');
    if (rings) rings.hidden = (tab !== 'rings');
    if (ear)   ear.hidden   = (tab !== 'earrings');
    // segment active
    var seg = el('#tab-switch');
    if (seg) seg.querySelectorAll('.seg-btn').forEach(function (b){
      b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    });
    emit('tabchange', clone(ADS.state)); fireReady();
  }

  function updateUserLabel(){
    var u = el('#user-label');
    // '?' = server neposlal user; radši viditelný otazník než falešné jméno.
    var name = ADS.state.user || '?';
    if (u) u.textContent = name;
    // Avatar = iniciála; ve sbaleném sidebaru je z uživatele vidět jen tohle kolečko.
    var av = el('#user-avatar');
    if (av){
      av.textContent = name.slice(0, 1).toUpperCase();
      av.title = name;
    }
  }

  function updateRefreshLabel(){
    var l = el('#refresh-label');
    if (!l) return;
    l.textContent = ADS.state.lastRefresh ? ('obnoveno ' + ADS.state.lastRefresh) : '';
  }

  function refreshNow(){
    var rb = el('#btn-refresh');
    if (rb){ rb.classList.add('is-loading'); rb.disabled = true; }
    api('refresh', {}, { method: 'POST' })
      .then(function (r){
        ADS.state.lastRefresh = (r && (r.last_refresh || r.lastRefresh)) || nowStamp();
        _ripeRef = {};                   // 180d reference se po ingestu mohla pohnout
        updateRefreshLabel();
        toast('Data se obnovují z API…', 'info');
        emit('refreshed', r);
        return fireReady();
      })
      .catch(function (e){
        toast('Obnovení selhalo' + (e && e.status ? ' (' + e.status + ')' : ''), 'error');
      })
      .finally(function (){
        if (rb){ rb.classList.remove('is-loading'); rb.disabled = false; }
      });
  }

  /* =====================================================================
     SHELL SEKCE — HEALTH, ANOMÁLIE, HECK (z action=overview + wizard_today)
     ===================================================================== */
  function renderShell(){
    renderHealthAndAnomaly();
    renderHeck();
    renderBudgetSplit();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     ROZPAD ROZPOČTU (Filip 14. 8. 2026) — „kolik jde do nových nápadů, kolik
     do ověřených co dobíhají v EXPERIMENTU a kolik do hlavních kampaní."
     Cíl testu je TEST_BUDGET_TARGET (30 %) a měří se SPRÁVNĚ = spend do kreativ,
     které v ten den ještě neměly verdikt. NE podle názvu kampaně — ta obsahuje
     i winnery po verdiktu (naměřeno 18 % spendu účtu).
     ───────────────────────────────────────────────────────────────────────── */
  var _bsCache = null, _bsKey = '';
  function renderBudgetSplit(){
    var root = el('#budget-split');
    if (!root || (ADS.state.tab && ADS.state.tab !== 'rings')) { if (root) root.innerHTML = ''; return; }
    var key = ADS.state.from + '|' + ADS.state.to;
    if (_bsKey === key && _bsCache) { paintBudgetSplit(root, _bsCache); return; }
    root.innerHTML = '<div class="bs-wrap"><div class="skel skel-line" style="width:40%"></div>' +
                     '<div class="skel skel-line" style="height:22px"></div></div>';
    api('budget_split', { from: ADS.state.from, to: ADS.state.to }).then(function(res){
      var d = (res && res.buckets) ? res : (res && res.data) || null;
      if (!d || !d.buckets) { root.innerHTML = ''; return; }
      _bsCache = d; _bsKey = key; paintBudgetSplit(root, d);
    }).catch(function(){ root.innerHTML = ''; });
  }
  // Kontrastní paleta (Filip 14. 8.: „moc malý kontrasty, ať to víc vynikne").
  // Sytější tóny téže rodiny — pruh musí být čitelný i koutkem oka.
  var BS_COLORS = { test: '#e2761b', proven_exp: '#4f9a3f', scale: '#1f6fb2', other: '#a89f90' };
  // app.js nemá vlastní esc()/fmtInt() — používá ADS.fmt.*; držíme to lokálně, ať sekce
  // nezávisí na tables.js (načítá se později a při chybě by spolkla celý blok).
  function bsEsc(x){ return String(x == null ? '' : x).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function bsInt(n){ return (ADS.fmt && ADS.fmt.int) ? ADS.fmt.int(n)
    : String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function paintBudgetSplit(root, d){
    var target = Number(d.target_test_pct) || 30;
    var test = (d.buckets.filter(function(b){ return b.key === 'test'; })[0] || {}).pct || 0;
    var diff = test - target;
    // hodnocení: ±8 p.b. od cíle = v pořádku (pásmo, ne bodová hodnota)
    var verdict = Math.abs(diff) <= 8
      ? { txt: 'v cílovém pásmu', col: '#1e7a34', bg: '#e8f6ea' }
      : (diff > 0 ? { txt: 'nad cílem — testuje se víc, než je potřeba', col: '#9a6400', bg: '#fdf3e0' }
                  : { txt: 'POD cílem — hrozí, že dojdou winneři', col: '#c0271f', bg: '#fdeaea' });
    var segs = '', legend = '';
    for (var i = 0; i < d.buckets.length; i++){
      var b = d.buckets[i];
      if (!b.pct) continue;
      segs += '<div class="bs-seg" style="width:' + b.pct + '%;background:' + (BS_COLORS[b.key] || '#ccc') + '" ' +
              'title="' + bsEsc(b.label + ' — ' + bsInt(b.spend) + ' Kč (' + b.pct + ' %)\n\n' + b.hint) + '"></div>';
      legend += '<span class="bs-li"><i style="background:' + (BS_COLORS[b.key] || '#ccc') + '"></i>' +
                bsEsc(b.label) + ' <b>' + String(b.pct).replace('.', ',') + ' %</b> ' +
                '<span class="bs-kc">' + bsInt(b.spend) + ' Kč</span></span>';
    }
    root.innerHTML =
      '<div class="bs-wrap">' +
        '<div class="bs-head">' +
          '<span class="bs-title">Rozpad rozpočtu</span>' +
          '<span class="bs-verdict" style="color:' + verdict.col + ';background:' + verdict.bg + '">Test ' +
            String(test).replace('.', ',') + ' % · cíl ' + target + ' % — ' + verdict.txt + '</span>' +
        '</div>' +
        '<div class="bs-bar">' + segs + '</div>' +
        '<div class="bs-legend">' + legend + '</div>' +
        '<div class="bs-note">„Test" = spend do kreativ, které v ten den ještě neměly verdikt (' +
          (d.promote_min_bookings || 10) + ' rezervací) — ne spend v kampani jménem EXPERIMENT. ' +
          'Ověřené, co dobíhají v EXPERIMENTU, nejsou chyba (dokud vydělávají), ale patří do SCALE. ' +
          'Pozor na dvě různé laťky: „verdikt" tady = jen 10 rezervací (počítá se zpětně po dnech, ROAS v tom být nemůže), ' +
          'kdežto POVÝŠENÍ chce navíc CPA ≤ benchmark a ROAS model ≥ 5.</div>' +
      '</div>';
  }

  // Fallback, když server nepošle health.color. Prahy i porovnání drží 1:1 se
  // serverem (api.php: pct > HEALTH_RED → red; pct > HEALTH_YELLOW → yellow).
  function healthLevel(pct){
    var y = thNum('HEALTH_YELLOW', 'health_yellow', 0.15),
        r = thNum('HEALTH_RED',    'health_red',    0.30);
    if (pct > r) return 'red';
    if (pct > y) return 'yellow';
    return 'green';
  }

  function renderHealthAndAnomaly(){
    var root = el('#health-root');
    if (!root) return;
    // skeleton dokud nemáme data
    if (!_overviewCache){
      root.innerHTML =
        '<div class="health">' +
          '<div class="health-hero"><div class="skel skel-line" style="width:60%;height:40px"></div>' +
          '<div class="skel skel-line" style="width:80%"></div></div>' +
          Array(5).join('') +
          '<div class="tile"><div class="skel skel-line" style="width:50%"></div><div class="skel skel-line" style="width:70%;height:20px"></div></div>'.repeat(5) +
        '</div>';
    }

    api('overview', { from: ADS.state.from, to: ADS.state.to, tab: ADS.state.tab })
      .then(function (ov){
        _overviewCache = ov || {};
        drawHealth(_overviewCache);
        drawAnomaly(_overviewCache);
        // sdílej overview i s moduly
        emit('overview', _overviewCache);
      })
      .catch(function (e){
        root.innerHTML = '<div class="card card-pad" style="color:var(--text-3)">' +
          'Health se nepodařilo načíst' + (e && e.status ? ' (' + e.status + ')' : '') + '.</div>';
      });
  }

  /* Referenční DLOUHÉ okno (SPEC §1: „prahy ~8 platí jen pro dlouhá okna").
     ROAS krátkého okna se NESMÍ číst jako konečný. Vedle něj proto ukážeme, co
     ukazuje 180denní okno — MĚŘENÉ číslo, ne extrapolace. Extrapolaci („po dozrání
     to bude X×") tady vědomě NEDĚLÁME: na 30d okně vychází dopočet 9,9×, ale 90d
     okno měří 7,4× → dopočet z čerstvého okna přestřeluje o ~35 % a hnal by Filipa
     do opačné chyby (přeškálovat). Trend po dopočtu zralosti patří do týdenního
     grafu (charts.js), kde je vidět i historické pásmo. Cache per tab. */
  var RIPE_REF_DAYS = 180;
  var _ripeRef = {};        // tab -> {roas_real, roas_model} | 'pending' | 'fail'

  function ripeRefFor(tab, done){
    var c = _ripeRef[tab];
    if (c && c !== 'pending' && c !== 'fail'){ done(c); return; }
    if (c === 'pending' || c === 'fail') return;      // běží / nepovedlo se → badge jede bez reference
    _ripeRef[tab] = 'pending';
    var to = todayStr(), from = addDaysStr(to, -(RIPE_REF_DAYS - 1));
    api('overview', { from: from, to: to, tab: tab })
      .then(function (ov){
        var t = (ov && ov.totals) || {};
        var v = { roas_real: num(t.roas_real, null), roas_model: num(t.roas_model, null) };
        _ripeRef[tab] = v;
        done(v);
      })
      .catch(function (){ _ripeRef[tab] = 'fail'; });
  }

  function drawHealth(ov){
    var root = el('#health-root');
    if (!root) return;
    var h = ov.health || {};
    // KANONICKY (api.php): health = { headline_pct, headline_color, headline_label, … }.
    //
    // H5 — headline je % spendu POD BREAK-EVEN, ne pod ROAS 1. Kotva 1,0 v tomhle nástroji
    // NIKDE JINDE neexistuje (kill vrstva 4 i referenční linka v grafu jedou na break-even
    // 2,0), takže velké číslo hlásilo mírnější stav než laťka, na které se reálně rozhoduje:
    // naměřeno 35,5 % (pod 1) vs 46,0 % (pod break-evenem) → ~142 tis. Kč spendu, který se
    // tvářil jako v pohodě. `pct_spend_roas_below_1` server posílá dál jako DOPLŇKOVÉ číslo.
    //
    // Měřítko OVĚŘENO ve zdroji: server posílá round(…,4) → PODÍL 0..1 ⇒ fmt.pct(0..1) sedí.
    // Popisek chodí ZE SERVERU spolu s číslem (ať se nemůže stát, že nad break-even procentem
    // svítí label „ROAS < 1"). Fallbacky = pojistka pro starší fixtury/mock.
    var pct = num(
      h.headline_pct != null ? h.headline_pct
        : (h.pct_spend_below_breakeven != null ? h.pct_spend_below_breakeven
          : (h.pct_spend_roas_below_1 != null ? h.pct_spend_roas_below_1
            : (h.spend_lt1_pct != null ? h.spend_lt1_pct : h.pct))), 0);
    var lvl = h.headline_color || h.color_breakeven || h.color || h.level || healthLevel(pct);
    var headlineLabel = h.headline_label || 'spendu teče pod break-even';
    var tot = ov.totals || {};
    // KANONICKY: totals.winner_count (ne winners_count).
    var winners = num(tot.winner_count != null ? tot.winner_count : tot.winners_count, 0);

    function tile(label, val, cls, subHtml, tip){
      return '<div class="tile"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
             '<div class="tile-label">' + esc(label) + '</div>' +
             '<div class="tile-val ' + (cls || '') + '">' + val + '</div>' +
             (subHtml ? '<div class="tile-sub">' + subHtml + '</div>' : '') + '</div>';
    }

    var fr = ov.freshness || {};
    var maxNote = (fr.bq_max_date || (ADS.BQ_RANGE && ADS.BQ_RANGE.max));
    // Server kotví health na decision_roas: prsteny = ROAS model, náušnice = ROAS
    // zaplaceno (SPEC §5 „kill/winners na zaplaceno"). Popisek to musí říct pravdivě.
    var isEar = ADS.state.tab === 'earrings';

    /* ---- ZRALOST OKNA (NALEZY #3, SPEC §1) --------------------------------
       Každé ROAS číslo za období je podhodnocené o tolik, kolik okna ještě
       nedozrálo. UI to MUSÍ přiznat, jinak Filip čte 30d ROAS 4,2× jako konečný
       verdikt (a killuje), přestože 180d okno na stejném účtu měří 7,6×.
       Server zralost zatím neposílá → počítáme ji z okna dle křivky SPEC §1. */
    var ripe = num((ov.maturity != null ? ov.maturity : fr.maturity), null);
    if (ripe == null) ripe = ripeOfWindow(ADS.state.from, ADS.state.to);
    var immature  = (ripe < RIPE_WARN_BELOW);
    var tooFresh  = (ripe < RIPE_TOO_FRESH);
    var winDays   = daysBetween(ADS.state.from, ADS.state.to);

    var ripeTip = immature
      ? 'Tržba dozrává ~8 týdnů (SPEC §1): lead z dneška má naběhnutých ~6 % konečné hodnoty, '
        + 'lead starý 56+ dní ~100 %. Tohle okno je zralé ~' + Math.round(ripe * 100) + ' % → '
        + 'ROAS je PODHODNOCENÝ a ještě poroste. Nesrovnávej ROAS mezi různě dlouhými okny.'
      : 'Okno je zralé ~' + Math.round(ripe * 100) + ' % → ROAS je použitelný jako konečný.';

    // Badge do ROAS dlaždic: „okno zralé ~39 %" (+ na ROZHODOVACÍ dlaždici i měřená
    // 180d reference, která doteče asynchronně). Rozhodovací metrika = ta, na které
    // visí kill/winners prahy: prsteny → ROAS model, náušnice → ROAS zaplaceno.
    function ripeBadge(withRef){
      if (!immature) return '';
      return '<span style="color:var(--yellow);font-weight:650">okno zralé ~' + fmt.pct(ripe) + '</span>' +
             (tooFresh ? '<span> · moc čerstvé na ROAS</span>' : '') +
             (withRef ? '<span id="ripe-ref"></span>' : '');
    }

    root.innerHTML =
      '<div class="health">' +
        '<div class="health-hero h-' + lvl + '"' +
          (immature ? ' title="' + esc('Pozor: ' + ripeTip + ' Část kreativ tady spadne pod break-even '
            + 'jen proto, že jejich tržba ještě nedozrála — ne proto, že prodělávají.') + '"' : '') + '>' +
          '<div class="big">' + fmt.pct(pct) + '</div>' +
          // H5: popisek i číslo ze serveru (health.headline_*) → nemůžou se rozejít.
          '<div class="big-label">' + esc(headlineLabel) + ' (' +
            (isEar ? 'zaplaceno' : 'model') + ')</div>' +
          '<div class="big-note">' + esc('Reklamy') +
            (maxNote ? ' · data do ' + fmt.date(maxNote) : '') +
            (immature ? ' · <span style="color:var(--yellow);font-weight:650">okno zralé ~'
                        + fmt.pct(ripe) + ' → nadhodnoceno</span>' : '') +
          '</div>' +
        '</div>' +
        tile('Spend', fmt.money(tot.spend), '') +
        tile('ROAS real', fmt.roas(tot.roas_real), '', ripeBadge(isEar), ripeTip) +
        tile('ROAS model', fmt.roas(tot.roas_model), semaClass(tot.roas_model), ripeBadge(!isEar), ripeTip) +
        // H2/H4 — `kill_count` je AKČNÍ číslo (jen kreativy s běžící reklamou) = přesně tolik,
        // kolik jich ukáže záložka „Na kill". Dřív tu svítilo `kill_layer > 0` (34) proti
        // tabulce s 9 → dvě čísla pro totéž na jedné obrazovce. Celek (vč. už vypnutých) je
        // teď malým písmem pod tím, ať je vidět, že se nikam neztratil.
        tile('Kill kandidáti', fmt.int(tot.kill_count), (num(tot.kill_count,0) > 0 ? 'neg' : ''),
             (num(tot.kill_count_all, 0) > num(tot.kill_count, 0)
               ? 'z ' + fmt.int(tot.kill_count_all) + ' vč. vypnutých' : ''),
             (num(tot.kill_count_all, 0) > num(tot.kill_count, 0)
               ? 'Běžící (jde killnout): ' + fmt.int(tot.kill_count) + ' · vč. už vypnutých: '
                 + fmt.int(tot.kill_count_all) + '. Vypnuté v okně spálily peníze, ale killnout je nejde.'
               : '') + (immature ? ' Pozor: ' + ripeTip : '')) +
        tile('Winners', fmt.int(winners), (winners > 0 ? 'pos' : ''), '',
             immature ? 'Pozor: ' + ripeTip : '') +
      '</div>';

    // MĚŘENÁ reference z dlouhého okna — doteče asynchronně, badge na ni nečeká.
    if (immature && winDays < RIPE_REF_DAYS){
      ripeRefFor(ADS.state.tab, function (ref){
        var slot = el('#ripe-ref');
        if (!slot || !ref) return;
        var v = isEar ? ref.roas_real : ref.roas_model;
        if (v == null) return;
        slot.textContent = ' · 180d měří ' + fmt.roas(v);
      });
    }
  }
  function semaClass(roas){
    var s = semafor(roas);
    return (s === 'green' || s === 'lgreen') ? 'pos' : (s === 'red' ? 'neg' : '');
  }

  function drawAnomaly(ov){
    var box = el('#anomaly-banner');
    if (!box) return;
    // KANONICKY (api.php): PLOCHÉ pole `anomalies:[{funnel,metric,yesterday,median_7d,deviation,direction}]`.
    // Žádný `active` flag — banner se řídí jen tím, jestli něco přišlo.
    // ov.anomaly.items = pojistka pro starší fixtury.
    var items = ov.anomalies || (ov.anomaly && ov.anomaly.items) || [];
    if (!items.length){ box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    var chips = items.map(function (it){
      // `deviation` je PODÍL (round 3): 0.537 = +53,7 % vs. 7d medián.
      var dev = num(it.deviation != null ? it.deviation : it.delta_pct, 0);
      var up  = it.direction ? (String(it.direction).toLowerCase() === 'up') : (dev >= 0);
      var met = String(it.metric || '').toUpperCase();
      return '<span class="anomaly-item">' + esc(it.funnel || it.name || '') +
             (met ? ' · ' + esc(met) : '') + ' ' + (up ? '▲' : '▼') + ' ' +
             fmt.pct(Math.abs(dev)) + '</span>';
    }).join('');
    box.innerHTML =
      '<div class="banner banner-anomaly">' +
        '<span class="banner-ico">⚠️</span>' +
        '<div class="banner-body">' +
          '<div class="banner-title">Anomálie: včera vs. 7denní medián funnelu</div>' +
          '<div class="anomaly-list">' + chips + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderHeck(){
    var box = el('#heck-banner');
    if (!box) return;
    api('wizard_today', {})
      .then(function (w){
        w = w || {};
        var done = !!w.done || w.finished_at || (w.status === 'done');
        if (done){
          box.innerHTML =
            '<div class="banner banner-done">' +
              '<span class="banner-ico">✅</span>' +
              '<div class="banner-body">' +
                '<div class="banner-title">Denní kontrola hotová</div>' +
                '<div class="banner-text">' +
                  (w.who ? esc(w.who) + ' · ' : '') +
                  (w.finished_at ? esc(fmt.date(w.finished_at)) : 'dnes') +
                  (w.summary ? ' · ' + esc(w.summary) : '') +
                '</div>' +
              '</div>' +
              '<button class="btn btn-sm" id="heck-reopen" type="button">Otevřít znovu</button>' +
            '</div>';
          var r = el('#heck-reopen');
          if (r) r.addEventListener('click', function (){ emit('wizardopen', { rerun: true }); });
        } else {
          var n = (w.pending_kill != null) ? w.pending_kill : null;
          box.innerHTML =
            '<div class="banner banner-heck">' +
              '<span class="banner-ico">🔎</span>' +
              '<div class="banner-body">' +
                '<div class="banner-title">Denní check ještě neproběhl</div>' +
                '<div class="banner-text">Projdi kill kandidáty, funnely a winnery.' +
                  (n != null ? ' Čeká ' + n + ' kill kandidátů.' : '') + '</div>' +
              '</div>' +
              '<button class="btn" id="heck-start" type="button">Spustit denní kontrolu</button>' +
            '</div>';
          var s = el('#heck-start');
          if (s) s.addEventListener('click', function (){ emit('wizardopen', {}); });
        }
      })
      .catch(function (){
        // Bez wizard dat necháme banner prázdný (nerušíme UI)
        box.innerHTML = '';
      });
  }

  /* Wizard zavřen -> překresli shell (mohly proběhnout killy) + sekce */
  bus.addEventListener('wizardclose', function (){ if (_ready) { _overviewCache = null; fireReady(); } });
  /* Po killu -> osvěž health/overview */
  bus.addEventListener('killed', function (){ if (_ready){ _overviewCache = null; renderHealthAndAnomaly(); } });

  /* =====================================================================
     BOOT
     ===================================================================== */
  function boot(){
    wireLogin();

    if (IS_MOCK){
      // standalone demo: rovnou dovnitř (login se přeskočí).
      // user NEhardcodujeme — vezme se z mock configu stejnou cestou jako naostro.
      enterApp().catch(function (e){ console.error(e); showLogin(''); });
      return;
    }

    // Detekce platné session: zkusíme config; 200 = přihlášen, 401 = login
    api('config')
      .then(function (cfg){ applyConfig(cfg); return enterApp(); })
      .catch(function (e){
        if (e && e.status && e.status !== 401){
          console.warn('[ADS] config error', e.status);
        }
        showLogin('');
      });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
