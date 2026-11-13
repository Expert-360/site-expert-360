// Expert 360 — outil d'audit Google Ads (page /audit-google-ads)
// Tableau de bord : graphes du marché, scénarios de budget, détail.
// Dans chaque liste, 3 éléments sont visibles et le reste est flouté jusqu'au courriel.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('audit-form'), input = $('audit-url'), err = $('audit-error');
  var progress = $('audit-progress'), result = $('audit-result');
  var data = null, site = null, unlocked = false, VISIBLE = 3;
  var NS = 'http://www.w3.org/2000/svg';
  var COLORS = ['#0E2A3B', '#FA7119', '#2D82AB', '#FEB412', '#19A9E0', '#9AAAB5'];
  var nf = new Intl.NumberFormat('fr-CA');
  var money = function (v) { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: v < 100 ? 2 : 0 }).format(v); };
  var short = function (v) { return v >= 1000 ? (Math.round(v / 100) / 10).toString().replace('.', ',') + ' k' : String(v); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  var svg = function (tag, attrs, text) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; };
  // Texte de remplacement pour les lignes floutées : la vraie donnée n'est pas dans la page avant le déblocage.
  var fake = function (n) { return '■■■■■■■■■■■■■■■■■■■■'.slice(0, n); };
  var isMobile = function () { return window.innerWidth < 600; };

  function showError(e, msg) { e.textContent = msg; e.hidden = !msg; }

  function animateSteps() {
    var items = progress.querySelectorAll('.steps li'), fill = $('pbar-fill'), i = 0;
    items.forEach(function (li) { li.className = ''; });
    fill.style.width = '0%';
    return new Promise(function (resolve) {
      (function next() {
        if (i > 0) items[i - 1].className = 'done';
        if (i === items.length) { fill.style.width = '100%'; return resolve(); }
        items[i].className = 'active';
        fill.style.width = Math.round(((i + 0.5) / items.length) * 100) + '%';
        i++;
        setTimeout(next, 1000);
      })();
    });
  }

  var post = function (path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  };

  var lastUrl = '';

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError(err, '');
    var url = input.value.trim();
    if (!url || url.indexOf('.') === -1) { showError(err, 'Entrez une adresse valide, par exemple : votresite.ca'); input.focus(); return; }
    lancer(url, '');
  });

  async function lancer(url, metier) {
    lastUrl = url;
    var btn = form.querySelector('button'); btn.disabled = true;
    result.hidden = true; $('report').hidden = true; unlocked = false; $('unlock').classList.remove('done');
    $('unlock-fab').hidden = true; $('metier-form').hidden = true;
    $('p-site').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    progress.hidden = false;
    progress.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      var out = await Promise.all([post('/api/analyse', { url: url, metier: metier }), animateSteps()]);
      var res = out[0];
      if (!res.ok) throw new Error(res.j.error || 'Erreur');
      if (res.j.empty) throw new Error(res.j.message);
      data = res.j;
      await wait(300);
      progress.hidden = true;
      render();
      result.hidden = false;
      $('unlock-fab').hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      progress.hidden = true;
      showError(err, ex.message || "L'analyse n'a pas pu aboutir. Réessayez dans un instant.");
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { btn.disabled = false; }
  }

  // Métier analysé : affiché en puces, corrigeable par le visiteur.
  function renderMetier() {
    var box = $('r-metier'); box.innerHTML = '';
    var list = (data.metier || []).slice(0, 6);
    if (!list.length) { box.appendChild(el('span', 'metier-none', 'déduit des recherches liées à votre site')); }
    list.forEach(function (m) { box.appendChild(el('span', 'chip metier-chip', m)); });
    $('metier-input').value = (data.metier || []).slice(0, 6).join(', ');
  }
  $('metier-edit').addEventListener('click', function () {
    var f = $('metier-form'); f.hidden = !f.hidden;
    if (!f.hidden) $('metier-input').focus();
  });
  $('metier-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('metier-input').value.trim();
    if (v.length < 3) { $('metier-input').focus(); return; }
    lancer(lastUrl, v);
  });

  function animateGauge(arc, label, target) {
    var t0 = Date.now();
    arc.style.transition = 'none'; arc.style.strokeDashoffset = '327';
    setTimeout(function () {
      arc.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.65,0,.35,1)';
      arc.style.strokeDashoffset = String(327 * (1 - target / 100));
    }, 60);
    var timer = setInterval(function () {
      var n = Math.round(target * Math.min(1, (Date.now() - t0) / 1200));
      label.textContent = n;
      if (n >= target) clearInterval(timer);
    }, 30);
  }

  // ---------- Graphes (SVG maison, sans librairie) ----------

  function seasonChart(box, months, peak, low) {
    box.innerHTML = '';
    var m = isMobile(), W = m ? 360 : 640, H = m ? 230 : 200, top = 22, bottom = 26, n = months.length, gap = m ? 5 : 10;
    var bw = (W - gap * (n - 1)) / n, max = Math.max.apply(null, months.map(function (m) { return m.recherches; })) || 1;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H });
    s.appendChild(svg('line', { x1: 0, x2: W, y1: H - bottom, y2: H - bottom, stroke: '#DCE3E8' }));
    months.forEach(function (m, i) {
      var h = Math.max(3, Math.round((m.recherches / max) * (H - top - bottom)));
      var x = i * (bw + gap), y = H - bottom - h;
      var fill = m.mois === peak ? '#FA7119' : m.mois === low ? '#9AAAB5' : '#2D82AB';
      s.appendChild(svg('rect', { x: x, y: y, width: bw, height: h, rx: 4, fill: fill }));
      var lab = svg('text', { x: x + bw / 2, y: y - 6, 'text-anchor': 'middle', 'class': 'v' }, short(m.recherches));
      lab.style.fontSize = isMobile() ? '9px' : '11px';
      s.appendChild(lab);
      s.appendChild(svg('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, isMobile() ? m.mois.charAt(0).toUpperCase() : m.mois.replace('.', '')));
    });
    box.appendChild(s);
    box.setAttribute('aria-label', 'Recherches par mois. Mois le plus fort : ' + peak + '. Mois le plus faible : ' + low + '.');
  }

  function donut(box, items, center, centerSub) {
    box.innerHTML = '';
    if (!items || !items.length) { box.appendChild(el('p', 'chart-empty', 'Pas assez de données pour ce graphe.')); return false; }
    var wrap = el('div', 'donut-wrap');
    var s = svg('svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': items.map(function (it) { return it.nom + ' ' + it.part + ' %'; }).join(', ') });
    var r = 46, c = 2 * Math.PI * r, off = 0;
    s.appendChild(svg('circle', { cx: 60, cy: 60, r: r, fill: 'none', stroke: '#EAF1F5', 'stroke-width': 18 }));
    items.forEach(function (it, i) {
      var len = Math.max(0, (it.part / 100) * c - 1.5);
      s.appendChild(svg('circle', { cx: 60, cy: 60, r: r, fill: 'none', stroke: it.color || COLORS[i % COLORS.length], 'stroke-width': 18,
        'stroke-dasharray': len + ' ' + (c - len), 'stroke-dashoffset': -off, transform: 'rotate(-90 60 60)' }));
      off += (it.part / 100) * c;
    });
    s.appendChild(svg('text', { x: 60, y: 62, 'text-anchor': 'middle', 'class': 'center' }, center));
    s.appendChild(svg('text', { x: 60, y: 76, 'text-anchor': 'middle', 'class': 'center-sub' }, centerSub));
    wrap.appendChild(s);
    var ul = el('ul', 'legend');
    items.forEach(function (it, i) {
      var li = el('li'), sw = el('i'); sw.style.background = it.color || COLORS[i % COLORS.length];
      li.appendChild(sw); li.appendChild(el('span', '', it.nom)); li.appendChild(el('b', '', it.part + ' %'));
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    box.appendChild(wrap);
    return true;
  }

  function hbars(box, items) {
    box.innerHTML = '';
    if (!items || !items.length) { box.appendChild(el('p', 'chart-empty', 'Pas assez de données pour ce graphe.')); return; }
    var max = Math.max.apply(null, items.map(function (it) { return it.part; })) || 1;
    var wrap = el('div', 'hbars');
    items.forEach(function (it) {
      var row = el('div', 'hbar'), track = el('span', 'track'), bar = el('i');
      bar.style.width = Math.max(2, Math.round((it.part / max) * 100)) + '%';
      track.appendChild(bar);
      row.appendChild(el('em', '', it.nom));
      row.appendChild(track); row.appendChild(el('b', '', it.part + ' %'));
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  // Concurrents : recherches sur leur nom (3 premiers) face à celles sur le nom du prospect.
  function renderRivaux(r) {
    var box = $('c-rivaux'); box.innerHTML = '';
    var rows = (r.concurrents || []).slice(0, 3).map(function (c) { return { nom: c.nom, v: c.recherches }; });
    if (!rows.length) { box.appendChild(el('p', 'chart-empty', 'Aucun concurrent ne s’impose par son nom dans vos recherches : le terrain est libre.')); $('c-rivaux-note').textContent = ''; return; }
    rows.push({ nom: 'Vous (' + data.site + ')', v: r.recherchesMarque || 0, me: true });
    var max = Math.max.apply(null, rows.map(function (x) { return x.v; })) || 1;
    var wrap = el('div', 'hbars');
    rows.forEach(function (x) {
      var row = el('div', 'hbar' + (x.me ? ' me' : '')), track = el('span', 'track'), bar = el('i');
      bar.style.width = Math.max(2, Math.round((x.v / max) * 100)) + '%';
      track.appendChild(bar);
      row.appendChild(el('em', '', x.nom)); row.appendChild(track); row.appendChild(el('b', '', nf.format(x.v)));
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
    $('c-rivaux-note').textContent = 'Plus une marque est cherchée par son nom, plus elle capte de clics sans payer. La liste complète est dans le rapport.';
  }

  // ---------- Blocs verrouillés ----------

  function lockTag(n, label) {
    return el('span', 'lock-tag', n > 0 ? '+ ' + n + ' ' + label + ' · rapport complet' : 'Rapport complet');
  }

  function rankList(ol, items, opts) {
    ol.innerHTML = '';
    if (!items.length) { var e = el('li', 'more-row', opts.empty); e.style.gridTemplateColumns = '1fr'; ol.appendChild(e); return; }
    var max = items[0].value || 1;
    (unlocked ? items : items.slice(0, VISIBLE)).forEach(function (it) {
      var li = el('li');
      li.appendChild(el('b', '', it.name));
      li.appendChild(el('small', '', it.label));
      if (opts.bars) { var bar = el('i'); bar.style.width = Math.max(6, Math.round((it.value / max) * 100)) + '%'; li.appendChild(bar); }
      ol.appendChild(li);
    });
    if (unlocked) return;
    var hidden = Math.max(0, items.length - VISIBLE);
    for (var i = 0; i < Math.min(hidden || 2, opts.ghosts || 3); i++) {
      var g = el('li', 'locked');
      g.appendChild(el('b', '', fake(10 + (i * 5) % 8)));
      g.appendChild(el('small', '', fake(6)));
      ol.appendChild(g);
    }
    var t = el('li', 'more-row lock-line'); t.style.gridTemplateColumns = '1fr';
    t.appendChild(lockTag(hidden, opts.unit)); ol.appendChild(t);
  }

  function badge(level) {
    var cls = { 'Faible': 'b-faible', 'Moyenne': 'b-moyenne', 'Élevée': 'b-elevee' }[level] || '';
    return el('span', 'badge ' + cls, level);
  }
  function cpcText(k) { return k.cpcBas !== null ? money(k.cpcBas) + ' – ' + money(k.cpcHaut) : '—'; }

  function renderKeywords(list) {
    var tb = $('r-kw'); tb.innerHTML = '';
    (unlocked ? list : list.slice(0, VISIBLE)).forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', '', k.mot));
      tr.appendChild(el('td', '', nf.format(k.volume)));
      tr.appendChild(el('td', '', cpcText(k)));
      var td = el('td'); td.appendChild(badge(k.concurrence)); tr.appendChild(td);
      tb.appendChild(tr);
    });
    if (!unlocked) {
      var hidden = Math.max(0, list.length - VISIBLE);
      for (var i = 0; i < Math.min(hidden, 4); i++) {
        var tr = el('tr', 'locked');
        [14 + (i * 3) % 6, 5, 12, 7].forEach(function (n) { tr.appendChild(el('td', '', fake(n))); });
        tb.appendChild(tr);
      }
      var trTag = el('tr'), tdTag = el('td'); tdTag.colSpan = 4; tdTag.className = 'lock-line';
      tdTag.appendChild(lockTag(hidden, 'mots-clés')); trTag.appendChild(tdTag); tb.appendChild(trTag);
    }
    var top = list.filter(function (k) { return k.cpcBas !== null; })[0];
    $('r-hook').textContent = top
      ? '« ' + top.mot + ' » : ' + nf.format(top.volume) + ' recherches par mois, et un clic vaut ' + cpcText(top) + '.'
      : 'Ce que vos clients tapent sur Google';
  }

  function renderScenarios(list) {
    var box = $('r-scen'); box.innerHTML = '';
    var NOMS = ['Démarrage', 'Croissance', 'Accélération'];
    var mid = list.length > 1 ? 1 : 0;
    list.forEach(function (sc, i) {
      var visible = unlocked || i === mid;
      var card = el('div', 'card scen ' + (i === mid ? 'card-dark' : 'card-muted') + (visible ? '' : ' scen-locked'));
      var inner = el('div', 'inner');
      inner.appendChild(el('span', 'scen-tag', NOMS[i] || 'Scénario'));
      inner.appendChild(el('span', 'amount', visible ? money(sc.budget) + ' / mois' : fake(8)));
      var dl = el('dl');
      [['Clics estimés', visible ? nf.format(sc.clics) : fake(4)],
       ['Impressions', visible ? nf.format(sc.impressions) : fake(5)],
       ['Coût par clic moyen', visible ? money(sc.cpc) : fake(5)],
       ['Dépense réelle prévue', visible ? money(sc.cout) : fake(5)]].forEach(function (p) {
        dl.appendChild(el('dt', '', p[0])); dl.appendChild(el('dd', '', p[1]));
      });
      inner.appendChild(dl);
      card.appendChild(inner);
      if (!visible) card.appendChild(lockTag(0));
      box.appendChild(card);
    });
    var g = list[mid];
    $('r-scen-note').textContent = g && g.source === 'google'
      ? 'Prévisions Google Ads sur les 30 prochains jours, stratégie « Maximiser les clics », sur vos 20 mots-clés principaux.'
      : 'Estimation à partir du coût par clic moyen de votre secteur.';
    if (g) {
      $('r-clics').textContent = nf.format(g.clics);
      $('r-clics-sub').textContent = 'avec ' + money(g.budget) + ' par mois';
    }
  }

  function render() {
    var a = data.apercu, r = data.rapport, gr = data.graphes || {};
    renderMetier();
    $('r-site').textContent = data.site;
    $('r-title').textContent = 'Le marché de votre secteur : ' + data.site;
    $('r-vol').textContent = nf.format(a.recherchesMois);
    $('r-cpc').textContent = money(a.cpcMoyen);
    $('r-comp').textContent = a.concurrence;
    $('r-comp-sub').textContent = 'indice ' + a.concurrenceIndice + ' / 100 sur ces recherches';

    seasonChart($('c-season'), r.saisonnalite, r.moisFort, r.moisFaible);
    $('r-season-note').textContent = 'Pic en ' + r.moisFort.replace(/\.$/, '') + ', creux en ' + r.moisFaible.replace(/\.$/, '') + '. Le budget doit suivre cette courbe.';
    var intents = gr.intentions || [];
    donut($('c-intent'), intents, intents.length ? intents[0].part + ' %' : '', intents.length ? 'principale' : '');
    renderRivaux(r);

    renderScenarios(data.scenarios || []);
    renderKeywords(r.motsCles);

    var comps = r.concurrents || [];
    $('r-comp-title').textContent = comps.length ? 'Qui capte les recherches de votre secteur' : 'Aucun concurrent ne domine';
    rankList($('r-comp-list'), comps.map(function (c) { return { name: c.nom, value: c.recherches, label: nf.format(c.recherches) + '/mois' }; }),
      { bars: true, unit: 'concurrents', empty: "Personne n'a imposé son nom dans vos recherches : le terrain est libre." });
    $('r-comp-note').textContent = comps.length ? 'Recherches mensuelles sur leur nom au Québec.' : '';
    rankList($('r-reg'), (data.regions || []).map(function (g) { return { name: g.ville, value: g.recherches, label: nf.format(g.recherches) + '/mois' }; }),
      { bars: true, unit: 'villes', empty: 'Répartition par ville disponible lors de l’appel.' });
    rankList($('r-opp'), (r.opportunites || []).map(function (k) { return { name: k.mot, value: k.volume, label: nf.format(k.volume) + '/mois · ' + (k.cpcBas !== null ? money(k.cpcBas) : '—') }; }),
      { bars: false, unit: 'opportunités', ghosts: 4, empty: 'Pas d’opportunité peu disputée repérée : votre secteur est très concurrentiel.' });

    var f = $('lead-form').elements;
    f.namedItem('site').value = data.site; f.namedItem('score').value = a.score;
    f.namedItem('recherches').value = a.recherchesMois; f.namedItem('cpc').value = a.cpcMoyen;
    f.namedItem('concurrence').value = a.concurrence;
    f.namedItem('metier').value = (data.metier || []).slice(0, 6).join(', ');
  }

  $('lead-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var lf = e.target, le = $('lead-error');
    showError(le, '');
    if (!lf.checkValidity()) { lf.reportValidity(); return; }
    var btn = lf.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      var r = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(lf)).toString() });
      if (!r.ok) throw new Error();
      unlocked = true;
      $('unlock-fab').hidden = true;
      render();
      var rm = data.rapport.recherchesMarque;
      $('r-brand').textContent = rm > 0
        ? 'Votre nom est déjà cherché environ ' + nf.format(rm) + ' fois par mois : protégez-le avec une campagne de marque.'
        : "Votre nom d'entreprise est encore peu cherché sur Google : la pub peut accélérer votre notoriété.";
      $('unlock').classList.add('done');
      $('report').hidden = false;
      $('r-scen').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      showError(le, "L'envoi n'a pas fonctionné. Vérifiez votre courriel et réessayez.");
    } finally { btn.disabled = false; }
  });

  // Le bouton flottant s'efface quand la carte de déblocage est à l'écran.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { $('unlock-fab').style.visibility = en[0].isIntersecting ? 'hidden' : ''; })
      .observe($('unlock'));
  }

  $('unlock-fab').addEventListener('click', function () {
    $('unlock').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () { $('lead-email').focus({ preventScroll: true }); }, 500);
  });

  $('restart').addEventListener('click', function () {
    result.hidden = true; $('unlock-fab').hidden = true; input.value = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); input.focus();
  });

  var q = new URLSearchParams(location.search).get('site');
  if (q) input.value = q;
})();
