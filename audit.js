// Expert 360 — outil d'audit Google Ads (page /audit-google-ads)
// Aperçu : 3 éléments visibles par bloc, le reste flouté. Le courriel débloque le rapport complet.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('audit-form'), input = $('audit-url'), err = $('audit-error');
  var progress = $('audit-progress'), result = $('audit-result');
  var data = null, unlocked = false, VISIBLE = 3;
  var nf = new Intl.NumberFormat('fr-CA');
  var money = function (v) { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: v < 100 ? 2 : 0 }).format(v); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // Texte de remplacement pour les lignes floutées : la vraie donnée n'est pas dans la page avant le déblocage.
  var fake = function (n) { return '■■■■■■■■■■■■■■■■■■'.slice(0, n); };

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
        setTimeout(next, 900);
      })();
    });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    showError(err, '');
    var url = input.value.trim();
    if (!url || url.indexOf('.') === -1) { showError(err, 'Entrez une adresse valide, par exemple : votresite.ca'); input.focus(); return; }
    var btn = form.querySelector('button'); btn.disabled = true;
    result.hidden = true; $('report').hidden = true; unlocked = false; $('unlock').classList.remove('done');
    $('p-site').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    progress.hidden = false;
    progress.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      var call = fetch('/api/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
      var res = (await Promise.all([call, animateSteps()]))[0];
      if (!res.ok) throw new Error(res.j.error || 'Erreur');
      if (res.j.empty) throw new Error(res.j.message);
      data = res.j;
      await wait(300);
      progress.hidden = true;
      render();
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
      animateScore(data.apercu.score);
    } catch (ex) {
      progress.hidden = true;
      showError(err, ex.message || "L'analyse n'a pas pu aboutir. Réessayez dans un instant.");
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { btn.disabled = false; }
  });

  function animateScore(target) {
    var arc = $('g-arc'), sc = $('r-score'), t0 = Date.now();
    arc.style.transition = 'none'; arc.style.strokeDashoffset = '327';
    setTimeout(function () {
      arc.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.65,0,.35,1)';
      arc.style.strokeDashoffset = String(327 * (1 - target / 100));
    }, 60);
    var timer = setInterval(function () {
      var n = Math.round(target * Math.min(1, (Date.now() - t0) / 1200));
      sc.textContent = n;
      if (n >= target) clearInterval(timer);
    }, 30);
  }

  function lockTag(n, label) {
    var t = el('span', 'lock-tag', n > 0 ? '+ ' + n + ' ' + label + ' · rapport complet' : 'Rapport complet');
    return t;
  }

  // Liste classée : nom, valeur, barre. Les éléments au-delà de VISIBLE sont floutés tant que ce n'est pas débloqué.
  function rankList(ol, items, opts) {
    ol.innerHTML = '';
    var max = items.length ? (items[0].value || 1) : 1;
    var shown = unlocked ? items : items.slice(0, VISIBLE);
    shown.forEach(function (it) {
      var li = el('li');
      li.appendChild(el('b', '', it.name));
      li.appendChild(el('small', '', it.label));
      if (opts.bars) { var bar = el('i'); bar.style.width = Math.max(6, Math.round((it.value / max) * 100)) + '%'; li.appendChild(bar); }
      ol.appendChild(li);
    });
    if (!unlocked && items.length) {
      var hidden = Math.max(0, items.length - VISIBLE);
      var ghosts = Math.min(hidden || 2, 3);
      for (var i = 0; i < ghosts; i++) {
        var li = el('li', 'locked');
        li.appendChild(el('b', '', fake(10 + (i * 5) % 8)));
        li.appendChild(el('small', '', fake(6)));
        ol.appendChild(li);
      }
      var tagLi = el('li', 'more-row lock-line'); tagLi.style.gridTemplateColumns = '1fr';
      tagLi.appendChild(lockTag(hidden, opts.unit));
      ol.appendChild(tagLi);
    }
    if (!items.length) {
      var empty = el('li', 'more-row', opts.empty); empty.style.gridTemplateColumns = '1fr'; ol.appendChild(empty);
    }
  }

  function badge(level) {
    var cls = { 'Faible': 'b-faible', 'Moyenne': 'b-moyenne', 'Élevée': 'b-elevee' }[level] || '';
    return el('span', 'badge ' + cls, level);
  }
  function cpcText(k) { return k.cpcBas !== null ? money(k.cpcBas) + ' – ' + money(k.cpcHaut) : '—'; }

  function renderKeywords(list) {
    var tb = $('r-kw'); tb.innerHTML = '';
    var shown = unlocked ? list : list.slice(0, VISIBLE);
    shown.forEach(function (k) {
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
        tr.appendChild(el('td', '', fake(14 + (i * 3) % 6)));
        tr.appendChild(el('td', '', fake(5)));
        tr.appendChild(el('td', '', fake(12)));
        tr.appendChild(el('td', '', fake(7)));
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

  function renderSeason(r) {
    var s = $('r-season'); s.innerHTML = '';
    var max = Math.max.apply(null, r.saisonnalite.map(function (m) { return m.recherches; })) || 1;
    r.saisonnalite.forEach(function (m) {
      var col = el('div', 'sbar' + (unlocked && m.mois === r.moisFort ? ' peak' : ''));
      var b = el('i');
      // Avant déblocage : barres de forme neutre (la vraie courbe n'est pas révélée).
      b.style.height = (unlocked ? Math.max(4, Math.round((m.recherches / max) * 100)) : 40 + ((m.mois.length * 13) % 45)) + '%';
      col.appendChild(b);
      col.appendChild(el('span', '', window.innerWidth < 600 ? m.mois.charAt(0).toUpperCase() : m.mois));
      s.appendChild(col);
    });
    s.classList.toggle('locked', !unlocked);
    document.querySelector('.lock-season').hidden = unlocked;
    $('r-season-note').textContent = unlocked
      ? 'Mois le plus fort : ' + r.moisFort + '. Mois le plus faible : ' + r.moisFaible + '. Le budget doit suivre cette courbe.'
      : 'Vos mois forts et faibles sont dans le rapport complet.';
  }

  function render() {
    var a = data.apercu, r = data.rapport;
    $('r-site').textContent = data.site;
    $('r-title').textContent = a.scoreLabel + ' pour ' + data.site;
    $('r-label').textContent = a.scoreLabel;
    $('r-vol').textContent = nf.format(a.recherchesMois);
    $('r-cpc').textContent = money(a.cpcMoyen);
    $('r-comp').textContent = a.concurrence;

    renderKeywords(r.motsCles);

    var comps = r.concurrents || [];
    $('r-comp-title').textContent = comps.length ? 'Qui capte les recherches de votre secteur' : 'Aucun concurrent ne domine';
    rankList($('r-comp-list'), comps.map(function (c) { return { name: c.nom, value: c.recherches, label: nf.format(c.recherches) + '/mois' }; }),
      { bars: true, unit: 'concurrents', empty: "Personne n'a imposé son nom dans vos recherches : le terrain est libre." });
    $('r-comp-note').textContent = comps.length ? 'Recherches mensuelles sur leur nom au Québec.' : '';

    var regs = data.regions || [];
    rankList($('r-reg'), regs.map(function (g) { return { name: g.ville, value: g.recherches, label: nf.format(g.recherches) + '/mois' }; }),
      { bars: true, unit: 'villes', empty: 'Répartition par ville disponible dans le rapport complet.' });

    var opps = r.opportunites || [];
    rankList($('r-opp'), opps.map(function (k) { return { name: k.mot, value: k.volume, label: nf.format(k.volume) + '/mois · ' + (k.cpcBas !== null ? money(k.cpcBas) : '—') }; }),
      { bars: false, unit: 'opportunités', empty: 'Pas d’opportunité peu disputée repérée : votre secteur est très concurrentiel.' });

    renderSeason(r);

    var f = $('lead-form').elements;
    f.namedItem('site').value = data.site; f.namedItem('score').value = a.score;
    f.namedItem('recherches').value = a.recherchesMois; f.namedItem('cpc').value = a.cpcMoyen;
    f.namedItem('concurrence').value = a.concurrence;
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
      render();
      renderReportExtras();
      $('unlock').classList.add('done');
      $('report').hidden = false;
      document.querySelector('.insight-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      showError(le, "L'envoi n'a pas fonctionné. Vérifiez votre courriel et réessayez.");
    } finally { btn.disabled = false; }
  });

  function renderReportExtras() {
    var r = data.rapport;
    $('r-budget').textContent = money(r.budgetIndicatif);
    $('r-budget-note').textContent = 'Pour environ ' + nf.format(r.clicsEstimes) + ' clics par mois au coût moyen de votre secteur. À ajuster selon vos objectifs et vos marges.';
    $('r-brand').textContent = r.recherchesMarque > 0
      ? ('Votre nom est déjà cherché environ ' + nf.format(r.recherchesMarque) + ' fois par mois.')
      : "Votre nom d'entreprise est encore peu cherché sur Google : la pub peut accélérer votre notoriété.";
  }

  $('restart').addEventListener('click', function () {
    result.hidden = true; input.value = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); input.focus();
  });

  var q = new URLSearchParams(location.search).get('site');
  if (q) input.value = q;
})();
