/* ============================================================================
 * AI ASISTENT — chat panel nad daty dashboardu.  (FEEDBACK-6 §A)
 * ============================================================================
 * Filip: „já tam budu mít někde ikonku takovou v tom nastavení nebo nad tou ikonkou vlevo,
 * jak je to F, a já jí napíšu nějakou otázku… Bude pracovat s celým tím kontextem, takže mi
 * vysvětlí jak funguje jakákoli funkce, ale zároveň mi dá kontext… Bude to takový jako
 * pomocník kterej tam vytvoříme." · „bude velmi užitečný pro Vojtu, kterej nebude kolikrát
 * vědět, jak se v těch datech vyznat."
 *
 * PROČ PANEL A NE ROUTA: asistent má být po ruce U DAT — Filip se ptá na to, na co zrovna
 * kouká. Samostatná stránka by ho nutila odejít z dashboardu a ztratit kontext.
 * Proto drawer zprava: data zůstanou vidět vlevo.
 *
 * Klíč k Gemini NENÍ a nikdy nebude tady — všechno jde přes `api.php?action=ai_chat`,
 * který drží klíč v config.php mimo docroot.
 *
 * Závislosti: ADS.api · ADS.toast · ADS.bus
 * ============================================================================ */
(function () {
  'use strict';
  var ADS = window.ADS;
  if (!ADS) return;

  var S = {
    open: false,
    busy: false,
    unread: 0,         // počet nepřečtených odpovědí, když je chat zavřený → badge na bublině
    msgs: [],          // [{role:'user'|'model', text, tools?, proposals?}]
    els: {}
  };

  var LS_KEY = 'ads.ai.thread.v1';

  /* Historie žije v sessionStorage schválně: je to pracovní konverzace nad AKTUÁLNÍMI daty,
   * ne archiv. Po zavření prohlížeče čísla stejně zestarají a stará odpověď by lhala. */
  function loadThread() {
    try { S.msgs = JSON.parse(sessionStorage.getItem(LS_KEY) || '[]') || []; }
    catch (_) { S.msgs = []; }
  }
  function saveThread() {
    try { sessionStorage.setItem(LS_KEY, JSON.stringify(S.msgs.slice(-40))); } catch (_) { }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Mini-markdown. Vlastní schválně: kvůli **tučnému** a odrážkám netahám knihovnu.
   * Escapuje se PRVNÍ, takže z odpovědi modelu nemůže vypadnout HTML. */
  function md(t) {
    var s = esc(t);
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) { return '<pre class="ai-pre">' + c.trim() + '</pre>'; });
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Nadpisy — model je používá („### Jak tomu předcházet?"). Bez tohohle se v odpovědi
    // objeví holé „###" (chyceno naostro 17. 7. při testu v prohlížeči).
    s = s.replace(/(^|\n)#{1,6}\s*(.+)/g, '$1<div class="ai-h3">$2</div>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // Číslované odrážky („1. Dělejte denní check") — model je používá stejně často jako pomlčky.
    s = s.replace(/(^|\n)\s*\d+\.\s+(.+)/g, '$1<li class="ai-li-n">$2</li>');
    s = s.replace(/(^|\n)\s*[-*]\s+(.+)/g, '$1<li>$2</li>');
    s = s.replace(/(<li[^>]*>[\s\S]*?<\/li>)(?!\s*<li)/g, '<ul>$1</ul>');
    s = s.replace(/\n{2,}/g, '</p><p>');
    s = s.replace(/\n/g, '<br>');
    return '<p>' + s + '</p>';
  }

  var TOOL_CZ = {
    get_overview: 'souhrn účtu',
    get_creatives: 'seznam kreativ',
    get_weekly: 'týdenní vývoj',
    get_trend: 'vývoj per funnel',
    get_settings: 'nastavení',
    propose_setting_change: 'návrh změny nastavení'
  };

  /* Filip je datově kritický („čte data kriticky, očekává průkaznost") → musí být vidět,
   * ODKUD to AI má. Bez tohohle je to jen hezky mluvící krabička. */
  function toolsHTML(tools) {
    if (!tools || !tools.length) return '';
    var names = tools.map(function (t) {
      var a = t.args || {};
      var d = [];
      if (a.segment) d.push(a.segment);
      /* NK má jednu kategorii, tab se do popisu nepřidává. */
      if (a.days) d.push(a.days + ' d');
      return (TOOL_CZ[t.name] || t.name) + (d.length ? ' (' + d.join(', ') + ')' : '');
    });
    return '<div class="ai-tools" title="Data, ze kterých asistent odpovídal">📊 ' +
           esc(names.join(' · ')) + '</div>';
  }

  /* Návrh změny nastavení → karta s Potvrdit. Filip: „ona se zeptá jestli určitě, dá mi
   * tlačítko potvrdit, já dám potvrdit a tím se to potvrdí." AI sama NIKDY nezapisuje. */
  function proposalHTML(p, i) {
    var unit = p.unit ? ' ' + esc(p.unit) : '';
    return '<div class="ai-prop" data-prop="' + i + '">' +
      '<div class="ai-prop-h">Návrh změny nastavení</div>' +
      '<div class="ai-prop-b"><b>' + esc(p.label || p.key) + '</b><br>' +
        '<span class="ai-prop-old">' + esc(p.old) + unit + '</span>' +
        '<span class="ai-prop-arr">→</span>' +
        '<span class="ai-prop-new">' + esc(p.new) + unit + '</span>' +
      '</div>' +
      (p.reason ? '<div class="ai-prop-why">' + esc(p.reason) + '</div>' : '') +
      '<div class="ai-prop-a">' +
        '<button type="button" class="btn btn-primary ai-ok" data-prop="' + i + '">Potvrdit</button>' +
        '<button type="button" class="btn btn-ghost ai-no" data-prop="' + i + '">Zrušit</button>' +
      '</div>' +
    '</div>';
  }

  function msgHTML(m, idx) {
    if (m.role === 'user') {
      return '<div class="ai-m ai-me"><div class="ai-b">' + esc(m.text) + '</div></div>';
    }
    var props = (m.proposals || []).map(function (p, i) { return proposalHTML(p, idx + '_' + i); }).join('');
    return '<div class="ai-m ai-ai">' +
      toolsHTML(m.tools) +
      '<div class="ai-b">' + md(m.text) + '</div>' + props +
    '</div>';
  }

  var TIPS = [
    'Jaké reklamy nám to teď nejvíc kazej?',
    '42 % spendu teče pod break-even — jak tomu předcházet?',
    'Co je zralost a proč jí mám věřit?',
    'Který funnel škálovat?'
  ];

  function render() {
    if (!S.els.body) return;
    var h = '';
    if (!S.msgs.length) {
      h = '<div class="ai-empty">' +
          '<div class="ai-empty-t">Zeptej se na cokoli z dashboardu</div>' +
          '<div class="ai-empty-d">Vidím živá data i nastavení. Umím vysvětlit metriky, ' +
          'najít, co pálí peníze, nebo navrhnout změnu prahu (uložíš ji ty, ne já).</div>' +
          '<div class="ai-tips">' + TIPS.map(function (t) {
            return '<button type="button" class="ai-tip">' + esc(t) + '</button>';
          }).join('') + '</div></div>';
    } else {
      h = S.msgs.map(msgHTML).join('');
    }
    if (S.busy) {
      h += '<div class="ai-m ai-ai"><div class="ai-b ai-think">' +
           '<span class="ai-dots"><i></i><i></i><i></i></span> přemýšlím a tahám data…' +
           '<div class="ai-slow">u složitějších otázek to trvá i minutu</div></div></div>';
    }
    S.els.body.innerHTML = h;
    S.els.body.scrollTop = S.els.body.scrollHeight;
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || S.busy) return;
    S.msgs.push({ role: 'user', text: text });
    S.busy = true;
    saveThread(); render();

    var payload = { messages: S.msgs.map(function (m) { return { role: m.role, text: m.text }; }) };
    ADS.api('ai_chat', payload, { method: 'POST' }).then(function (r) {
      S.msgs.push({ role: 'model', text: r.reply || '(prázdná odpověď)',
                    tools: r.tools_used || [], proposals: r.proposals || [] });
    }).catch(function (e) {
      // Chybu ukážeme v threadu, ne toastem — ať je vidět, u KTERÉ otázky spadla.
      S.msgs.push({ role: 'model', text: 'Nepovedlo se: ' + (e && e.message ? e.message : 'chyba spojení') +
                    '\n\nZkus to prosím znovu — u složitých dotazů občas přeteče limit.' });
    }).then(function () {
      S.busy = false; saveThread(); render();
      // Odpověď dorazila, když je chat zavřený → skoč badge na bublinu („zpráva přijatá“).
      if (!S.open) { S.unread++; updateFab(); }
    });
  }

  function applyProposal(p, card) {
    ADS.api('settings_save', { key: p.key, value: p.new }, { method: 'POST' }).then(function () {
      if (card) card.innerHTML = '<div class="ai-prop-done">✓ Uloženo — ' + esc(p.label || p.key) +
                                 ' je teď ' + esc(p.new) + esc(p.unit ? ' ' + p.unit : '') + '</div>';
      if (ADS.toast) ADS.toast('Nastavení uloženo', 'success');
      // Dashboard i nastavení musí hned ukázat nová čísla — jinak by Filip viděl staré
      // prahy a myslel si, že se to neuložilo.
      if (ADS.bus) ADS.bus.dispatchEvent(new CustomEvent('settingschanged', { detail: { key: p.key } }));
    }).catch(function (e) {
      if (ADS.toast) ADS.toast('Uložení selhalo: ' + (e && e.message ? e.message : ''), 'error');
    });
  }

  function findProposal(id) {
    var parts = String(id).split('_');
    var m = S.msgs[parseInt(parts[0], 10)];
    return m && m.proposals ? m.proposals[parseInt(parts[1], 10)] : null;
  }

  function build() {
    if (S.els.root) return;
    var d = document.createElement('div');
    d.className = 'ai-drawer';
    d.hidden = true;
    d.innerHTML =
      '<div class="ai-head">' +
        '<span class="ai-h-t">✨ Asistent</span>' +
        '<span class="ai-h-m" title="Gemini — nejnovější PRO model">gemini pro</span>' +
        '<button type="button" class="ai-clear" title="Smazat konverzaci">vyčistit</button>' +
        '<button type="button" class="ai-x" title="Zavřít (Esc)">×</button>' +
      '</div>' +
      '<div class="ai-body"></div>' +
      '<form class="ai-foot">' +
        '<textarea class="ai-in" rows="1" placeholder="Zeptej se… (Enter odešle, Shift+Enter nový řádek)"></textarea>' +
        '<button type="submit" class="ai-send" title="Odeslat">↑</button>' +
      '</form>';
    document.body.appendChild(d);
    S.els.root = d;
    S.els.body = d.querySelector('.ai-body');
    S.els.in = d.querySelector('.ai-in');

    d.querySelector('.ai-x').addEventListener('click', close);
    d.querySelector('.ai-clear').addEventListener('click', function () {
      S.msgs = []; saveThread(); render();
    });
    d.querySelector('.ai-foot').addEventListener('submit', function (e) {
      e.preventDefault();
      send(S.els.in.value);
      S.els.in.value = '';
      S.els.in.style.height = 'auto';
    });
    // Enter odesílá, Shift+Enter je nový řádek — chat konvence, Filip ji zná odjinud.
    S.els.in.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); S.els.in.form.requestSubmit(); }
    });
    S.els.in.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(140, this.scrollHeight) + 'px';
    });
    d.addEventListener('click', function (e) {
      var t = e.target.closest('.ai-tip');
      if (t) { send(t.textContent); return; }
      var ok = e.target.closest('.ai-ok');
      if (ok) {
        var p = findProposal(ok.dataset.prop);
        if (p) applyProposal(p, ok.closest('.ai-prop'));
        return;
      }
      var no = e.target.closest('.ai-no');
      if (no) {
        var card = no.closest('.ai-prop');
        if (card) card.innerHTML = '<div class="ai-prop-done ai-prop-skip">Návrh zahozen</div>';
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) close(); });
  }

  var _closeT = null;
  function open() {
    build(); loadThread();
    if (_closeT) { clearTimeout(_closeT); _closeT = null; }
    S.open = true;
    S.unread = 0;                       // otevřením se badge nuluje (Filip: „přečteno“)
    S.els.root.hidden = false;
    // rAF → prohlížeč stihne vykreslit skrytý stav, pak teprve animace (jinak by skočil).
    requestAnimationFrame(function () { S.els.root.classList.add('is-open'); });
    document.body.classList.add('ai-on');
    updateFab();
    render();
    setTimeout(function () { S.els.in && S.els.in.focus(); }, 120);
  }
  function close() {
    S.open = false;
    document.body.classList.remove('ai-on');
    updateFab();
    if (!S.els.root) return;
    S.els.root.classList.remove('is-open');   // spustí zavírací animaci
    if (_closeT) clearTimeout(_closeT);
    _closeT = setTimeout(function () { if (!S.open && S.els.root) S.els.root.hidden = true; }, 220);
  }

  /* Bublina vpravo dole (FAB) — Filip: „AI chat jako bublina vpravo dole, animovaně se
   * otevře/zavře, a když odpoví, skočí tam jednička". Badge = počet nepřečtených odpovědí. */
  function updateFab() {
    if (!S.els.fab) return;
    S.els.fab.classList.toggle('is-open', S.open);
    var b = S.els.badge;
    if (b) {
      if (S.unread > 0 && !S.open) { b.textContent = S.unread > 9 ? '9+' : String(S.unread); b.hidden = false; }
      else b.hidden = true;
    }
  }
  function mountFab() {
    if (S.els.fab || document.querySelector('.ai-fab')) return;
    var f = document.createElement('button');
    f.type = 'button';
    f.className = 'ai-fab';
    f.title = 'AI asistent — zeptej se na cokoli z dashboardu';
    f.setAttribute('aria-label', 'AI asistent');
    f.innerHTML =
      '<span class="ai-fab-ico ai-fab-spark" aria-hidden="true">✨</span>' +
      '<span class="ai-fab-ico ai-fab-close" aria-hidden="true">×</span>' +
      '<span class="ai-fab-badge" hidden>1</span>';
    f.addEventListener('click', function () { S.open ? close() : open(); });
    document.body.appendChild(f);
    S.els.fab = f;
    S.els.badge = f.querySelector('.ai-fab-badge');
    updateFab();
  }

  /* Tlačítko v patičce sidebaru zůstává jako druhá cesta (nad user-chip „F“). */
  function mountButton() {
    var foot = document.querySelector('.sn-foot');
    if (!foot || foot.querySelector('.ai-open')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-open';
    b.title = 'AI asistent — zeptej se na cokoli z dashboardu';
    b.innerHTML = '<span class="ai-open-i" aria-hidden="true">✨</span><span class="ai-open-t">AI</span>';
    b.addEventListener('click', function () { S.open ? close() : open(); });
    foot.insertBefore(b, foot.firstChild);
  }

  function mountAll() { mountFab(); mountButton(); }
  if (ADS.onReady) ADS.onReady(mountAll); else mountAll();
  // sidebar se překresluje z ADS.ROUTES → po každé změně route se ujisti, že tlačítka drží
  if (ADS.bus) ADS.bus.addEventListener('routechange', mountAll);

  ADS.ai = { open: open, close: close, ask: function (q) { open(); send(q); } };
})();
