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
  var IA = /[?&]ia=1\b/.test(location.search);

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
      // Version avec Claude (?ia=1) : comprendre le métier d'abord, puis guider Keyword Planner.
      var profil = null;
      if (IA && !metier) {
        try { var c = await post('/api/comprendre', { url: url }); if (c.ok && c.j.profil) profil = c.j.profil; } catch (e) {}
      }
      var out = await Promise.all([post('/api/analyse', { url: url, metier: metier, profil: profil }), animateSteps()]);
      var res = out[0];
      // Le tri IA a manqué de temps : on réessaie une fois plutôt que d'afficher un rapport dégradé.
      if (IA && profil && res.ok && res.j && !res.j.empty && !(res.j.ia && res.j.ia.tri)) {
        try { var res2 = await post('/api/analyse', { url: url, metier: metier, profil: profil }); if (res2.ok && res2.j && res2.j.ia && res2.j.ia.tri) res = res2; } catch (e) {}
      }
      if (!res.ok) throw new Error(res.j.error || 'Erreur');
      if (res.j.empty) throw new Error(res.j.message);
      data = res.j; redac = null; redacEnCours = false;
      // Phase de test (?ia=1) : le rapport s'affiche en entier, sans demander de courriel.
      var ouvert = Boolean(IA && data.ia && data.ia.tri);
      unlocked = ouvert;
      if (ouvert) $('unlock').classList.add('done');
      await wait(300);
      progress.hidden = true;
      render();
      result.hidden = false;
      $('unlock-fab').hidden = ouvert;
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
    if (data.ia && data.ia.profil) {
      var n = 'Analyse guidée par IA · ' + (data.ia.profil.metier || '');
      if (data.ia.tri) n += ' · ' + data.ia.rejetes + ' recherches hors sujet écartées';
      else n += ' · tri automatique indisponible';
      box.appendChild(el('span', 'metier-none', n));
    }
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

  // Les 10 recherches principales du métier, avec leur volume mensuel.
  function renderTopKw(list) {
    var box = $('c-topkw'); box.innerHTML = '';
    var rows = list.slice(0, 10);
    if (!rows.length) { box.appendChild(el('p', 'chart-empty', 'Pas assez de recherches pour ce métier.')); return; }
    var max = Math.max.apply(null, rows.map(function (k) { return k.volume; })) || 1;
    var wrap = el('div', 'hbars');
    var head = el('div', 'hbar hbar-head'); ['Recherche', '', 'Par mois', 'Concurrence'].forEach(function (t) { head.appendChild(el('span', '', t)); }); wrap.appendChild(head);
    rows.forEach(function (k) {
      var row = el('div', 'hbar'), track = el('span', 'track'), bar = el('i');
      bar.style.width = Math.max(2, Math.round((k.volume / max) * 100)) + '%';
      track.appendChild(bar);
      var nom = el('em', '', k.mot); if (k.langue === 'en') { var t = el('small', 'lang-tag', 'EN'); nom.appendChild(t); }
      row.appendChild(nom); row.appendChild(track); row.appendChild(el('b', '', nf.format(k.volume)));
      var bg = badge(k.concurrence); if (k.concurrence === 'Élevée') bg.textContent = 'Forte';
      var c = el('span', 'kw-comp'); c.appendChild(bg); row.appendChild(c);
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
    var modeIA = Boolean(data.ia && data.ia.tri);
    result.classList.toggle('mode-ia', modeIA);
    if (modeIA) {
      renderIA();
    }
    $('r-site').textContent = data.site;
    $('r-title').textContent = 'Le marché de votre secteur : ' + data.site;
    $('r-vol').textContent = nf.format(a.recherchesMois);
    var lg = a.langues || {};
    $('r-vol-sub').textContent = lg.en ? 'français ' + nf.format(lg.fr) + ' · anglais ' + nf.format(lg.en) : 'sur les mots-clés de votre secteur au Québec';
    $('c-topkw-note').textContent = lg.en
      ? 'Recherches mensuelles moyennes sur Google au Québec, en français et en anglais (EN).'
      : 'Recherches mensuelles moyennes sur Google au Québec. Aucune version anglaise du site trouvée : le marché anglophone n’est pas inclus.';
    $('r-cpc').textContent = money(a.cpcMoyen);
    $('r-comp').textContent = a.concurrence;
    $('r-comp-sub').textContent = 'indice ' + a.concurrenceIndice + ' / 100 sur ces recherches';

    seasonChart($('c-season'), r.saisonnalite, r.moisFort, r.moisFaible);
    $('r-season-note').textContent = 'Pic en ' + r.moisFort.replace(/\.$/, '') + ', creux en ' + r.moisFaible.replace(/\.$/, '') + '. Le budget doit suivre cette courbe.';
    renderRivaux(r);
    renderTopKw(r.motsCles || []);

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
    if (modeIA) $('r-title').textContent = 'Audit Google Ads : ' + data.site;
  }


  // ===== Rapport guidé par l'IA (?ia=1) : même structure que les audits manuels =====
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var redac = null, redacEnCours = false;
  function tag(c) { var k = c === 'Faible' ? 'f' : c === 'Moyenne' ? 'm' : 'e'; return '<span class="ria-tag ria-' + k + '">' + esc(c) + '</span>'; }
  function cpcR(k) { return k.cpcBas !== null && k.cpcBas !== undefined ? money(k.cpcBas) + ' – ' + money(k.cpcHaut) : '—'; }
  // Volume en fourchette : Google donne des moyennes arrondies, une fourchette est plus honnête qu'un chiffre précis.
  function sig2(n) { if (n < 100) return Math.round(n / 5) * 5; var d = Math.pow(10, Math.floor(Math.log10(n)) - 1); return Math.round(n / d) * d; }
  function fourch(n) {
    n = Number(n) || 0; if (n <= 0) return '0';
    var bas = sig2(n * 0.9), haut = sig2(n * 1.1); if (haut <= bas) haut = bas + (n < 100 ? 5 : 0);
    return nf.format(bas) + ' – ' + nf.format(haut);
  }
  function sec(n, titre, corps) { return '<h3 class="ria-h"><span>' + n + '</span>' + esc(titre) + '</h3>' + corps; }
  function verrou(titre) {
    return '<div class="ria-card ria-lock"><p>' + esc(titre) + '</p><p class="ria-blur">■■■■■■■■■■ ■■■■■■ ■■■■■■■■■■■■ ■■■■■■■ ■■■■■■■■■ ■■■■■■■■■■■■■■ ■■■■■ ■■■■■■■■■■</p>' +
      '<button type="button" class="btn btn-orange btn-sm ria-unlock">🔒 Débloquer avec votre courriel</button></div>';
  }
  function chiffresPourRedaction() {
    var r = data.rapport, ia = data.ia;
    return { total: data.apercu.recherchesMois, cpcMoyen: data.apercu.cpcMoyen, concurrence: data.apercu.concurrence, services: ia.services, motsCles: r.motsCles,
      ecartes: ia.ecartes, moisFort: r.moisFort, moisFaible: r.moisFaible, regions: data.regions, concurrents: r.concurrents, marque: r.recherchesMarque };
  }
  async function lancerRedaction() {
    if (redac || redacEnCours || !data || !data.ia) return;
    redacEnCours = true;
    try {
      var r = await post('/api/rediger', { profil: data.ia.profil, chiffres: chiffresPourRedaction(), site: data.site });
      redac = r.ok ? r.j : { erreur: true };
    } catch (e) { redac = { erreur: true }; }
    redacEnCours = false;
    renderIA();
  }
  function renderIA() {
    var box = $('rapport-ia'); if (!box || !data || !data.ia) return;
    var ia = data.ia, p = ia.profil, a = data.apercu, r = data.rapport, h = '';
    var services = ia.services || [], kws = r.motsCles || [];
    // 01 · Le métier
    var moitie = Math.ceil(p.services.length / 2);
    var liste = function (arr) { return '<ul>' + arr.map(function (x) { return '<li>' + esc(x.nom) + '</li>'; }).join('') + '</ul>'; };
    h += sec('01', 'Le métier', '<div class="ria-card"><p><b>Ce que ' + esc(p.entreprise || data.site) + ' vend :</b> ' + esc(p.metier) + (p.zone ? ', ' + esc(p.zone) : '') + '.</p>' +
      (p.clientele ? '<p class="ria-note">Clientèle : ' + esc(p.clientele) + '</p>' : '') +
      '<div class="ria-2col"><div>' + liste(p.services.slice(0, moitie)) + '</div><div>' + liste(p.services.slice(moitie)) + '</div></div>' +
      (p.atouts && p.atouts.length ? '<p class="ria-note"><b>Atouts à mettre en avant dans les annonces :</b> ' + esc(p.atouts.join(' · ')) + '</p>' : '') + '</div>');
    // 02 · Le marché
    var s0 = services[0];
    var aFort = services.some(function (x) { return x.volumeIntentionForte != null; });
    var totSv = services.reduce(function (t, x) { return t + x.volume; }, 0), fortSv = services.reduce(function (t, x) { return t + (x.volumeIntentionForte || 0); }, 0);
    if (aFort) s0 = services.slice().sort(function (x, y) { return (y.volumeIntentionForte || 0) - (x.volumeIntentionForte || 0); })[0];
    h += sec('02', 'Le marché sur Google', '<div class="ria-kpis">' +
      (aFort && fortSv > 0
        ? '<div class="ria-kpi"><b>' + fourch(fortSv) + '</b><small>recherches par mois où la personne veut engager un prestataire, sur ' + fourch(totSv) + ' liées aux services</small></div>'
        : '<div class="ria-kpi"><b>' + fourch(a.recherchesMois) + '</b><small>recherches par mois réellement liées aux services</small></div>') +
      (s0 ? '<div class="ria-kpi"><b>' + fourch(aFort ? (s0.volumeIntentionForte || 0) : s0.volume) + '</b><small>pour « ' + esc(s0.nom) + ' », ' + (aFort ? 'le plus gros volume à forte intention' : 'le plus gros volume') + '</small></div>' : '') +
      '<div class="ria-kpi"><b>' + money(a.cpcMoyen) + '</b><small>coût par clic moyen, concurrence ' + esc(a.concurrence.toLowerCase()) + '</small></div>' +
      '<div class="ria-kpi"><b>' + nf.format(r.recherchesMarque || 0) + '</b><small>recherches sur la marque</small></div></div>' +
      '<div class="ria-card"><table><tr><th>Service</th><th class="n">Recherches par mois</th>' + (aFort ? '<th class="n">Dont intention forte</th>' : '') + '<th class="ria-ex">Exemples de recherches</th></tr>' +
      services.map(function (x) { return '<tr><td><b>' + esc(x.nom) + '</b></td><td class="n">≈ ' + nf.format(x.volume) + '</td>' + (aFort ? '<td class="n"><b>≈ ' + nf.format(x.volumeIntentionForte || 0) + '</b></td>' : '') + '<td class="ria-note ria-ex">' + esc(x.recherches.join(', ')) + '</td></tr>'; }).join('') + '</table></div>' +
      (ia.ecartes && ia.ecartes.length ? '<div class="ria-callout"><b>Ce que l\'analyse du métier a écarté :</b> environ ' + nf.format(ia.volumeRejete) + ' recherches par mois proposées par Google n\'ont rien à voir avec les services, par exemple ' +
        ia.ecartes.slice(0, 4).map(function (k) { return '« ' + esc(k.mot) + ' » (' + nf.format(k.volume) + ')'; }).join(', ') + '. Une campagne qui les inclurait gaspillerait une partie du budget.</div>' : ''));
    // 03 · Les recherches principales
    var max = Math.max.apply(null, kws.map(function (k) { return k.volume; }).concat([1]));
    var vis = unlocked ? kws : kws.slice(0, 5);
    h += sec('03', 'Les recherches principales liées au métier', '<div class="ria-card"><table><tr><th>Recherche</th><th class="n">Volume</th><th class="ria-barcol"></th><th class="n">CPC (fourchette)</th><th>Concurrence</th></tr>' +
      vis.map(function (k) { return '<tr><td>' + esc(k.mot) + (k.langue === 'en' ? ' <span class="ria-en">EN</span>' : '') + '</td><td class="n">' + nf.format(k.volume) + '</td><td><div class="ria-bar" style="width:' + Math.max(2, Math.round(k.volume / max * 100)) + '%"></div></td><td class="n">' + cpcR(k) + '</td><td>' + tag(k.concurrence) + '</td></tr>'; }).join('') +
      (unlocked ? '' : kws.slice(5, 10).map(function () { return '<tr class="ria-blur"><td>■■■■■■■■■■■■</td><td class="n">■■■</td><td></td><td class="n">■■■■■</td><td>■■■■</td></tr>'; }).join('')) + '</table>' +
      (unlocked ? '' : '<p class="ria-note">' + (kws.length - 5) + ' autres recherches dans le rapport complet.</p>') + '</div>');
    // 04 · Saisonnalité et régions
    var ms = r.saisonnalite || [], mx = Math.max.apply(null, ms.map(function (m) { return m.recherches; }).concat([1]));
    var regs = (data.regions || []).slice(0, 6), rmax = regs.length ? regs[0].recherches : 1;
    h += sec('04', 'Saisonnalité et régions', '<div class="ria-card"><b>Recherches liées aux services, par mois</b><div class="ria-chart">' +
      ms.map(function (m) { var v = m.recherches; return '<div><em>' + (v >= 1000 ? (Math.round(v / 100) / 10).toString().replace('.', ',') + 'k' : v) + '</em><i' + (v >= mx * 0.75 ? ' class="hi"' : '') + ' style="height:' + Math.max(3, Math.round(v / mx * 100)) + '%"></i>' + esc(m.mois) + '</div>'; }).join('') +
      '</div><p class="ria-note">Pic en ' + esc(r.moisFort.replace(/\.$/, '')) + ', creux en ' + esc(r.moisFaible.replace(/\.$/, '')) + '. Le budget doit suivre cette courbe.</p></div>' +
      (regs.length ? '<div class="ria-card"><b>Où ça cherche</b><table>' + regs.map(function (g) { return '<tr><td>' + esc(g.ville) + '</td><td class="n">' + nf.format(g.recherches) + '</td><td style="width:55%"><div class="ria-bar" style="width:' + Math.max(3, Math.round(g.recherches / rmax * 100)) + '%"></div></td></tr>'; }).join('') + '</table></div>' : ''));
    // 05 à 08 : rapport complet
    if (!unlocked) {
      h += sec('05', 'Concurrents', verrou('Qui capte les recherches de votre secteur, et sur quels mots-clés.'));
      h += sec('06', 'Ce que je remarque', verrou('Les observations et recommandations pour votre compte.'));
      h += sec('07', 'Budget indicatif', verrou('Le budget conseillé par campagne, avec l’ajustement saisonnier.'));
    } else {
      var cs = r.concurrents || [];
      h += sec('05', 'Concurrents', '<div class="ria-card">' + (cs.length ? '<table><tr><th>Concurrent</th><th>Recherche principale</th><th class="n">Recherches par mois</th></tr>' +
        cs.map(function (c) { return '<tr><td><b>' + esc(c.nom) + '</b></td><td>' + esc(c.motCle) + '</td><td class="n">' + nf.format(c.recherches) + '</td></tr>'; }).join('') + '</table>' : '<p>Aucun concurrent n’a imposé son nom dans les recherches du secteur : le terrain est ouvert.</p>') +
        (p.concurrents_attendus ? '<p class="ria-note">Concurrents directs à surveiller : ' + esc(p.concurrents_attendus) + '. Leurs annonces actives se vérifient dans le Centre de transparence des annonces de Google.</p>' : '') + '</div>');
      if (!redac) {
        h += sec('06', 'Ce que je remarque', '<div class="ria-card"><p class="ria-note">Rédaction des recommandations en cours…</p></div>');
        h += sec('07', 'Budget indicatif', '<div class="ria-card"><p class="ria-note">Calcul en cours…</p></div>');
      } else if (redac.erreur) {
        h += sec('06', 'Ce que je remarque', '<div class="ria-card"><p class="ria-note">Les recommandations n’ont pas pu être rédigées. Réservez un appel : on vous les présente de vive voix.</p></div>');
      } else {
        h += sec('06', 'Ce que je remarque', '<div class="ria-card"><ul>' + redac.observations.map(function (o) { return '<li><b>' + esc(o.titre) + '</b> ' + esc(o.texte) + '</li>'; }).join('') +
          (redac.negatifs.length ? '<li><b>Mots-clés négatifs dès le départ :</b> ' + esc(redac.negatifs.join(', ')) + '.</li>' : '') + '</ul></div>');
        var tmin = 0, tmax = 0; redac.budget.forEach(function (b) { tmin += b.min; tmax += b.max; });
        h += sec('07', 'Budget indicatif', '<div class="ria-card"><table><tr><th>Campagne</th><th class="n">Budget par mois</th><th>Ajustement saisonnier</th></tr>' +
          redac.budget.map(function (b) { return '<tr><td>' + esc(b.campagne) + '</td><td class="n">' + nf.format(b.min) + ' – ' + nf.format(b.max) + ' $</td><td>' + esc(b.saison) + '</td></tr>'; }).join('') +
          '<tr><td><b>Total</b></td><td class="n"><b>≈ ' + nf.format(tmin) + ' – ' + nf.format(tmax) + ' $</b></td><td></td></tr></table>' +
          (redac.budget_note ? '<p class="ria-note">' + esc(redac.budget_note) + '</p>' : '') + '</div>');
      }
    }
    // 08 · Méthode et limites
    var en = (a.langues || {}).en;
    var memo = data.cache ? ' Analyse du ' + new Date(data.cache).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' }) + ', conservée 30 jours pour que les résultats restent comparables.' : '';
    h += sec('08', 'Méthode et limites', '<div class="ria-card ria-note"><p><b>Zone et langues :</b> Québec, ' + esc(data.langue || 'français') + '.' + memo + '</p><p><b>Méthode :</b> le site a été lu pour comprendre le métier et les services. Google Keyword Planner a ensuite été interrogé service par service (compte gestionnaire Expert 360), et seules les recherches liées aux services ont été gardées.</p>' +
      '<p><b>Limites :</b> les volumes sont des moyennes arrondies de Google sur 12 mois, au Québec. Les coûts par clic sont des fourchettes pour une annonce en haut de page. ' + (en ? 'Les recherches en anglais sont incluses. ' : 'Les recherches en anglais ne sont pas incluses. ') + 'L’historique Google Ads de l’entreprise, s’il existe, n’a pas été consulté. Les budgets sont des estimations à valider avec les vraies données de conversion.</p></div>');
    h += '<p class="ria-foot">Préparé par Expert 360 · expert-360.ca</p>';
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll('.ria-unlock'), function (b) { b.addEventListener('click', function () { $('unlock-fab').click(); }); });
    if (unlocked) lancerRedaction();
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
      ((data.ia && data.ia.tri) ? $('rapport-ia') : $('r-scen')).scrollIntoView({ behavior: 'smooth', block: 'start' });
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
