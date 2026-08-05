/* GRMC shared app navigation.
 *
 * Every app ships the same header shell: the wordmark links home to the hub,
 * and an "Apps" switcher lets you jump straight between apps without going
 * back through the dashboard. Include it after the app's own <header>:
 *
 *   <script src="/assets/grmc-nav.js"></script>
 *
 * The app list comes from the hub's registry so a newly-registered app appears
 * everywhere at once; FALLBACK_APPS keeps the switcher useful if the hub is
 * unreachable.
 */
(function () {
  var FALLBACK_APPS = [
    { slug: 'social-posts',    name: 'Social Posts',    subdomain: 'social',    icon: '📣' },
    { slug: 'approvals',       name: 'Approvals',       subdomain: 'approvals', icon: '✅' },
    { slug: 'meeting-minutes', name: 'Meeting Minutes', subdomain: 'minutes',   icon: '📝' },
    { slug: 'whoami',          name: 'Who Am I',        subdomain: 'whoami',    icon: '👤' }
  ];

  // Apps always live at <subdomain>.<baseDomain>, so the base domain is just
  // this host minus its first label.
  var labels = location.hostname.split('.');
  var currentSub = labels.length > 1 ? labels[0] : '';
  var baseDomain = labels.length > 1 ? labels.slice(1).join('.') : '';
  var hubUrl = baseDomain ? location.protocol + '//hub.' + baseDomain : '';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function appUrl(a) {
    return a.url || (baseDomain ? location.protocol + '//' + a.subdomain + '.' + baseDomain + '/' : '#');
  }

  function linkLogoHome(header) {
    var logo = header.querySelector('.logo');
    if (!logo || !hubUrl || logo.closest('a')) return;
    var a = el('a', 'logo-link');
    a.href = hubUrl + '/';
    a.title = 'All GRMC apps';
    logo.parentNode.insertBefore(a, logo);
    a.appendChild(logo);
  }

  function buildMenu(nav, apps) {
    var menu = nav.querySelector('.appnav-menu');
    menu.innerHTML = '';

    var home = el('a', 'appnav-item appnav-home');
    home.href = hubUrl ? hubUrl + '/' : '#';
    home.appendChild(el('span', 'appnav-icon', '🏠'));
    home.appendChild(el('span', null, 'All apps'));
    menu.appendChild(home);
    menu.appendChild(el('div', 'appnav-sep'));

    apps.forEach(function (a) {
      var isCurrent = a.subdomain === currentSub;
      var item = el('a', 'appnav-item' + (isCurrent ? ' is-current' : ''));
      item.href = appUrl(a);
      item.appendChild(el('span', 'appnav-icon', a.icon || '📦'));
      item.appendChild(el('span', null, a.name));
      if (isCurrent) item.appendChild(el('span', 'appnav-here', 'Current'));
      menu.appendChild(item);
    });

    if (hubUrl) {
      menu.appendChild(el('div', 'appnav-sep'));
      var out = el('a', 'appnav-item');
      out.href = hubUrl + '/auth/logout';
      out.appendChild(el('span', 'appnav-icon', '↩'));
      out.appendChild(el('span', null, 'Sign out'));
      menu.appendChild(out);
    }
  }

  function buildSwitcher(header) {
    var right = header.querySelector('.hright');
    if (!right) {
      right = el('div', 'hright');
      header.appendChild(right);
    }

    // A user chip, unless the app already renders its own.
    if (!document.getElementById('me-label')) {
      var me = el('span', 'hlabel appnav-me');
      me.id = 'me-label';
      right.appendChild(me);
    }

    var nav = el('div', 'appnav');
    var toggle = el('button', 'btn-hdr appnav-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span class="appnav-bars" aria-hidden="true"></span>Apps';
    nav.appendChild(toggle);
    nav.appendChild(el('div', 'appnav-menu'));
    right.appendChild(nav);

    function close() { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) { if (!nav.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    return nav;
  }

  function loadApps(nav) {
    buildMenu(nav, FALLBACK_APPS);
    if (!hubUrl) return;
    fetch(hubUrl + '/api/apps', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.ok && data.apps && data.apps.length) buildMenu(nav, data.apps);
      })
      .catch(function () { /* the fallback list is already rendered */ });
  }

  function fillUser() {
    var label = document.getElementById('me-label');
    if (!label || label.textContent.trim()) return;
    fetch('/api/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { if (m) label.textContent = m.name || m.email || ''; })
      .catch(function () { /* identity is cosmetic here */ });
  }

  function init() {
    var header = document.querySelector('header');
    if (!header) return;
    linkLogoHome(header);
    loadApps(buildSwitcher(header));
    fillUser();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
