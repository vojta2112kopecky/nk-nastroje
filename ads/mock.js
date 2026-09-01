/* =====================================================================
   NK Ads Dashboard — MOCK FIXTURY (mock.js)
   ---------------------------------------------------------------------
   window.ADS._mock = fixtury pro KAŽDÝ action dle SPEC §4, aby SPA jela
   standalone s ?mock=1 (bez PHP/API). Čte se až za běhu v ADS.api().

   Klíče odpovídají mockKey() z app.js:
     config, overview, creatives_kill, creatives_winners,
     creatives_new, creatives_all, timeseries, alltime, wizard_today
     + mutace: login, kill, reactivate, ad_status, refresh, wizard_save

   Data jsou realistická (kódy Z-269-002 / P-047-002 / N-002-005,
   funnely Snubní 30K / Zásnubní 49K / Maledivy / 100K), thumbnaily =
   placeholder data URI (žádný externí zdroj).
   ===================================================================== */
(function () {
  'use strict';

  /* ---- placeholder thumbnail (SVG data URI) ------------------------- */
  function ph(label, c1, c2){
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
        "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
          "<stop offset='0' stop-color='" + c1 + "'/><stop offset='1' stop-color='" + c2 + "'/>" +
        "</linearGradient></defs>" +
        "<rect width='120' height='120' rx='14' fill='url(#g)'/>" +
        "<text x='60' y='66' font-family='Arial,Helvetica,sans-serif' font-size='15' " +
          "fill='#ffffff' text-anchor='middle' font-weight='700' letter-spacing='.5'>" + label + "</text>" +
      "</svg>";
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  var TH_BLUE = ['#5566d6','#3a45a6'], TH_BROWN = ['#a97f4b','#7c5a30'],
      TH_YEL = ['#d7a93b','#b3831f'], TH_GREY = ['#8b909c','#5f636d'],
      TH_PINK = ['#d47aa6','#a8517d'], TH_RED = ['#d3453f','#a8322c'],
      TH_GREEN = ['#2aa06a','#1c7a4f'];

  /* ---- helper na 1 ad -------------------------------------------------*/
  function ad(id, code, copy, funnel, spend, thumbCols, created, status){
    return {
      ad_id: id,
      ad_name: code + ' | ' + copy + ' - ' + (created || '2026-06-20'),
      creative: code,
      copy_code: copy,
      funnel: funnel,
      status: status || 'ACTIVE',
      effective_status: status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
      created_time: (created || '2026-06-20') + 'T09:12:00+0200',
      spend: spend,
      thumbnail: ph(code, thumbCols[0], thumbCols[1]),
      image_url: ph(code, thumbCols[0], thumbCols[1]),
      preview_link: 'https://www.facebook.com/ads/api/preview_iframe.php?d=' + id,
      instagram_permalink: 'https://www.instagram.com/p/' + id + '/',
      ig: 'https://www.instagram.com/p/' + id + '/',
      object_type: 'VIDEO',
      adsmanager_link: 'https://www.facebook.com/adsmanager/manage/ads?act=842525630619928&selected_ad_ids=' + id
    };
  }

  /* ---- helper na 1 kreativu (agregát), tvar dle api.php present_row() --
     Prsteny: decision_roas = roas_model (prahy kotveny na model, SPEC §1).
     POZOR na 3 věci, kde se mock dřív rozcházel se serverem:
       · maturity  = 'young' | 'mature'  (NE 'mladá'/'zralá' — tables.js na ně větví)
       · trend_cps = OBJEKT {dir,cps7,cps30} (NE holý string)
       · spend_pct = 0..100 (server: round(spend/total*100, 1))                      */
  function cr(o){
    var ads = o.ads || [];
    var sample = ads[0] || null;
    var callRate = o.call_rate != null ? o.call_rate
                 : (o.leads ? Math.min(1, Math.max(0.05, o.called / o.leads)) : 0.05);
    var roasModel = o.roas_model || 0;
    var bookings = o.bookings || 0;
    return {
      creative: o.creative,
      funnel: o.funnel || '',
      event: o.event || '',
      spend: o.spend,
      spend_pct: o.spend_pct != null ? o.spend_pct : 0,   // 0..100
      leads: o.leads || 0,
      called: o.called || 0,
      bookings: bookings,
      passed: o.passed || 0,
      cpl: o.cpl != null ? o.cpl : (o.leads ? Math.round(o.spend / o.leads) : 0),
      cps: o.cps != null ? o.cps : (bookings ? Math.round(o.spend / bookings) : 0),
      roas_real: o.roas_real,
      roas_model: o.roas_model,
      roas_created: o.roas_created != null ? o.roas_created : null,   // rings: null
      roas_color: o.roas_color || semaOf(roasModel),                  // decision = model
      call_rate: Math.round(callRate * 1000) / 1000,
      dopocet_pct: o.dopocet_pct != null ? o.dopocet_pct : Math.round((1 - callRate) * 1000) / 1000,
      dopocet_warn: !!o.dopocet_warn,
      kill_layer: o.kill_layer || 0,
      kill_rule: (o.kill_rules && o.kill_rules[0]) || (o.kill_layer ? KILL_RULE_BY_LAYER[o.kill_layer] : ''),
      kill_rules: o.kill_rules || (o.kill_layer ? [KILL_RULE_BY_LAYER[o.kill_layer]] : []),
      kill_reason: o.kill_reason || '',
      maturity: o.maturity || ((o.spend < 450 && bookings < 1) ? 'young' : 'mature'),
      in_grace: !!o.in_grace,
      age_days: o.age_days != null ? o.age_days : null,
      benchmark_cps: o.benchmark_cps || 0,
      winner: o.winner != null ? !!o.winner : (roasModel >= 3 && bookings >= 5),
      scale_ready: !!o.scale_ready,
      scale_third_unknown: true,        // v1: poslední škálování neznáme (SPEC §1)
      trend_cps: o.trend_cps || { dir: 'flat', cps7: 0, cps30: 0 },
      is_new: !!o.is_new,
      revenue_real: o.revenue_real != null ? o.revenue_real
                    : Math.round((o.roas_real || 0) * (o.spend || 0)),
      ads: ads,
      sample_ad: sample
    };
  }
  var KILL_RULE_BY_LAYER = { 1: 'spend_no_lead', 2: 'tichy_zrout', 3: 'cpl_extreme', 4: 'roas_lt_1' };
  // stejné prahy jako config.thresholds níž (server: roas_semafor)
  function semaOf(r){
    r = Number(r) || 0;
    if (r >= 3.0) return 'green';
    if (r >= 2.0) return 'lgreen';
    if (r >= 1.3) return 'yellow';
    if (r >= 1.0) return 'orange';
    return 'red';
  }

  /* =====================================================================
     CONFIG
     ===================================================================== */
  /* Tvar 1:1 dle api.php ?action=config — VELKÁ písmena v `thresholds`,
     estimating_days / new_ads_days TOP-LEVEL (mimo thresholds).
     Díky tomu ?mock=1 testuje STEJNÉ cesty jako ostrá (applyConfig → ADS.TH). */
  var config = {
    user: 'Filip',
    users: ['Vojta', 'Filip'],
    presets: [7, 14, 30, 60, 90, 120, 180],
    funnels: ['Snubní 30K', 'Zásnubní 49K', 'Maledivy', '100K', 'Šaty', 'DOF'],
    events: ['Lead', 'Purchase', 'CompleteRegistration', 'Schedule'],
    bq_range: { min: '2025-12-31', max: '2026-07-15' },
    thresholds: {
      ROAS_GREEN: 3.0, ROAS_LGREEN: 2.0, ROAS_YELLOW: 1.3, ROAS_ORANGE: 1.0,
      HEALTH_YELLOW: 0.15, HEALTH_RED: 0.30,
      SPEND_NO_LEAD_MIN: 450, CPL_EXTREME: 500,
      TICHY_MIN_LEADS: 8, TICHY_MIN_CALLED: 8,
      MATURE_MIN_BOOKINGS: 3,
      WINNER_ROAS: 5.0, WINNER_MIN_BOOKINGS: 5,
      SCALE_MIN_BOOKINGS: 20,
      CALL_RATE_MIN: 0.05, DOPOCET_WARN_PCT: 0.50,
      CALL_RATE_WARN: 0.40,
      ANOMALY_PCT: 0.40, EARLY_KILL_SPEND: 450,
      GRACE_DAYS_DEFAULT: 1
    },
    funnel_overrides: {},
    new_ads_days: 10,
    estimating_days: 3,
    cache_ttl_min: 60,
    kill_rules: ['spend_no_lead', 'tichy_zrout', 'cpl_extreme', 'roas_lt_1']
  };

  /* =====================================================================
     OVERVIEW (health + totals + freshness + quality + funnels + events + anomaly)
     ===================================================================== */
  /* Tvar 1:1 dle api.php build_overview():
     - health = { pct_spend_roas_below_1 (PODÍL 0..1), color }
     - totals.winner_count (NE winners_count)
     - funnels[].funnel / events[].event (NE .name); spend_pct = 0..100
     - anomalies = PLOCHÉ pole s `deviation` (podíl) + `direction` (žádný `active` flag) */
  var overview = {
    tab: 'rings',
    range: { from: '2026-06-17', to: '2026-07-16' },
    health: { pct_spend_roas_below_1: 0.185, color: 'yellow' },
    totals: {
      spend: 486300, roas_real: 1.72, roas_model: 2.34,
      kill_count: 4, winner_count: 3, creatives: 9
    },
    freshness: {
      last_refresh: '2026-07-16 08:00',
      bq_min_date: '2025-12-31', bq_max_date: '2026-07-15',
      cache_ttl_min: 60, stale: false
    },
    quality: { spend_no_pair_pct: 0.061, leads_no_code_pct: 0.048 },
    funnels: [
      { funnel: 'Snubní 30K',   spend: 214800, spend_pct: 44.2, leads: 892, bookings: 121,
        cpl: 241, cps: 1775, roas_real: 1.94, roas_model: 2.71, roas_color: 'lgreen',
        median_cps: 1690, kill_count: 1, winner_count: 1, anomaly: false },
      { funnel: 'Zásnubní 49K', spend: 138200, spend_pct: 28.4, leads: 461, bookings: 62,
        cpl: 300, cps: 2229, roas_real: 1.51, roas_model: 2.02, roas_color: 'lgreen',
        median_cps: 2180, kill_count: 1, winner_count: 1, anomaly: true,
        anomaly_detail: { funnel: 'Zásnubní 49K', rule: 'anomaly', metric: 'cpl',
                          yesterday: 512, median_7d: 333, deviation: 0.537, direction: 'up' } },
      { funnel: 'Maledivy',     spend: 74600,  spend_pct: 15.3, leads: 233, bookings: 27,
        cpl: 320, cps: 2763, roas_real: 1.33, roas_model: 1.78, roas_color: 'yellow',
        median_cps: 2610, kill_count: 1, winner_count: 1, anomaly: true,
        anomaly_detail: { funnel: 'Maledivy', rule: 'anomaly', metric: 'cpl',
                          yesterday: 468, median_7d: 314, deviation: 0.488, direction: 'up' } },
      { funnel: '100K',         spend: 58700,  spend_pct: 12.1, leads: 214, bookings: 22,
        cpl: 274, cps: 2668, roas_real: 2.10, roas_model: 2.95, roas_color: 'lgreen',
        median_cps: 2540, kill_count: 1, winner_count: 0, anomaly: false }
    ],
    events: [
      { event: 'Lead',     spend: 301400, leads: 1204, bookings: 148, cpl: 250, cps: 2036,
        roas_real: 1.66, roas_model: 2.21, roas_color: 'lgreen' },
      { event: 'Purchase', spend: 184900, leads: 596,  bookings: 84,  cpl: 310, cps: 2201,
        roas_real: 1.83, roas_model: 2.55, roas_color: 'lgreen' }
    ],
    anomalies: [
      { funnel: 'Zásnubní 49K', rule: 'anomaly', metric: 'cpl',
        yesterday: 512, median_7d: 333, deviation: 0.537, direction: 'up' },
      { funnel: 'Maledivy', rule: 'anomaly', metric: 'cpl',
        yesterday: 468, median_7d: 314, deviation: 0.488, direction: 'up' }
    ]
  };

  /* =====================================================================
     CREATIVES — kill / winners / new / all
     ===================================================================== */
  var creatives_kill = [
    cr({
      creative: 'P-047-002', funnel: 'Snubní 30K', spend: 1240, spend_pct: 2.6,
      leads: 0, called: 0, bookings: 0, passed: 0,
      roas_real: 0, roas_model: 0, call_rate: 0.05, dopocet_pct: 0.95, dopocet_warn: false,
      kill_layer: 1, kill_rules: ['spend_no_lead'],
      kill_reason: 'Spend bez leadů (1 240 Kč, 0 leadů)',
      trend_cps: { dir: 'flat', cps7: 0, cps30: 0 }, age_days: 14, benchmark_cps: 1750,
      ads: [ ad('120210000000047', 'P-047-002', 'Sázka na jistotu', 'Snubní 30K', 1240, TH_BLUE, '2026-07-02') ]
    }),
    cr({
      creative: 'Z-269-014', funnel: 'Zásnubní 49K', spend: 3180, spend_pct: 6.5,
      leads: 11, called: 9, bookings: 0, passed: 0,
      roas_real: 0, roas_model: 0, call_rate: 0.818, dopocet_pct: 0.182,
      kill_layer: 2, kill_rules: ['tichy_zrout'],
      kill_reason: 'Tichý žrout (11 leadů, 9 provoláno, 0 rezervací)',
      trend_cps: { dir: 'up', cps7: 0, cps30: 0 }, age_days: 22, benchmark_cps: 2180,
      ads: [ ad('120210000000269', 'Z-269-014', 'Řekni ano jinak', 'Zásnubní 49K', 3180, TH_BROWN, '2026-06-24') ]
    }),
    cr({
      creative: 'M-113-001', funnel: 'Maledivy', spend: 2560, spend_pct: 5.3,
      leads: 4, called: 3, bookings: 0, passed: 0, cpl: 640,
      roas_real: 0, roas_model: 0, call_rate: 0.75, dopocet_pct: 0.25, dopocet_warn: false,
      kill_layer: 3, kill_rules: ['cpl_extreme'],
      kill_reason: 'Extrém CPL (640 Kč/lead)',
      trend_cps: { dir: 'up', cps7: 0, cps30: 0 }, age_days: 18, benchmark_cps: 2610,
      ads: [ ad('120210000000113', 'M-113-001', 'Svatba snů na Maledivách', 'Maledivy', 2560, TH_YEL, '2026-06-28') ]
    }),
    cr({
      creative: 'Z-201-003', funnel: '100K', spend: 9840, spend_pct: 20.2,
      leads: 34, called: 22, bookings: 5, passed: 3, cps: 1968,
      roas_real: 0.58, roas_model: 0.79, call_rate: 0.647, dopocet_pct: 0.353,
      revenue_real: 5707,
      kill_layer: 4, kill_rules: ['roas_lt_1'],
      kill_reason: 'Zralá ROAS<1 (5 rez., ROAS 0.79)',
      trend_cps: { dir: 'up', cps7: 2210, cps30: 1968 }, age_days: 35, benchmark_cps: 2540,
      ads: [ ad('120210000000201', 'Z-201-003', 'Vyhraj 100 000 Kč', '100K', 9840, TH_GREY, '2026-06-11') ]
    })
  ];

  var creatives_winners = [
    cr({
      creative: 'Z-269-002', funnel: 'Zásnubní 49K', spend: 41200, spend_pct: 8.5,
      leads: 168, called: 121, bookings: 24, passed: 17, cps: 1717,
      roas_real: 3.62, roas_model: 4.81, call_rate: 0.72, dopocet_pct: 0.28,
      revenue_real: 149144,
      kill_layer: 0, scale_ready: true, age_days: 59, benchmark_cps: 2180,
      trend_cps: { dir: 'down', cps7: 1580, cps30: 1717 },
      ads: [
        ad('120210000000902', 'Z-269-002', 'Řekni ano', 'Zásnubní 49K', 24800, TH_BROWN, '2026-05-18'),
        ad('120210000000903', 'Z-269-002', 'Řekni ano (v2)', 'Zásnubní 49K', 16400, TH_BROWN, '2026-06-02')
      ]
    }),
    cr({
      creative: 'P-047-010', funnel: 'Snubní 30K', spend: 33600, spend_pct: 6.9,
      leads: 142, called: 104, bookings: 18, passed: 12, cps: 1867,
      roas_real: 2.71, roas_model: 3.58, call_rate: 0.732, dopocet_pct: 0.268,
      revenue_real: 91056,
      kill_layer: 0, scale_ready: false, age_days: 47, benchmark_cps: 1750,
      trend_cps: { dir: 'flat', cps7: 1860, cps30: 1867 },
      ads: [ ad('120210000000471', 'P-047-010', 'Prsteny na míru', 'Snubní 30K', 33600, TH_BLUE, '2026-05-30') ]
    }),
    cr({
      creative: 'P-088-004', funnel: 'Maledivy', spend: 18900, spend_pct: 3.9,
      leads: 76, called: 51, bookings: 9, passed: 6, cps: 2100,
      roas_real: 2.28, roas_model: 3.14, call_rate: 0.671, dopocet_pct: 0.329,
      revenue_real: 43092,
      kill_layer: 0, scale_ready: false, age_days: 41, benchmark_cps: 2610,
      trend_cps: { dir: 'down', cps7: 1980, cps30: 2100 },
      ads: [ ad('120210000000884', 'P-088-004', 'Líbánky zdarma', 'Maledivy', 18900, TH_YEL, '2026-06-05') ]
    })
  ];

  var creatives_new = [
    cr({
      creative: 'P-051-001', funnel: 'Snubní 30K', spend: 380, spend_pct: 0.8,
      leads: 2, called: 1, bookings: 0, passed: 0,
      roas_real: 0, roas_model: 0, call_rate: 0.5, dopocet_pct: 0.5,
      kill_layer: 0, is_new: true, age_days: 3, benchmark_cps: 1750,
      trend_cps: { dir: 'flat', cps7: 0, cps30: 0 },
      ads: [ ad('120210000001051', 'P-051-001', 'Nová kolekce 2026', 'Snubní 30K', 380, TH_BLUE, '2026-07-13') ]
    }),
    cr({
      creative: 'Z-274-001', funnel: 'Zásnubní 49K', spend: 640, spend_pct: 1.3,
      leads: 5, called: 2, bookings: 1, passed: 0, cps: 640,
      roas_real: 1.1, roas_model: 2.6, call_rate: 0.4, dopocet_pct: 0.6, dopocet_warn: true,
      revenue_real: 704,
      kill_layer: 0, is_new: true, age_days: 5, benchmark_cps: 2180,
      trend_cps: { dir: 'flat', cps7: 640, cps30: 640 },
      ads: [ ad('120210000001274', 'Z-274-001', 'Zásnuby pod hvězdami', 'Zásnubní 49K', 640, TH_BROWN, '2026-07-11') ]
    }),
    // Úplně čerstvá (age < GRACE_DAYS_DEFAULT) → in_grace, na CPL se nekilluje.
    // (Dřív tu seděla N-002-005 = NÁUŠNICOVÁ kreativa v PRSTENOVÉ fixtuře — pryč,
    //  náušnice mají vlastní earrings_* klíče.)
    cr({
      creative: 'P-052-004', funnel: 'Snubní 30K', spend: 210, spend_pct: 0.4,
      leads: 1, called: 0, bookings: 0, passed: 0,
      roas_real: 0, roas_model: 0, call_rate: 0.05, dopocet_pct: 0.95, dopocet_warn: true,
      kill_layer: 0, is_new: true, in_grace: true, age_days: 0, benchmark_cps: 1750,
      trend_cps: { dir: 'flat', cps7: 0, cps30: 0 },
      ads: [ ad('120210000000524', 'P-052-004', 'Zlato nebo platina?', 'Snubní 30K', 210, TH_BLUE, '2026-07-16') ]
    })
  ];

  /* segment=all = VŠECHNY kreativy, každá PRÁVĚ JEDNOU (server je klíčuje kreativou).
     Dřív se sem Z-201-003 dostala 2× (ručně + přes creatives_kill) → duplicitní řádek
     v Tabulatoru a nafouknutý „% spendu". Kill řádky bereme jen z creatives_kill. */
  var creatives_all = creatives_winners.concat([
    cr({
      creative: 'P-039-007', funnel: 'Snubní 30K', spend: 28700, spend_pct: 5.9,
      leads: 121, called: 88, bookings: 14, passed: 10, cps: 2050,
      roas_real: 1.86, roas_model: 2.52, call_rate: 0.727, dopocet_pct: 0.273,
      revenue_real: 53382,
      kill_layer: 0, age_days: 55, benchmark_cps: 1750,
      trend_cps: { dir: 'flat', cps7: 2040, cps30: 2050 },
      ads: [ ad('120210000000397', 'P-039-007', 'Klasika co vydrží', 'Snubní 30K', 28700, TH_BLUE, '2026-05-22') ]
    })
  ], creatives_new, creatives_kill);

  /* =====================================================================
     TIMESERIES (14 dní; poslední 3 = estimating)
     ===================================================================== */
  function lastDates(n){
    var out = [], d = new Date('2026-07-15T00:00:00');
    for (var i = n - 1; i >= 0; i--){
      var t = new Date(d); t.setDate(d.getDate() - i);
      out.push(t.getFullYear() + '-' + ('0'+(t.getMonth()+1)).slice(-2) + '-' + ('0'+t.getDate()).slice(-2));
    }
    return out;
  }
  var timeseries = {
    metric: 'spend',
    split: 'funnel',
    dates: lastDates(14),
    series: [
      { name: 'Snubní 30K',   data: [14200,15100,13800,16400,15900,17200,16800,15600,14900,16100,15300,14800,9200,5100],  estimating_from_index: 11 },
      { name: 'Zásnubní 49K', data: [ 9800, 9200,10100, 9600,10400, 9900,10800,10200, 9700,10500, 9800, 9100,5600,3100],  estimating_from_index: 11 },
      { name: 'Maledivy',     data: [ 5100, 4800, 5400, 5000, 5600, 5200, 4900, 5300, 5100, 5500, 5000, 4700,2900,1600],  estimating_from_index: 11 },
      { name: '100K',         data: [ 4100, 4400, 3900, 4600, 4200, 4800, 4300, 4500, 4100, 4700, 4200, 3900,2400,1300],  estimating_from_index: 11 }
    ]
  };

  /* =====================================================================
     ALLTIME (best-of dle ROAS_model)
     ===================================================================== */
  var alltime = [
    cr({
      creative: 'Z-269-002', funnel: 'Zásnubní 49K', spend: 214800, spend_pct: 42.9,
      leads: 921, called: 662, bookings: 138, passed: 101, cps: 1557,
      roas_real: 3.71, roas_model: 4.94, call_rate: 0.719, dopocet_pct: 0.281,
      revenue_real: 796908,
      kill_layer: 0, scale_ready: true, age_days: 183, benchmark_cps: 1750,
      trend_cps: { dir: 'down', cps7: 1480, cps30: 1557 },
      ads: [ ad('120210000000902', 'Z-269-002', 'Řekni ano', 'Zásnubní 49K', 214800, TH_BROWN, '2026-01-14') ]
    }),
    cr({
      creative: 'P-047-010', funnel: 'Snubní 30K', spend: 186400, spend_pct: 37.2,
      leads: 812, called: 590, bookings: 121, passed: 88, cps: 1541,
      roas_real: 2.88, roas_model: 3.79, call_rate: 0.727, dopocet_pct: 0.273,
      revenue_real: 536832,
      kill_layer: 0, age_days: 163, benchmark_cps: 1750,
      trend_cps: { dir: 'flat', cps7: 1530, cps30: 1541 },
      ads: [ ad('120210000000471', 'P-047-010', 'Prsteny na míru', 'Snubní 30K', 186400, TH_BLUE, '2026-02-03') ]
    }),
    cr({
      creative: 'P-088-004', funnel: 'Maledivy', spend: 98700, spend_pct: 19.7,
      leads: 402, called: 268, bookings: 58, passed: 41, cps: 1702,
      roas_real: 2.41, roas_model: 3.31, call_rate: 0.667, dopocet_pct: 0.333,
      revenue_real: 237867,
      kill_layer: 0, age_days: 169, benchmark_cps: 2610,
      trend_cps: { dir: 'down', cps7: 1650, cps30: 1702 },
      ads: [ ad('120210000000884', 'P-088-004', 'Líbánky zdarma', 'Maledivy', 98700, TH_YEL, '2026-01-28') ]
    })
  ];

  /* =====================================================================
     WIZARD_TODAY (denní HECK) — done:false => HECK banner se zobrazí
     ===================================================================== */
  var wizard_today = {
    run_date: '2026-07-16',
    done: false,
    who: null,
    started_at: null,
    finished_at: null,
    pending_kill: 4,
    steps: [
      { key: 'kill',     title: 'Kill kandidáti',        done: false, items: creatives_kill.length },
      { key: 'funnels',  title: 'Zhodnocení funnelů',    done: false, items: overview.funnels.length },
      { key: 'events',   title: 'Zhodnocení eventů',     done: false, items: overview.events.length },
      { key: 'scale',    title: 'Scale check',           done: false, items: creatives_winners.filter(function(c){return c.scale_ready;}).length },
      { key: 'new',      title: 'Nejnovější reklamy',    done: false, items: creatives_new.length },
      { key: 'summary',  title: 'Souhrn',                done: false, items: 0 }
    ]
  };

  /* =====================================================================
     NÁUŠNICE (earrings) — bez funnelů/eventů; ROAS zaplaceno = default semafor.

     ⚠️ TVAR = 1:1 dle api.php (větev $tab === 'earrings' + present_row()).
     Server NEposílá `demands`/`reservations`/`revenue_paid`/`roas_paid` —
     mapuje je do JEDNOTNÉHO kontraktu SPEC §4:
        demands      → leads
        reservations → bookings
        zaplaceno    → revenue_real  +  roas_real   (= default semafor, §5 „na zaplaceno")
        celkem       → revenue_created + roas_created
        roas_model   = (celkem / call_rate) / spend   (dopočet z CELKEM, ne ze zaplaceno)
     Fixtury proto drží SERVEROVÉ názvy — jinak by ?mock=1 testoval alias větev
     v tables.js (`d.demands ?? d.leads`), kterou naostro nikdy nic netrefí.
     Čísla dle SPEC §0C: pár pecek 19 990 Kč, kampaň běží od 3. 7. 2026.
     ===================================================================== */
  function crEar(o){
    var spend = o.spend, demands = o.demands, called = o.called, resv = o.bookings;
    var created = o.revenue_created, paid = o.revenue_real;
    // call_rate = clamp(called/demands, CALL_RATE_MIN, 1) — stejně jako server
    var cr_ = demands ? Math.min(1, Math.max(0.05, called / demands)) : 0.05;
    var r2_ = function (x){ return Math.round(x * 100) / 100; };
    var roasReal    = spend ? r2_(paid / spend) : 0;
    var roasCreated = spend ? r2_(created / spend) : 0;
    var roasModel   = spend ? r2_((created / cr_) / spend) : 0;
    var code = o.creative;
    return {
      creative: code,
      funnel: 'Náušnice',            // server: konstantní „funnel" pro benchmark
      event: '',
      spend: spend,
      spend_pct: o.spend_pct,        // 0..100 (server: round(x/total*100, 1))
      leads: demands,                // = poptávky
      called: called,
      bookings: resv,                // = rezervace
      passed: null,                  // náušnice: server posílá null
      cpl: demands ? Math.round(spend / demands) : 0,
      cps: resv ? Math.round(spend / resv) : 0,
      roas_real: roasReal,           // zaplaceno
      roas_model: roasModel,         // dopočet z celkem
      roas_created: roasCreated,     // celkem
      roas_color: o.roas_color,      // server: roas_semafor(decision_roas) = na ZAPLACENO
      call_rate: Math.round(cr_ * 1000) / 1000,
      dopocet_pct: Math.round((1 - cr_) * 1000) / 1000,
      dopocet_warn: demands > 0 && ((1 - cr_) > 0.50 || cr_ < 0.40),
      kill_layer: o.kill_layer || 0,
      kill_rule: (o.kill_rules && o.kill_rules[0]) || '',
      kill_rules: o.kill_rules || [],
      kill_reason: o.kill_reason || '',
      maturity: (spend < 450 && resv < 1) ? 'young' : 'mature',
      in_grace: false,
      age_days: o.age_days,
      benchmark_cps: o.benchmark_cps || 0,
      winner: !!o.winner,
      scale_ready: !!o.scale_ready,
      scale_third_unknown: true,     // v1: poslední škálování neznáme (SPEC §1)
      trend_cps: o.trend_cps || { dir: 'flat', cps7: 0, cps30: 0 },
      is_new: !!o.is_new,
      revenue_real: paid,            // zaplaceno
      revenue_created: created,      // celkem (jen náušnice)
      ads: o.ads || [],
      sample_ad: (o.ads && o.ads[0]) || null
    };
  }

  // medián CPS „funnelu" Náušnice (jen řádky s rezervací): [1653, 2211, 2367] → 2211
  var EAR_BENCH = 2211;

  var ear_002_005 = crEar({                       // winner (SPEC §0C: N-002-005)
    creative: 'N-002-005', spend: 24800, spend_pct: 40.4,
    demands: 16, called: 12, bookings: 15,
    revenue_created: 99950, revenue_real: 79960,  // 5 × 19 990 vytvořeno / 4 × 19 990 zaplaceno
    roas_color: 'green', winner: true, benchmark_cps: EAR_BENCH, age_days: 13,
    trend_cps: { dir: 'down', cps7: 1520, cps30: 1653 },
    ads: [ ad('120210000002005', 'N-002-005', 'Pecky za pusinku', 'Náušnice', 24800, TH_PINK, '2026-07-03') ]
  });

  var ear_004_001 = crEar({                       // tržba se tvoří, ale zaplaceno zaostává
    creative: 'N-004-001', spend: 19900, spend_pct: 32.4,
    demands: 11, called: 8, bookings: 9,
    revenue_created: 59970, revenue_real: 19990,  // 3 × vytvořeno / 1 × zaplaceno
    roas_color: 'orange', benchmark_cps: EAR_BENCH, age_days: 11,
    trend_cps: { dir: 'flat', cps7: 2180, cps30: 2211 },
    ads: [ ad('120210000004001', 'N-004-001', 'Kapka světla', 'Náušnice', 19900, TH_PINK, '2026-07-05') ]
  });

  var ear_001_003 = crEar({                       // 2 vrstvy: extrém CPL + zralá ROAS<1
    creative: 'N-001-003', spend: 14200, spend_pct: 23.1,
    demands: 9, called: 6, bookings: 6,
    revenue_created: 39980, revenue_real: 0,      // 2 × vytvořeno / 0 zaplaceno
    roas_color: 'red', benchmark_cps: EAR_BENCH, age_days: 12,
    kill_layer: 3, kill_rules: ['cpl_extreme', 'roas_lt_1'],
    kill_reason: 'Extrém CPL (1 578 Kč/lead) · Zralá ROAS<1 (6 rez., ROAS 0)',
    trend_cps: { dir: 'up', cps7: 2610, cps30: 2367 },
    ads: [ ad('120210000001003', 'N-001-003', 'Klasické kolečko', 'Náušnice', 14200, TH_PINK, '2026-07-04') ]
  });

  var ear_006_002 = crEar({                       // vrstva 1: spend bez poptávek
    creative: 'N-006-002', spend: 2100, spend_pct: 3.4,
    demands: 0, called: 0, bookings: 0,
    revenue_created: 0, revenue_real: 0,
    roas_color: 'red', benchmark_cps: EAR_BENCH, age_days: 9,
    kill_layer: 1, kill_rules: ['spend_no_lead'],
    kill_reason: 'Spend bez leadů (2 100 Kč, 0 leadů)',
    trend_cps: { dir: 'flat', cps7: 0, cps30: 0 },
    ads: [ ad('120210000006002', 'N-006-002', 'Trojitá pecka', 'Náušnice', 2100, TH_PINK, '2026-07-07') ]
  });

  var ear_005_001 = crEar({                       // mladá — čekáme data (nekillovat)
    creative: 'N-005-001', spend: 420, spend_pct: 0.7,
    demands: 1, called: 0, bookings: 0,
    revenue_created: 0, revenue_real: 0,
    roas_color: 'red', benchmark_cps: EAR_BENCH, age_days: 2, is_new: true,
    trend_cps: { dir: 'flat', cps7: 0, cps30: 0 },
    ads: [ ad('120210000005001', 'N-005-001', 'Srdíčko mini', 'Náušnice', 420, TH_PINK, '2026-07-14') ]
  });

  // segmenty = stejné řazení jako server/SPEC §5
  var earrings_all     = [ear_002_005, ear_004_001, ear_001_003, ear_006_002, ear_005_001];
  var earrings_kill    = [ear_001_003, ear_006_002];   // spálené peníze desc
  var earrings_winners = [ear_002_005];                // ROAS_model desc
  var earrings_new     = [ear_005_001];                // created_time ≤ NEW_ADS_DAYS

  /* =====================================================================
     ULOŽENÍ DO ADS._mock
     ===================================================================== */
  window.ADS = window.ADS || {};
  window.ADS._mock = {
    config: config,
    overview: overview,
    creatives_kill: creatives_kill,
    creatives_winners: creatives_winners,
    creatives_new: creatives_new,
    creatives_all: creatives_all,
    timeseries: timeseries,
    alltime: alltime,
    wizard_today: wizard_today,

    // náušnicový tab (mockKey: 'earrings_' + segment) — tables.js volá segment=all,
    // wizard.js jede kill/winners/new s tab z ADS.state → musí existovat všechny
    earrings_all:     earrings_all,
    earrings_kill:    earrings_kill,
    earrings_winners: earrings_winners,
    earrings_new:     earrings_new,

    // mutace / stavové akce
    // POZOR: `login` tu ZÁMĚRNĚ NENÍ — statická fixtura {user:'Filip'} přebila
    // posílaného uživatele, takže přihlášení jako Vojta vrátilo Filipa.
    // Bez klíče spadne na default v mockRespond(), který user ECHOUJE zpátky
    // (stejně jako api.php: json_out(['ok'=>true,'user'=>$user])).
    logout:      { ok: true },
    kill:        { ok: true, effective_status: 'PAUSED' },
    reactivate:  { ok: true, effective_status: 'ACTIVE' },
    ad_status:   { effective_status: 'PAUSED' },
    refresh:     { started: true, last_refresh: '2026-07-16 08:00' },
    wizard_save: { ok: true }
  };

})();
