/* ==========================================================================
 * NK Ads Dashboard — KALENDÁŘ KONTROL (calendar.js)
 * --------------------------------------------------------------------------
 * Filip (16. 7.), odpověď 4: „Kalendář: přehled I HISTORIE — historie by byla
 * super" → rozkliknout starý běh a vidět, co se rozhodlo a PROČ.
 * Denní kontrola se zapisuje do NAŠÍ DB (ads_wizard_runs + ads_rule_feedback).
 * Žádný Notion, žádný Slack.
 *
 * K ČEMU TO JE: Filip tím vidí, jestli kontroly vůbec běží, kdo je dělá — a
 * hlavně u odmítnutých doporučení DŮVOD. Z těch důvodů se ladí nuance pravidel
 * (SPEC §5: feedback smyčka je additivní, pravidla se nepřepisují).
 *
 * ZODPOVĚDNOST: jen mount #view-calendar. Routing (ADS.route + 'routechange')
 * a <script> tag v index.html dělá shell agent.
 *
 * KONTRAKT S API (staví api agent):
 *   GET ?action=wizard_calendar&from&to → {days:[{date,runs:[…]}]} | {runs:[…]}
 *   GET ?action=wizard_run&id=N        → {run:{id,run_date,who,started_at,finished_at,steps}}
 *   GET ?action=feedback_log&days=90   → {by_rule:[…], total, recent:[…]}  ← UŽ ŽIJE
 * Normalizace je tolerantní (normRun/normCalendar) — endpointy vznikají paralelně.
 *
 * steps_json čteme v tom tvaru, v jakém ho PÍŠE wizard.js (buildStepsJson):
 *   {tab,who,from,to,generated_at,finished,missing,steps:[
 *     {key:'kill',   items:[{creative,funnel,kill_layer,decision:'kill'|'keep',reason,note,…}]},
 *     {key:'funnels',items:[{funnel,decision:'ok'|'flag',note,…}]},
 *     {key:'events', items:[{event, decision:'ok'|'flag',note,…}]},
 *     {key:'scale',  items:[{creative,decision:'scale'|'wait',note,…}]},
 *     {key:'newest', items:[{creative,decision:'ok'|'flag',note,…}]},
 *     {key:'summary',decision:'saved'|'draft',counts:{killed,kept,flags,scale}}]}
 *
 * Vlastní scoped styly (prefix .cal-), stejná konvence jako wizard.js (.hw-).
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__ADS_CALENDAR_LOADED__) return;
  window.__ADS_CALENDAR_LOADED__ = true;

  var MOUNT_ID = 'view-calendar';
  var MOUNT_SEL = '#' + MOUNT_ID;
  /* Klíč routy bereme z ADS.ROUTES podle `mount` (shell = zdroj pravdy; dnes #/kalendar). */
  var ROUTE_FALLBACK = ['kalendar', 'calendar'];

  var MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
                'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  var DOW = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

  /* ------------------------------------------------------------------ *
   * Utility
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
  function toast(m, t) { var f = A().toast; if (f) f(m, t); else console.log('[calendar]', m); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function parseYmd(s) { var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtDate(s) { var f = A().fmt; return f ? f.date(s) : String(s || ''); }
  function fmtDateLong(s) {
    if (!s) return '';
    var d = parseYmd(s);
    return d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var m = String(ts).match(/(\d{2}):(\d{2})/);
    return m ? m[1] + ':' + m[2] : '';
  }
  function durationTxt(a, b) {
    if (!a || !b) return '';
    var t1 = new Date(String(a).replace(' ', 'T')), t2 = new Date(String(b).replace(' ', 'T'));
    var ms = t2 - t1;
    if (!isFinite(ms) || ms < 0) return '';
    var min = Math.round(ms / 60000);
    if (min < 1) return 'pod minutu';
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
  }
  function plural(n, a, b, c) { return n === 1 ? a : (n >= 2 && n <= 4 ? b : c); }
  function initials(who) {
    var w = String(who || '?').trim();
    return w ? w.charAt(0).toUpperCase() : '?';
  }

  /* ------------------------------------------------------------------ *
   * Stav
   * ------------------------------------------------------------------ */
  var C = {
    y: new Date().getFullYear(),
    m: new Date().getMonth(),     // 0..11
    days: {},                     // 'YYYY-MM-DD' → [run]
    loading: false,
    loaded: false,
    error: null,
    notWired: false,              // wizard_calendar ještě neexistuje
    cache: {}                     // 'YYYY-MM' → days
  };

  /* ------------------------------------------------------------------ *
   * Normalizace odpovědí (tolerantní)
   * ------------------------------------------------------------------ */
  function pickNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && isFinite(Number(v))) return Number(v);
    }
    return null;
  }
  function stepsArr(steps) {
    if (!steps) return [];
    if (Array.isArray(steps)) return steps;
    if (Array.isArray(steps.steps)) return steps.steps;
    return [];
  }
  function parseSteps(s) {
    if (!s) return null;
    if (typeof s === 'string') { try { return JSON.parse(s); } catch (_) { return null; } }
    return s;
  }
  /* Spočítá killy/odmítnutí ze steps_json (když je server nepošle napřímo). */
  function countsFromSteps(steps) {
    var arr = stepsArr(steps);
    if (!arr.length) return null;
    var out = { killed: 0, kept: 0, flags: 0, scaled: 0, waits: 0, decided: 0 };
    arr.forEach(function (st) {
      var items = st.items || [];
      if (st.key === 'summary' && st.counts) return;   // souhrn řešíme níž
      items.forEach(function (it) {
        var d = it.decision || '';
        if (!d) return;
        out.decided++;
        if (d === 'kill') out.killed++;
        else if (d === 'keep') out.kept++;
        else if (d === 'flag') out.flags++;
        else if (d === 'scale') out.scaled++;
        else if (d === 'wait') out.waits++;
      });
    });
    return out;
  }
  function normRun(r) {
    var steps = parseSteps(r.steps || r.steps_json);
    var fin = r.finished_at || (typeof r.finished === 'string' ? r.finished : null);
    var isFin = !!fin || r.finished === true ||
                (steps && (steps.finished === true)) ||
                (stepsArr(steps).some(function (s) { return s.key === 'summary' && s.decision === 'saved'; }));
    var cs = countsFromSteps(steps);
    var sumStep = stepsArr(steps).filter(function (s) { return s.key === 'summary'; })[0];
    var sumCounts = (sumStep && sumStep.counts) || null;
    return {
      id: pickNum(r.id, r.run_id),
      date: String(r.run_date || r.date || '').slice(0, 10),
      who: r.who || r.user || '',
      started_at: r.started_at || r.started || '',
      finished_at: fin,
      finished: !!isFin,
      tab: (steps && steps.tab) || r.tab || '',
      from: (steps && steps.from) || r.from || '',
      to: (steps && steps.to) || r.to || '',
      kills: pickNum(r.kills, r.killed, r.kill_count, sumCounts && sumCounts.killed, cs && cs.killed),
      rejects: pickNum(r.rejected, r.rejects, cs && (cs.kept + cs.flags + cs.waits)),
      accepts: pickNum(r.accepted, r.accepts, cs && (cs.killed + cs.scaled)),
      steps: steps
    };
  }
  function normCalendar(res) {
    var days = {};
    var add = function (r) {
      var run = normRun(r);
      if (!run.date) return;
      (days[run.date] = days[run.date] || []).push(run);
    };
    if (res && Array.isArray(res.days)) {
      res.days.forEach(function (d) {
        var date = String(d.date || d.run_date || d.day || '').slice(0, 10);
        var runs = d.runs || d.items || (d.run ? [d.run] : []);
        if ((!runs || !runs.length) && (d.who || d.id != null)) runs = [d];   // den JE běh
        (runs || []).forEach(function (r) {
          if (!r.run_date && !r.date) r = Object.assign({}, r, { run_date: date });
          add(r);
        });
      });
      return days;
    }
    var list = (res && (res.runs || res.items || res.rows)) || (Array.isArray(res) ? res : []);
    (list || []).forEach(add);
    return days;
  }

  /* ------------------------------------------------------------------ *
   * Načtení měsíce
   * ------------------------------------------------------------------ */
  function monthKey() { return C.y + '-' + pad(C.m + 1); }
  function monthRange() {
    var from = new Date(C.y, C.m, 1);
    var to = new Date(C.y, C.m + 1, 0);
    return { from: ymd(from), to: ymd(to) };
  }
  function load(force) {
    var k = monthKey();
    if (!force && C.cache[k]) { C.days = C.cache[k]; C.loaded = true; render(); return Promise.resolve(); }
    var r = monthRange();
    C.loading = true; C.error = null;
    render();
    return A().api('wizard_calendar', { from: r.from, to: r.to })
      .then(function (res) {
        C.days = normCalendar(res);
        C.cache[k] = C.days;
        C.notWired = false;
        C.loading = false; C.loaded = true;
        render();
      })
      .catch(function (e) {
        /* Endpoint ještě není nasazený → zkus aspoň dnešek přes wizard_today,
           ať kalendář není mrtvý. Poctivě to napíšeme do hlavičky. */
        return A().api('wizard_today').then(function (t) {
          C.days = {};
          if (t && t.run) {
            var run = normRun(Object.assign({ run_date: t.run_date }, t.run));
            if (run.date) C.days[run.date] = [run];
          }
          C.notWired = true;
          C.loading = false; C.loaded = true;
          render();
        }).catch(function () {
          C.loading = false; C.loaded = false;
          C.error = 'Kalendář se nepodařilo načíst' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '.';
          render();
        });
      });
  }

  /* ------------------------------------------------------------------ *
   * Souhrn měsíce
   * ------------------------------------------------------------------ */
  function monthStats() {
    var today = todayStr();
    var last = new Date(C.y, C.m + 1, 0).getDate();
    var doneDays = 0, draftDays = 0, elapsed = 0, kills = 0, rejects = 0;
    var byWho = {};
    for (var d = 1; d <= last; d++) {
      var key = C.y + '-' + pad(C.m + 1) + '-' + pad(d);
      if (key <= today) elapsed++;
      var runs = C.days[key];
      if (!runs || !runs.length) continue;
      var fin = runs.filter(function (r) { return r.finished; });
      if (fin.length) doneDays++; else draftDays++;
      runs.forEach(function (r) {
        if (r.who) byWho[r.who] = (byWho[r.who] || 0) + 1;
        if (r.kills != null) kills += r.kills;
        if (r.rejects != null) rejects += r.rejects;
      });
    }
    var top = Object.keys(byWho).sort(function (a, b) { return byWho[b] - byWho[a]; })[0] || null;
    return {
      doneDays: doneDays, draftDays: draftDays, elapsed: elapsed, lastDay: last,
      kills: kills, rejects: rejects, byWho: byWho, top: top, topN: top ? byWho[top] : 0
    };
  }

  /* ------------------------------------------------------------------ *
   * RENDER
   * ------------------------------------------------------------------ */
  function render() {
    var root = mount();
    if (!root) return;
    injectStyles();

    if (C.error) { root.innerHTML = errorBlock(); wireError(root); return; }

    var st = C.loaded ? monthStats() : null;
    var isEmptyAll = C.loaded && !Object.keys(C.days).length;

    root.innerHTML =
      '<div class="cal-wrap">' +
        '<div class="cal-head">' +
          '<div class="cal-head-txt">' +
            '<h1 class="cal-h1">Kalendář kontrol</h1>' +
            '<p class="cal-lead">Které dny proběhla denní kontrola a kdo ji dělal. ' +
              'Klikni na den → uvidíš, co se rozhodlo a u odmítnutých doporučení i důvod.</p>' +
          '</div>' +
          '<div class="cal-nav">' +
            '<button class="cal-nav-b" id="cal-prev" type="button" aria-label="Předchozí měsíc">‹</button>' +
            '<span class="cal-nav-t">' + esc(MONTHS[C.m]) + ' ' + C.y + '</span>' +
            '<button class="cal-nav-b" id="cal-next" type="button" aria-label="Další měsíc">›</button>' +
            '<button class="cal-btn cal-btn-ghost" id="cal-today" type="button">Dnes</button>' +
          '</div>' +
        '</div>' +
        (C.notWired ? wiredBanner() : '') +
        (st ? summaryHTML(st) : '') +
        (C.loading ? '<div class="cal-card cal-sk"><div class="cal-sk-g"></div></div>' : gridHTML()) +
        legendHTML() +
        (isEmptyAll && !C.loading ? emptyHTML() : '') +
      '</div>';

    wire(root);
  }

  function wiredBanner() {
    return '<div class="cal-banner">' +
      '<span aria-hidden="true">⚠️</span>' +
      '<div><b>Historie zatím není napojená</b> · endpoint <code>wizard_calendar</code> neodpovídá, ' +
      'takže je vidět nanejvýš dnešní běh. Jakmile ho API vrátí, kalendář se naplní sám — ' +
      'data se zapisují do <code>ads_wizard_runs</code> při každé kontrole.</div></div>';
  }

  function summaryHTML(st) {
    var ratio = st.elapsed ? Math.round((st.doneDays / st.elapsed) * 100) : 0;
    var lvl = st.elapsed === 0 ? '' : (ratio >= 80 ? 'good' : (ratio >= 40 ? 'mid' : 'bad'));
    var whoTiles = Object.keys(st.byWho).sort(function (a, b) { return st.byWho[b] - st.byWho[a]; })
      .map(function (w) {
        return '<span class="cal-who-chip"><span class="cal-av">' + esc(initials(w)) + '</span>' +
          esc(w) + ' <b>' + st.byWho[w] + '</b></span>';
      }).join('');

    return '<div class="cal-sum">' +
      '<div class="cal-sum-hero cal-' + lvl + '">' +
        '<div class="cal-sum-big">' + st.doneDays + '<span class="cal-sum-of"> / ' + st.elapsed + '</span></div>' +
        '<div class="cal-sum-lbl">' + plural(st.doneDays, 'den s kontrolou', 'dny s kontrolou', 'dnů s kontrolou') +
          '<span class="cal-sum-note">z ' + st.elapsed + ' ' + plural(st.elapsed, 'dne', 'dnů', 'dnů') +
          ', co už proběhly' + (st.draftDays ? ' · ' + st.draftDays + ' rozpracováno' : '') + '</span></div>' +
      '</div>' +
      '<div class="cal-sum-tiles">' +
        '<div class="cal-tile">' +
          '<span class="cal-tile-l">Kdo kontroloval</span>' +
          '<span class="cal-tile-v">' + (whoTiles || '<span class="cal-dim">zatím nikdo</span>') + '</span>' +
        '</div>' +
        '<div class="cal-tile">' +
          '<span class="cal-tile-l">Killů za měsíc</span>' +
          '<span class="cal-tile-v"><b class="cal-num' + (st.kills > 0 ? ' neg' : '') + '">' + st.kills + '</b></span>' +
        '</div>' +
        '<div class="cal-tile cal-tile-act">' +
          '<span class="cal-tile-l">Odmítnutá doporučení</span>' +
          '<span class="cal-tile-v"><b class="cal-num">' + st.rejects + '</b>' +
            '<button class="cal-btn cal-btn-sm" id="cal-reasons" type="button">Důvody →</button></span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function legendHTML() {
    return '<div class="cal-legend">' +
      '<span class="cal-lg"><i class="cal-dot cal-dot-done"></i> proběhla</span>' +
      '<span class="cal-lg"><i class="cal-dot cal-dot-draft"></i> rozpracovaná</span>' +
      '<span class="cal-lg"><i class="cal-dot cal-dot-none"></i> neproběhla</span>' +
      '<span class="cal-lg"><i class="cal-dot cal-dot-future"></i> ještě nebylo</span>' +
      '<span class="cal-lg-sep"></span>' +
      '<span class="cal-lg cal-dim">číslo v rohu = kolik killů</span>' +
    '</div>';
  }

  function gridHTML() {
    var first = new Date(C.y, C.m, 1);
    var startDow = (first.getDay() + 6) % 7;         // Po = 0
    var last = new Date(C.y, C.m + 1, 0).getDate();
    var today = todayStr();

    var h = '<div class="cal-card"><div class="cal-grid">';
    DOW.forEach(function (d, i) {
      h += '<div class="cal-dow' + (i >= 5 ? ' cal-dow-we' : '') + '">' + d + '</div>';
    });
    for (var i = 0; i < startDow; i++) h += '<div class="cal-cell cal-pad"></div>';

    for (var d = 1; d <= last; d++) {
      var key = C.y + '-' + pad(C.m + 1) + '-' + pad(d);
      var runs = C.days[key] || [];
      var isToday = key === today;
      var future = key > today;
      var dow = (new Date(C.y, C.m, d).getDay() + 6) % 7;
      var we = dow >= 5;

      var state = 'none';
      if (future) state = 'future';
      else if (runs.some(function (r) { return r.finished; })) state = 'done';
      else if (runs.length) state = 'draft';

      var whos = {};
      runs.forEach(function (r) { if (r.who) whos[r.who] = 1; });
      var whoList = Object.keys(whos);
      var kills = runs.reduce(function (a, r) { return a + (r.kills || 0); }, 0);

      h += '<button class="cal-cell cal-s-' + state + (isToday ? ' is-today' : '') + (we ? ' is-we' : '') + '" ' +
             'type="button" data-date="' + key + '"' + (runs.length ? '' : ' data-empty="1"') +
             ' aria-label="' + esc(fmtDateLong(key) + (state === 'done' ? ' — kontrola proběhla' :
                state === 'draft' ? ' — kontrola rozpracovaná' : state === 'none' ? ' — kontrola neproběhla' : '')) + '">' +
        '<span class="cal-d">' + d + '</span>' +
        (kills > 0 ? '<span class="cal-kills" title="' + kills + ' ' + plural(kills, 'kill', 'killy', 'killů') + '">' + kills + '</span>' : '') +
        '<span class="cal-body">' +
          (whoList.length
            ? '<span class="cal-avs">' + whoList.map(function (w) {
                return '<span class="cal-av" title="' + esc(w) + '">' + esc(initials(w)) + '</span>';
              }).join('') + '</span>' +
              '<span class="cal-who-n">' + esc(whoList.join(', ')) + '</span>'
            : (state === 'none' ? '<span class="cal-x" aria-hidden="true">—</span>' : '')) +
        '</span>' +
        (state === 'draft' ? '<span class="cal-tag">rozpracováno</span>' : '') +
        (isToday && state === 'none' ? '<span class="cal-tag cal-tag-cta">spustit</span>' : '') +
      '</button>';
    }
    h += '</div></div>';
    return h;
  }

  function emptyHTML() {
    return '<div class="cal-card cal-empty">' +
      '<div class="cal-empty-ico" aria-hidden="true">🗓️</div>' +
      '<h2 class="cal-empty-h">Zatím žádná kontrola neproběhla</h2>' +
      '<p class="cal-empty-p">V tomhle měsíci nemáme ani jeden zápis. Denní kontrola se ukládá ' +
        'automaticky ve chvíli, kdy projdeš průvodce — pak se tady den obarví zeleně a půjde ' +
        'rozkliknout, co se rozhodlo a proč.</p>' +
      '<button class="cal-btn cal-btn-primary" id="cal-start" type="button">Spustit denní kontrolu</button>' +
    '</div>';
  }

  function errorBlock() {
    return '<div class="cal-wrap"><div class="cal-card cal-empty">' +
      '<div class="cal-empty-ico">⚠️</div>' +
      '<h2 class="cal-empty-h">' + esc(C.error) + '</h2>' +
      '<p class="cal-empty-p">Historie běhů se čte přes <code>?action=wizard_calendar</code>.</p>' +
      '<button id="cal-retry" class="cal-btn cal-btn-primary" type="button">Zkusit znovu</button>' +
    '</div></div>';
  }
  function wireError(root) {
    var b = root.querySelector('#cal-retry');
    if (b) b.addEventListener('click', function () { C.error = null; load(true); });
  }

  /* ------------------------------------------------------------------ *
   * Detail dne / běhu
   * ------------------------------------------------------------------ */
  function openDay(date) {
    var runs = (C.days[date] || []).slice();
    var today = todayStr();

    if (!runs.length) {
      var isToday = date === today;
      var future = date > today;
      var body = '<div class="cal-md">' +
        '<p class="cal-md-lead">' +
          (future ? 'Tenhle den ještě nebyl — kontrola se dělá vždycky za odběhlý den.'
                  : 'Tenhle den <b>neproběhla žádná kontrola</b>. V DB k němu není ani rozpracovaný běh.') +
        '</p>' +
        (isToday ? '<p class="cal-md-note">Dneska ji ještě stihneš — průvodce projde kill kandidáty, ' +
          'funnely, eventy, škálování i nové reklamy a zápis uloží sem.</p>' : '') +
        (!future && !isToday ? '<p class="cal-md-note">Zpětně se kontrola dodělat nedá — průvodce vždy ' +
          'pracuje s aktuálními daty. Prázdný den je prostě prázdný.</p>' : '') +
      '</div>';
      var foot = document.createElement('div');
      foot.className = 'cal-md-foot';
      foot.innerHTML = isToday
        ? '<button class="cal-btn cal-btn-primary" data-a="start">Spustit denní kontrolu</button>'
        : '<button class="cal-btn cal-btn-ghost" data-a="close">Zavřít</button>';
      var close = A()._modal(body, { title: fmtDateLong(date), size: 'sm', foot: foot });
      foot.addEventListener('click', function (e) {
        var b = e.target.closest('[data-a]');
        if (!b) return;
        if (close) close(); else A()._closeModal();
        if (b.getAttribute('data-a') === 'start') startWizard();
      });
      return;
    }

    /* Máme běh(y) → detail. Když chybí steps, dotáhni je přes wizard_run. */
    var box = document.createElement('div');
    box.className = 'cal-md';
    box.innerHTML = '<div class="cal-md-load">Načítám historii běhu…</div>';
    A()._modal(box, { title: 'Kontrola ' + fmtDateLong(date) });

    Promise.all(runs.map(function (r) {
      if (r.steps) return Promise.resolve(r);
      if (r.id == null) return Promise.resolve(r);
      return A().api('wizard_run', { id: r.id }).then(function (res) {
        var raw = (res && (res.run || res.item || res)) || {};
        var merged = normRun(Object.assign({ run_date: date }, raw));
        /* Server je autorita, ale co nepošle, doplň z kalendáře */
        merged.who = merged.who || r.who;
        merged.started_at = merged.started_at || r.started_at;
        merged.finished_at = merged.finished_at || r.finished_at;
        if (merged.kills == null) merged.kills = r.kills;
        return merged;
      }).catch(function () { return r; });
    })).then(function (full) {
      box.innerHTML = full.map(runDetailHTML).join('<hr class="cal-md-hr">');
    });
  }

  function runDetailHTML(r) {
    var head = '<div class="cal-run-h">' +
      '<span class="cal-av cal-av-lg">' + esc(initials(r.who)) + '</span>' +
      '<div class="cal-run-hx">' +
        '<b>' + esc(r.who || 'neznámo kdo') + '</b>' +
        '<span class="cal-run-meta">' +
          (r.started_at ? fmtTime(r.started_at) : '') +
          (r.finished_at ? '–' + fmtTime(r.finished_at) : '') +
          (durationTxt(r.started_at, r.finished_at) ? ' · ' + durationTxt(r.started_at, r.finished_at) : '') +
          (r.from && r.to ? ' · období ' + fmtDate(r.from) + ' – ' + fmtDate(r.to) : '') +
          ''  + 
        '</span>' +
      '</div>' +
      '<span class="cal-chip ' + (r.finished ? 'cal-chip-ok' : 'cal-chip-draft') + '">' +
        (r.finished ? 'dokončeno' : 'rozpracováno') + '</span>' +
    '</div>';

    var arr = stepsArr(r.steps);
    if (!arr.length) {
      return head + '<p class="cal-md-note">K tomuhle běhu se nepodařilo načíst rozhodnutí ' +
        '(chybí <code>steps_json</code>).</p>';
    }

    /* Souhrnné počty */
    var cs = countsFromSteps(r.steps) || { killed: 0, kept: 0, flags: 0, scaled: 0, waits: 0 };
    var rejects = cs.kept + cs.flags + cs.waits;
    var stats = '<div class="cal-run-stats">' +
      statChip('🔴', cs.killed, plural(cs.killed, 'kill', 'killy', 'killů'), cs.killed ? 'neg' : '') +
      statChip('✅', cs.killed + cs.scaled, 'přijato', '') +
      statChip('❌', rejects, 'odmítnuto', rejects ? 'warn' : '') +
      statChip('🟢', cs.scaled, 'ke škále', cs.scaled ? 'pos' : '') +
    '</div>';

    var body = arr.map(stepHTML).filter(Boolean).join('');
    return head + stats + body;
  }
  function statChip(ico, n, lbl, cls) {
    return '<span class="cal-stat ' + (cls || '') + '"><span aria-hidden="true">' + ico + '</span>' +
      '<b>' + n + '</b> ' + esc(lbl) + '</span>';
  }

  var STEP_META = {
    kill: ['🔴', 'Kill kandidáti'],
    funnels: ['🔻', 'Funnely'],
    events: ['🎯', 'Eventy / optimalizace'],
    scale: ['🟢', 'Škálování'],
    newest: ['🆕', 'Nové reklamy'],
    summary: ['✅', 'Souhrn']
  };
  var KEEP_REASON = { mlada: 'Mladá (málo dat)', cekam: 'Čekám na data', strategicka: 'Strategická', jine: 'Jiné' };
  var LAYER = { 1: 'Spend bez leadů', 2: 'Tichý žrout', 3: 'Extrém CPL', 4: 'Zralá ROAS<1' };

  function stepHTML(st) {
    var meta = STEP_META[st.key] || ['•', st.key];
    var items = (st.items || []).filter(function (it) { return it.decision; });

    if (st.key === 'summary') {
      var c = st.counts || {};
      if (!c || (!c.killed && !c.kept && !c.flags && !c.scale)) return '';
      return '<section class="cal-step"><h4 class="cal-step-h">' + meta[0] + ' ' + meta[1] + '</h4>' +
        '<p class="cal-step-sum">Zabito <b>' + num(c.killed) + '</b> · ponecháno <b>' + num(c.kept) + '</b> · ' +
        'flagů <b>' + num(c.flags) + '</b> · ke škále <b>' + num(c.scale) + '</b></p></section>';
    }
    if (!items.length) return '';

    var rows = items.map(function (it) {
      var name = it.creative || it.funnel || it.event || '—';
      var d = it.decision;
      var accepted = (d === 'kill' || d === 'scale' || d === 'ok');
      var lbl = { kill: 'Zabito', keep: 'Ponecháno', ok: 'Potvrzeno', flag: 'Flag', scale: 'Škálovat', wait: 'Počkat' }[d] || d;
      var reason = '';
      if (d === 'keep') {
        var code = it.reason && KEEP_REASON[it.reason] ? KEEP_REASON[it.reason] : (it.reason || '');
        reason = [code, it.note].filter(Boolean).join(' — ');
      } else if (d === 'flag' || d === 'wait') {
        reason = it.note || '';
      }
      var meta2 = [];
      if (it.kill_layer) meta2.push('vrstva ' + it.kill_layer + (LAYER[it.kill_layer] ? ' · ' + LAYER[it.kill_layer] : ''));
      if (it.funnel && it.creative) meta2.push(it.funnel);
      if (it.spend != null && it.spend !== '') meta2.push((A().fmt ? A().fmt.money(it.spend) : it.spend + ' Kč'));
      if (it.roas_model != null && it.roas_model !== '') meta2.push('ROAS model ' + (A().fmt ? A().fmt.roas(it.roas_model) : it.roas_model));
      if (it.bookings != null && it.bookings !== '' && it.creative && st.key === 'scale') meta2.push(num(it.bookings) + ' schůzek');

      return '<li class="cal-row' + (accepted ? '' : ' is-rej') + '">' +
        '<span class="cal-row-dec ' + (accepted ? 'ok' : 'rej') + '">' + (accepted ? '✓' : '✕') + ' ' + esc(lbl) + '</span>' +
        '<div class="cal-row-x">' +
          '<span class="cal-row-n">' + esc(name) + '</span>' +
          (meta2.length ? '<span class="cal-row-m">' + esc(meta2.join(' · ')) + '</span>' : '') +
          (reason ? '<span class="cal-row-r"><b>Důvod:</b> ' + esc(reason) + '</span>'
                  : (!accepted ? '<span class="cal-row-r cal-row-r-miss">Důvod chybí</span>' : '')) +
        '</div>' +
      '</li>';
    }).join('');

    var rejN = items.filter(function (it) { return ['keep', 'flag', 'wait'].indexOf(it.decision) > -1; }).length;
    return '<section class="cal-step">' +
      '<h4 class="cal-step-h">' + meta[0] + ' ' + meta[1] +
        '<span class="cal-step-n">' + items.length + '</span>' +
        (rejN ? '<span class="cal-step-rej">' + rejN + ' odmítnuto</span>' : '') +
      '</h4>' +
      '<ul class="cal-rows">' + rows + '</ul>' +
    '</section>';
  }

  /* ------------------------------------------------------------------ *
   * Agregace důvodů odmítnutí (podklad pro ladění nuancí pravidel)
   * ------------------------------------------------------------------ */
  var RULE_LABEL = {
    spend_no_lead: 'Spend bez leadů (vrstva 1)',
    tichy_zrout: 'Tichý žrout (vrstva 2)',
    cpl_extreme: 'Extrém CPL (vrstva 3)',
    mature_roas: 'Zralá ROAS pod break-even (vrstva 4)',
    scale_ready: 'Připraveno ke škálování',
    anomaly: 'Anomálie funnelu/eventu',
    '(bez pravidla)': 'Bez pravidla (přehledové kroky)'
  };
  function openReasons() {
    var box = document.createElement('div');
    box.className = 'cal-md';
    box.innerHTML = '<div class="cal-md-load">Načítám důvody…</div>';
    A()._modal(box, { title: 'Důvody odmítnutí — podklad pro ladění pravidel' });

    A().api('feedback_log', { days: 90 }).then(function (res) {
      var rules = (res && res.by_rule) || [];
      if (!rules.length) {
        box.innerHTML = '<div class="cal-empty cal-empty-in">' +
          '<div class="cal-empty-ico" aria-hidden="true">💬</div>' +
          '<h2 class="cal-empty-h">Zatím není co ladit</h2>' +
          '<p class="cal-empty-p">Za posledních 90 dní neproběhlo ani jedno rozhodnutí. ' +
          'Jakmile budeš v průvodci odmítat doporučení a psát důvody, sesypou se sem — ' +
          'a z toho se pak přidávají <b>nuance</b> do pravidel (přidávají se, nepřepisují).</p></div>';
        return;
      }
      var total = num(res.total, 0);
      box.innerHTML =
        '<p class="cal-md-lead">Za posledních 90 dní padlo <b>' + total + '</b> ' +
          plural(total, 'rozhodnutí', 'rozhodnutí', 'rozhodnutí') + '. ' +
          'Vysoký podíl odmítnutí u jednoho pravidla = pravidlo je špatně nastavené (nebo mu chybí nuance).</p>' +
        rules.map(function (r) {
          var rate = Math.round(num(r.reject_rate) * 100);
          var lvl = rate >= 50 ? 'bad' : (rate >= 25 ? 'mid' : 'good');
          var reasons = (r.reasons || []).slice(0, 8).map(function (x) {
            return '<li class="cal-rea"><span class="cal-rea-t">' + esc(x.target || '') + '</span>' +
              '<span class="cal-rea-r">' + esc(x.reason || '(bez textu)') + '</span>' +
              '<span class="cal-rea-w">' + esc(x.who || '') + ' · ' + esc(fmtDate(x.ts)) + '</span></li>';
          }).join('');
          return '<section class="cal-rule">' +
            '<div class="cal-rule-h">' +
              '<b>' + esc(RULE_LABEL[r.rule] || r.rule) + '</b>' +
              '<span class="cal-rule-n">' + num(r.rejected) + ' z ' + num(r.total) + ' odmítnuto</span>' +
              '<span class="cal-rule-rate cal-' + lvl + '">' + rate + ' %</span>' +
            '</div>' +
            '<div class="cal-bar"><span class="cal-bar-f cal-' + lvl + '" style="width:' + Math.max(2, rate) + '%"></span></div>' +
            (reasons ? '<ul class="cal-reas">' + reasons + '</ul>' : '') +
            ((r.reasons || []).length > 8 ? '<p class="cal-md-note">…a dalších ' + ((r.reasons || []).length - 8) + '</p>' : '') +
          '</section>';
        }).join('');
    }).catch(function (e) {
      box.innerHTML = '<p class="cal-md-note">Důvody se nepodařilo načíst' +
        (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '.</p>';
    });
  }

  /* ------------------------------------------------------------------ *
   * Akce
   * ------------------------------------------------------------------ */
  function startWizard() {
    try { A()._closeModal && A()._closeModal(); } catch (_) {}
    if (window.ADSWizard && window.ADSWizard.open) { window.ADSWizard.open(); return; }
    try { A()._emit && A()._emit('wizardopen', {}); return; } catch (_) {}
    toast('Průvodce se nepodařilo otevřít', 'error');
  }

  function shiftMonth(d) {
    var m = C.m + d, y = C.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    C.m = m; C.y = y;
    C.loaded = false;
    load();
  }

  function wire(root) {
    var p = root.querySelector('#cal-prev'); if (p) p.addEventListener('click', function () { shiftMonth(-1); });
    var n = root.querySelector('#cal-next'); if (n) n.addEventListener('click', function () { shiftMonth(1); });
    var t = root.querySelector('#cal-today');
    if (t) t.addEventListener('click', function () {
      var d = new Date();
      C.y = d.getFullYear(); C.m = d.getMonth(); C.loaded = false; load();
    });
    var rs = root.querySelector('#cal-reasons'); if (rs) rs.addEventListener('click', openReasons);
    var sw = root.querySelector('#cal-start'); if (sw) sw.addEventListener('click', startWizard);

    root.addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('.cal-cell[data-date]') : null;
      if (c) openDay(c.getAttribute('data-date'));
    });
  }

  /* Po dokončení wizardu překresli (dnešek zezelená bez F5). */
  try {
    A().bus && A().bus.addEventListener('wizardclose', function () {
      C.cache = {}; C.loaded = false;
      if (isVisible()) load(true);
    });
  } catch (_) {}

  /* ------------------------------------------------------------------ *
   * ROUTING (shell: ADS.route + 'routechange')
   * ------------------------------------------------------------------ */
  function routeOf(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'function') { try { return routeOf(x()); } catch (_) { return ''; } }
    if (typeof x === 'object') return String(x.route || x.name || x.current || x.id || x.view || '');
    return String(x);
  }
  function currentRoute() { return routeOf(A().route); }
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
    if (!m || m.hidden) return false;
    return !!(m.offsetParent || m.getClientRects().length);
  }
  function maybeRender() {
    var m = mount();
    if (!m) return;
    var r = currentRoute();
    var wanted = r ? isMine(r) : isVisible();
    if (!wanted) return;
    if (!C.loaded && !C.loading) load();
    else render();
  }
  function onRouteEvt(e) {
    var r = routeOf(e && e.detail) || currentRoute();
    if (r && !isMine(r)) return;
    setTimeout(maybeRender, 0);
  }
  /* Zabrat mount → shell do něj nekreslí placeholder (app.js routePlaceholder). */
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

  window.ADSCalendar = {
    render: maybeRender,
    reload: function () { C.cache = {}; C.loaded = false; return load(true); },
    openDay: openDay,
    openReasons: openReasons
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ------------------------------------------------------------------ *
   * STYLY (scoped .cal-)
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById('cal-styles')) return;
    var css = `
.cal-wrap{max-width:1080px;margin:0 auto;padding:var(--s-5,20px) 0 60px;}
.cal-head{display:flex;align-items:flex-end;gap:var(--s-5,20px);flex-wrap:wrap;margin-bottom:var(--s-5,20px);}
.cal-head-txt{flex:1;min-width:260px;}
.cal-h1{font-size:24px;font-weight:740;letter-spacing:-.02em;margin:0 0 6px;color:var(--text,#23262e);}
.cal-lead{margin:0;font-size:13.5px;line-height:1.55;color:var(--text-2,#5c6070);max-width:70ch;}
.cal-dim{color:var(--text-3,#8b8f9e);}

/* --- nav --- */
.cal-nav{display:flex;align-items:center;gap:6px;}
.cal-nav-b{width:32px;height:32px;border-radius:var(--r-sm,9px);border:1px solid var(--border,#e7e4dc);background:var(--surface,#fff);
  color:var(--text-2,#5c6070);font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:background .14s,border-color .14s,color .14s;}
.cal-nav-b:hover{background:var(--surface-2,#faf9f6);border-color:var(--border-strong,#d7d3c8);color:var(--text,#23262e);}
.cal-nav-b:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.cal-nav-t{min-width:150px;text-align:center;font-size:14.5px;font-weight:700;color:var(--text,#23262e);text-transform:capitalize;}

/* --- tlačítka --- */
.cal-btn{height:32px;padding:0 13px;border-radius:var(--r-sm,9px);border:1px solid var(--border,#e7e4dc);
  background:var(--surface,#fff);color:var(--text,#23262e);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;transition:background .14s,border-color .14s,box-shadow .14s,transform .06s;}
.cal-btn:hover{background:var(--surface-2,#faf9f6);border-color:var(--border-strong,#d7d3c8);}
.cal-btn:active{transform:translateY(1px);}
.cal-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);border-color:var(--border-focus,#b9bff0);}
.cal-btn-primary{background:var(--accent,#4b58c9);border-color:var(--accent,#4b58c9);color:#fff;}
.cal-btn-primary:hover{background:var(--accent-600,#3f4bb4);border-color:var(--accent-600,#3f4bb4);box-shadow:var(--shadow-sm,0 1px 3px rgba(0,0,0,.07));}
.cal-btn-ghost{background:transparent;border-color:transparent;color:var(--text-2,#5c6070);}
.cal-btn-ghost:hover{background:var(--surface-3,#f2f0ea);}
.cal-btn-sm{height:26px;padding:0 9px;font-size:11.5px;}

/* --- souhrn --- */
.cal-sum{display:flex;gap:var(--s-3,12px);flex-wrap:wrap;margin-bottom:var(--s-4,16px);}
.cal-sum-hero{flex:none;min-width:210px;display:flex;flex-direction:column;justify-content:center;gap:2px;
  background:var(--surface,#fff);border:1px solid var(--border,#e7e4dc);border-left:3px solid var(--text-3,#8b8f9e);
  border-radius:var(--r-md,13px);padding:14px 18px;box-shadow:var(--shadow-xs,0 1px 2px rgba(30,28,24,.05));}
.cal-sum-hero.cal-good{border-left-color:var(--green,#1f9d63);}
.cal-sum-hero.cal-mid{border-left-color:var(--yellow,#c99a2e);}
.cal-sum-hero.cal-bad{border-left-color:var(--red,#d3453f);}
.cal-sum-big{font-size:30px;font-weight:760;letter-spacing:-.02em;color:var(--text,#23262e);line-height:1.05;font-variant-numeric:tabular-nums;}
.cal-sum-of{font-size:17px;font-weight:600;color:var(--text-3,#8b8f9e);}
.cal-sum-lbl{font-size:12.5px;font-weight:650;color:var(--text-2,#5c6070);}
.cal-sum-note{display:block;font-size:11px;font-weight:400;color:var(--text-3,#8b8f9e);margin-top:2px;}
.cal-sum-tiles{flex:1;display:flex;gap:var(--s-3,12px);flex-wrap:wrap;}
.cal-tile{flex:1;min-width:170px;background:var(--surface,#fff);border:1px solid var(--border,#e7e4dc);border-radius:var(--r-md,13px);
  padding:12px 14px;display:flex;flex-direction:column;gap:7px;box-shadow:var(--shadow-xs,0 1px 2px rgba(30,28,24,.05));}
.cal-tile-l{font-size:11px;font-weight:700;color:var(--text-3,#8b8f9e);text-transform:uppercase;letter-spacing:.03em;}
.cal-tile-v{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2,#5c6070);}
.cal-num{font-size:19px;font-weight:740;color:var(--text,#23262e);font-variant-numeric:tabular-nums;}
.cal-num.neg{color:var(--red,#d3453f);}
.cal-tile-act .cal-tile-v{justify-content:space-between;}
.cal-who-chip{display:inline-flex;align-items:center;gap:5px;background:var(--surface-3,#f2f0ea);border-radius:var(--r-pill,999px);
  padding:2px 9px 2px 2px;font-size:12px;color:var(--text-2,#5c6070);}
.cal-who-chip b{color:var(--text,#23262e);}

/* --- avatar --- */
.cal-av{width:19px;height:19px;border-radius:50%;background:var(--accent,#4b58c9);color:#fff;font-size:10px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none;letter-spacing:0;}
.cal-av-lg{width:30px;height:30px;font-size:13px;}
.cal-avs{display:flex;gap:2px;}
.cal-avs .cal-av:nth-child(2){background:var(--info,#3d7bd0);}
.cal-avs .cal-av:nth-child(3){background:var(--yellow,#c99a2e);}

/* --- karta + mřížka --- */
.cal-card{background:var(--surface,#fff);border:1px solid var(--border,#e7e4dc);border-radius:var(--r-md,13px);
  box-shadow:var(--shadow-xs,0 1px 2px rgba(30,28,24,.05));padding:14px;margin-bottom:var(--s-3,12px);}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;}
.cal-dow{font-size:11px;font-weight:700;color:var(--text-3,#8b8f9e);text-transform:uppercase;letter-spacing:.04em;
  text-align:center;padding:2px 0 6px;}
.cal-dow-we{color:var(--text-3,#b6b2a8);}
.cal-cell{position:relative;min-height:86px;border-radius:var(--r-sm,9px);border:1px solid var(--border,#e7e4dc);
  background:var(--surface-2,#faf9f6);padding:7px 8px;text-align:left;font:inherit;cursor:pointer;overflow:hidden;
  display:flex;flex-direction:column;gap:4px;transition:transform .1s,box-shadow .14s,border-color .14s,background .14s;}
.cal-cell:hover{transform:translateY(-1px);box-shadow:var(--shadow-sm,0 1px 3px rgba(30,28,24,.07));border-color:var(--border-strong,#d7d3c8);}
.cal-cell:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-weak,#eceefb);}
.cal-cell.cal-pad{background:transparent;border:0;cursor:default;min-height:0;pointer-events:none;}
/* ⚠️ Víkend ZÁMĚRNĚ nemá vlastní podbarvení. Mělo ho a vypadalo to rozbitě: budoucí
   víkend (18./19.) se tvářil jako „neproběhla", protože .cal-cell.is-we (0,2,0) přebilo
   .cal-s-future (0,1,0). Hlavně to byl stav navíc, který legenda nevysvětluje — a Filip
   pak hádá, co ta barva znamená. Víkend pozná z hlavičky (SO/NE je ztlumené).
   Každý vzhled buňky = přesně jedna položka legendy. */
.cal-d{font-size:12.5px;font-weight:700;color:var(--text-2,#5c6070);font-variant-numeric:tabular-nums;}
.cal-body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0;}
.cal-who-n{font-size:10.5px;color:var(--text-2,#5c6070);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cal-x{font-size:13px;color:var(--border-strong,#d7d3c8);}
.cal-kills{position:absolute;top:5px;right:6px;min-width:17px;height:17px;padding:0 4px;border-radius:var(--r-pill,999px);
  background:var(--red-bg,#fbe6e4);color:#a8322c;border:1px solid var(--red-bd,#f2c1bd);font-size:10px;font-weight:750;
  display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;}
.cal-tag{align-self:flex-start;font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:var(--r-pill,999px);
  background:var(--yellow-bg,#fbf3dd);color:#8a6816;border:1px solid var(--yellow-bd,#eeddab);text-transform:uppercase;letter-spacing:.02em;}
.cal-tag-cta{background:var(--accent-weak,#eceefb);color:var(--accent-700,#3a45a0);border-color:var(--accent-weak-2,#d7dbf7);}

.cal-s-done{background:var(--green-bg,#e4f5ec);border-color:var(--green-bd,#bfe6d1);}
.cal-s-done .cal-d{color:#1c6b47;}
.cal-s-draft{background:var(--yellow-bg,#fbf3dd);border-color:var(--yellow-bd,#eeddab);}
.cal-s-draft .cal-d{color:#8a6816;}
.cal-s-none{background:var(--surface-2,#faf9f6);}
.cal-s-future{background:transparent;border-style:dashed;border-color:var(--border,#e7e4dc);cursor:default;}
.cal-s-future .cal-d{color:var(--text-3,#c3c0b6);}
.cal-s-future:hover{transform:none;box-shadow:none;}
.cal-cell.is-today{border-color:var(--accent,#4b58c9);box-shadow:0 0 0 2px var(--accent-weak,#eceefb);}
.cal-cell.is-today .cal-d{color:var(--accent-700,#3a45a0);}

/* --- legenda --- */
.cal-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:2px 4px 0;font-size:11.5px;color:var(--text-2,#5c6070);}
.cal-lg{display:inline-flex;align-items:center;gap:5px;}
.cal-lg-sep{width:1px;height:12px;background:var(--border,#e7e4dc);}
.cal-dot{width:10px;height:10px;border-radius:3px;border:1px solid var(--border-strong,#d7d3c8);display:inline-block;}
.cal-dot-done{background:var(--green-bg,#e4f5ec);border-color:var(--green-bd,#bfe6d1);}
.cal-dot-draft{background:var(--yellow-bg,#fbf3dd);border-color:var(--yellow-bd,#eeddab);}
.cal-dot-none{background:var(--surface-2,#faf9f6);}
.cal-dot-future{background:transparent;border-style:dashed;}

/* --- banner / prázdno --- */
.cal-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border-radius:var(--r-sm,9px);font-size:12.5px;
  line-height:1.5;margin-bottom:var(--s-4,16px);background:var(--yellow-bg,#fbf3dd);border:1px solid var(--yellow-bd,#eeddab);color:#75570f;}
.cal-banner code{font-family:var(--mono,monospace);font-size:11px;background:rgba(0,0,0,.05);padding:1px 4px;border-radius:3px;}
.cal-empty{padding:40px 24px;text-align:center;}
.cal-empty-in{padding:24px 8px;}
.cal-empty-ico{font-size:30px;opacity:.65;}
.cal-empty-h{margin:10px 0 6px;font-size:16px;font-weight:700;color:var(--text,#23262e);}
.cal-empty-p{margin:0 auto 14px;font-size:13px;line-height:1.6;color:var(--text-2,#5c6070);max-width:56ch;}
@keyframes cal-pulse{0%,100%{opacity:.5}50%{opacity:.25}}
.cal-sk-g{height:420px;border-radius:var(--r-sm,9px);background:var(--surface-3,#f2f0ea);animation:cal-pulse 1.3s ease-in-out infinite;}

/* --- modal obsah --- */
.cal-md{font-size:13px;color:var(--text,#23262e);}
.cal-md-load{padding:22px;text-align:center;color:var(--text-3,#8b8f9e);font-size:13px;}
.cal-md-lead{margin:0 0 12px;font-size:13.5px;line-height:1.6;color:var(--text-2,#5c6070);}
.cal-md-note{margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--text-3,#8b8f9e);}
.cal-md-note code,.cal-md code{font-family:var(--mono,monospace);font-size:11px;background:var(--surface-3,#f2f0ea);padding:1px 4px;border-radius:3px;}
.cal-md-foot{display:flex;gap:8px;justify-content:flex-end;width:100%;}
.cal-md-hr{border:0;border-top:1px solid var(--border,#e7e4dc);margin:18px 0;}
.cal-run-h{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.cal-run-hx{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cal-run-hx b{font-size:14px;}
.cal-run-meta{font-size:11.5px;color:var(--text-3,#8b8f9e);}
.cal-chip{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:var(--r-pill,999px);border:1px solid transparent;}
.cal-chip-ok{background:var(--green-bg,#e4f5ec);color:#1c6b47;border-color:var(--green-bd,#bfe6d1);}
.cal-chip-draft{background:var(--yellow-bg,#fbf3dd);color:#8a6816;border-color:var(--yellow-bd,#eeddab);}
.cal-run-stats{display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px;background:var(--surface-2,#faf9f6);
  border:1px solid var(--border,#e7e4dc);border-radius:var(--r-sm,9px);margin-bottom:14px;}
.cal-stat{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2,#5c6070);}
.cal-stat b{font-size:14px;font-weight:740;color:var(--text,#23262e);font-variant-numeric:tabular-nums;}
.cal-stat.neg b{color:var(--red,#d3453f);}
.cal-stat.pos b{color:var(--green,#1f9d63);}
.cal-stat.warn b{color:var(--yellow,#c99a2e);}

.cal-step{margin-bottom:16px;}
.cal-step-h{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:700;color:var(--text,#23262e);}
.cal-step-n{min-width:18px;height:18px;padding:0 5px;border-radius:var(--r-pill,999px);background:var(--surface-3,#f2f0ea);
  color:var(--text-3,#8b8f9e);font-size:10.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;}
.cal-step-rej{font-size:10.5px;font-weight:700;color:#a8322c;background:var(--red-bg,#fbe6e4);border:1px solid var(--red-bd,#f2c1bd);
  padding:1px 6px;border-radius:var(--r-pill,999px);}
.cal-step-sum{margin:0;font-size:12.5px;color:var(--text-2,#5c6070);}
.cal-step-sum b{color:var(--text,#23262e);}
.cal-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}
.cal-row{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:var(--r-sm,9px);
  background:var(--surface-2,#faf9f6);border:1px solid var(--border,#e7e4dc);}
.cal-row.is-rej{background:var(--surface,#fff);border-left:3px solid var(--yellow,#c99a2e);}
.cal-row-dec{flex:none;font-size:11px;font-weight:700;padding:2px 7px;border-radius:var(--r-pill,999px);white-space:nowrap;}
.cal-row-dec.ok{background:var(--green-bg,#e4f5ec);color:#1c6b47;}
.cal-row-dec.rej{background:var(--yellow-bg,#fbf3dd);color:#8a6816;}
.cal-row-x{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.cal-row-n{font-size:12.5px;font-weight:650;color:var(--text,#23262e);font-family:var(--mono,monospace);}
.cal-row-m{font-size:11px;color:var(--text-3,#8b8f9e);}
.cal-row-r{font-size:12px;color:var(--text-2,#5c6070);line-height:1.5;margin-top:2px;}
.cal-row-r b{color:var(--text,#23262e);}
.cal-row-r-miss{color:var(--red,#d3453f);font-style:italic;}

.cal-rule{margin-bottom:16px;}
.cal-rule-h{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;}
.cal-rule-h b{flex:1;min-width:0;color:var(--text,#23262e);}
.cal-rule-n{font-size:11.5px;color:var(--text-3,#8b8f9e);white-space:nowrap;}
.cal-rule-rate{font-size:12px;font-weight:750;font-variant-numeric:tabular-nums;}
.cal-rule-rate.cal-good{color:var(--green,#1f9d63);}
.cal-rule-rate.cal-mid{color:var(--yellow,#c99a2e);}
.cal-rule-rate.cal-bad{color:var(--red,#d3453f);}
.cal-bar{height:6px;border-radius:var(--r-pill,999px);background:var(--surface-3,#f2f0ea);overflow:hidden;}
.cal-bar-f{display:block;height:100%;border-radius:var(--r-pill,999px);background:var(--text-3,#8b8f9e);}
.cal-bar-f.cal-good{background:var(--green,#1f9d63);}
.cal-bar-f.cal-mid{background:var(--yellow,#c99a2e);}
.cal-bar-f.cal-bad{background:var(--red,#d3453f);}
.cal-reas{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;}
.cal-rea{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:6px 9px;background:var(--surface-2,#faf9f6);
  border-radius:var(--r-xs,6px);border:1px solid var(--border,#e7e4dc);}
.cal-rea-t{flex:none;font-family:var(--mono,monospace);font-size:11px;color:var(--text-3,#8b8f9e);max-width:120px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cal-rea-r{flex:1;min-width:0;color:var(--text,#23262e);}
.cal-rea-w{flex:none;font-size:10.5px;color:var(--text-3,#8b8f9e);white-space:nowrap;}

@media (max-width:820px){
  .cal-cell{min-height:64px;padding:5px;}
  .cal-who-n{display:none;}
  .cal-sum-hero{flex:1;}
}
`;
    var st = document.createElement('style');
    st.id = 'cal-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }
})();
