// Expert 360 — menu mobile et animations au défilement
(function () {
  var btn = document.querySelector('.menu-toggle');
  var menu = document.getElementById('menu-mobile');
  if (btn && menu) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      btn.setAttribute('aria-label', open ? 'Ouvrir le menu' : 'Fermer le menu');
      menu.hidden = open;
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    });
  }

  // Cartes de couleur : se remplissent quand la section est visible, se vident en la quittant
  var watched = document.querySelectorAll('[data-fill-on-view]');
  if (!watched.length) return;
  if (!('IntersectionObserver' in window)) {
    watched.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      e.target.classList.toggle('in', e.isIntersecting && e.intersectionRatio >= 0.25);
    });
  }, { threshold: [0, 0.25] });
  watched.forEach(function (el) { io.observe(el); });
})();
