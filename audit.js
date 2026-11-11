// Expert 360 — outil d'audit Google Ads (page /audit-google-ads)
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('audit-form'), input = $('audit-url'), err = $('audit-error');
  var progress = $('audit-progress'), result = $('audit-result');
  var data = null;
  var nf = new Intl.NumberFormat('fr-CA');
  var money = function (v) { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: v < 100 ? 2 : 0 }).format(v); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

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
    result.hidden = true; $('report').hidden = true; $('gate').hidden = false;
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
      renderPreview();
    } catch (ex) {
      progress.hidden = true;
      showError(err, ex.message || "L'analyse n'a pas pu aboutir. Réessayez dans un instant.");
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { btn.disabled = false; }
  });

  function renderPreview() {
    var a = data.apercu;
    $('r-site').textContent = data.site;
    $('r-title').textContent = a.scoreLabel + ' pour ' + data.site;
    $('r-label').textContent = a.scoreLabel;
    $('r-vol').textContent = nf.format(a.recherchesMois);
    $('r-cpc').textContent = money(a.cpcMoyen);
    $('r-comp').textContent = a.concurrence;
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var arc = $('g-arc'), sc = $('r-score'), target = a.score, n = 0;
    arc.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.65,0,.35,1)';
    requestAnimationFrame(function () { arc.style.strokeDashoffset = String(327 * (1 - target / 100)); });
    (function count() { n = Math.min(target, n + 2); sc.textContent = n; if (n < target) requestAnimationFrame(count); })();
    var lf = $('lead-form');
    lf.site.value = data.site; lf.score.value = a.score; lf.recherches.value = a.recherchesMois;
    lf.cpc.value = a.cpcMoyen; lf.concurrence.value = a.concurrence;
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
      renderReport();
    } catch (ex) {
      showError(le, "L'envoi n'a pas fonctionné. Vérifiez votre connexion et réessayez.");
    } finally { btn.disabled = false; }
  });

  function cell(text) { var td = document.createElement('td'); td.textContent = text; return td; }

  function renderReport() {
    var r = data.rapport;
    $('gate').hidden = true;
    var rep = $('report'); rep.hidden = false;
    $('r-peak').textContent = r.moisFort;
    var max = Math.max.apply(null, r.saisonnalite.map(function (m) { return m.recherches; })) || 1;
    var s = $('r-season'); s.innerHTML = '';
    s.setAttribute('aria-label', 'Recherches par mois, plus fort en ' + r.moisFort + ', plus faible en ' + r.moisFaible);
    r.saisonnalite.forEach(function (m) {
      var col = document.createElement('div'); col.className = 'sbar' + (m.mois === r.moisFort ? ' peak' : '');
      var b = document.createElement('i'); b.style.height = Math.max(4, Math.round((m.recherches / max) * 100)) + '%';
      b.title = m.mois + ' : ' + nf.format(m.recherches) + ' recherches';
      var l = document.createElement('span'); l.textContent = m.mois;
      col.appendChild(b); col.appendChild(l); s.appendChild(col);
    });
    $('r-season-note').textContent = 'Mois le plus faible : ' + r.moisFaible + '. Le budget doit suivre cette courbe.';
    $('r-budget').textContent = money(r.budgetIndicatif);
    $('r-budget-note').textContent = 'Pour environ ' + nf.format(r.clicsEstimes) + ' clics par mois au coût moyen de votre secteur. À ajuster selon vos objectifs et vos marges.';
    $('r-brand').textContent = r.recherchesMarque > 0 ? ('Votre nom est déjà cherché environ ' + nf.format(r.recherchesMarque) + ' fois par mois.') : "Votre nom d'entreprise est encore peu cherché sur Google : la pub peut accélérer votre notoriété.";
    var tb = $('r-kw'); tb.innerHTML = '';
    r.motsCles.forEach(function (k) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(k.mot));
      tr.appendChild(cell(nf.format(k.volume)));
      tr.appendChild(cell(k.cpcBas !== null ? money(k.cpcBas) + ' – ' + money(k.cpcHaut) : '—'));
      tr.appendChild(cell(k.concurrence));
      tb.appendChild(tr);
    });
    var o = $('r-opp'); o.innerHTML = '';
    if (r.opportunites.length) {
      r.opportunites.forEach(function (k) { var c = document.createElement('span'); c.className = 'chip'; c.textContent = k.mot + ' · ' + nf.format(k.volume) + '/mois'; o.appendChild(c); });
    } else { $('opp-card').hidden = true; }
    rep.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('restart').addEventListener('click', function () {
    result.hidden = true; input.value = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); input.focus();
  });

  var q = new URLSearchParams(location.search).get('site');
  if (q) input.value = q;
})();
