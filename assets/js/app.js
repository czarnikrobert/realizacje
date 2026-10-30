/* Polskie Gry Planszowe – galeria realizacji */
(() => {
  const IMG_FULL = 'images/produkty/';
  const IMG_THUMB = 'images/thumbs/';
  const CAT_COLORS = ['#19afef', '#f69318', '#009443', '#1f234a', '#e5484d', '#8e4ec6', '#12a594', '#d6409f', '#ffb224'];

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

  const state = { categories: [], products: [], catById: new Map(), filter: 'all', query: '' };

  let observer;
  const revealObserver = () => {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-in'); observer.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -40px 0px' });
    return observer;
  };

  /* ---------- Data ---------- */
  async function load() {
    const res = await fetch('data/products.json', { cache: 'no-cache' });
    const data = await res.json();
    state.categories = data.categories || [];
    state.categories.forEach((c, i) => state.catById.set(c.id, { ...c, color: CAT_COLORS[i % CAT_COLORS.length] }));
    state.products = (data.products || []).filter((p) => !p.hidden && p.images?.length);
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    const stage = $('#hero-stage');
    const featured = state.products.filter((p) => p.featured);
    const picks = (featured.length >= 3 ? featured : state.products).slice(0, 3);
    // cards go before the decorative cubes so that .hero-card:nth-child(1..3) positions apply
    [...picks].reverse().forEach((p) => {
      const fig = document.createElement('figure');
      fig.className = 'hero-card';
      fig.innerHTML = `<img src="${IMG_THUMB + esc(p.images[0])}" alt=""><figcaption>${esc(p.title)}</figcaption>`;
      fig.addEventListener('click', () => openProduct(p.id));
      stage.prepend(fig);
    });
    $('#stat-products').textContent = state.products.length;
    $('#stat-cats').textContent = state.categories.filter((c) => state.products.some((p) => p.categories?.includes(c.id))).length;
  }

  /* ---------- Filters ---------- */
  function renderFilters() {
    const counts = new Map();
    state.products.forEach((p) => (p.categories || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)));
    const chips = [{ id: 'all', name: 'Wszystkie', count: state.products.length }]
      .concat(state.categories.filter((c) => counts.get(c.id)).map((c) => ({ ...c, count: counts.get(c.id) })));
    const box = $('#filters');
    box.innerHTML = chips.map((c) => `
      <button class="chip" role="tab" data-cat="${esc(c.id)}" aria-selected="${c.id === state.filter}">
        ${esc(c.name)} <small>${c.count}</small>
      </button>`).join('');
    box.onclick = (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      state.filter = btn.dataset.cat;
      box.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-selected', b === btn));
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      renderGrid();
    };
    // on phones the row scrolls sideways – fade the right edge while more chips are hidden there
    const updateMore = () => box.classList.toggle('has-more', box.scrollLeft + box.clientWidth < box.scrollWidth - 4);
    box.onscroll = updateMore;
    window.addEventListener('resize', updateMore);
    updateMore();
  }

  /* ---------- Grid ---------- */
  function visibleProducts() {
    const q = norm(state.query.trim());
    return state.products.filter((p) => {
      if (state.filter !== 'all' && !p.categories?.includes(state.filter)) return false;
      if (!q) return true;
      const catNames = (p.categories || []).map((c) => state.catById.get(c)?.name).join(' ');
      return norm(`${p.title} ${p.description} ${(p.tags || []).join(' ')} ${catNames}`).includes(q);
    });
  }

  function renderGrid() {
    const grid = $('#grid');
    const list = visibleProducts();
    const io = revealObserver();
    grid.innerHTML = list.map((p) => {
      const cat = state.catById.get(p.categories?.[0]);
      const n = p.images.length;
      return `
      <button class="card" data-id="${esc(p.id)}" aria-label="${esc(p.title)} – zobacz szczegóły">
        <div class="card__media">
          <img src="${IMG_THUMB + esc(p.images[0])}" alt="${esc(p.title)}" loading="lazy" decoding="async">
          ${n > 1 ? `<span class="card__count"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M21 7v12a2 2 0 0 1-2 2H7"/></svg>${n}</span>` : ''}
          <span class="card__more">Zobacz szczegóły →</span>
        </div>
        <div class="card__body">
          ${cat ? `<div class="card__cat"><i style="background:${cat.color}"></i>${esc(cat.name)}</div>` : ''}
          <h3 class="card__title">${esc(p.title)}</h3>
        </div>
      </button>`;
    }).join('');
    $('#empty').hidden = list.length > 0;
    grid.querySelectorAll('.card').forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i % 8, 7) * 50}ms`;
      io.observe(el);
      // after the entrance animation, drop the delay so hover reacts instantly
      el.addEventListener('transitionend', () => { el.style.transitionDelay = ''; }, { once: true });
    });
  }

  /* ---------- Modal ---------- */
  const modal = $('#modal');
  const m = { product: null, index: 0, lastFocus: null };

  function openProduct(id, { push = true } = {}) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    m.product = p;
    m.index = 0;
    m.lastFocus = document.activeElement;

    $('#m-cats').innerHTML = (p.categories || []).map((c) => state.catById.get(c)).filter(Boolean)
      .map((c) => `<span><i style="background:${c.color}"></i>${esc(c.name)}</span>`).join('');
    $('#m-title').textContent = p.title;
    $('#m-desc').innerHTML = String(p.description || '').split(/\n\s*\n/).filter(Boolean)
      .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('');
    $('#m-tags').innerHTML = (p.tags || []).map((t) => `<span>#${esc(t)}</span>`).join('');
    $('#m-ask').href = `mailto:biuro@polskiegryplanszowe.pl?subject=${encodeURIComponent('Zapytanie: ' + p.title)}&body=${encodeURIComponent(`Dzień dobry,\n\ninteresuje mnie produkt podobny do „${p.title}” (${location.href.split('#')[0]}#p/${p.id}).\n\nIlość: \nTermin: \n\nPozdrawiam`)}`;

    $('.viewer', modal).classList.toggle('is-single', p.images.length < 2);
    $('#m-thumbs').innerHTML = p.images.map((img, i) =>
      `<button data-i="${i}" aria-label="Zdjęcie ${i + 1}"><img src="${IMG_THUMB + esc(img)}" alt="" loading="lazy"></button>`).join('');
    showImage(0);

    modal.hidden = false;
    document.body.classList.add('is-locked');
    $('.modal__close', modal).focus({ preventScroll: true });
    if (push) history.pushState({ p: id }, '', `#p/${id}`);
  }

  function showImage(i) {
    const p = m.product;
    const n = p.images.length;
    m.index = (i + n) % n;
    const img = $('#m-img');
    const src = IMG_FULL + p.images[m.index];
    img.classList.add('is-loading');
    img.onload = () => img.classList.remove('is-loading');
    img.src = src;
    img.alt = `${p.title} – zdjęcie ${m.index + 1} z ${n}`;
    if (img.complete) img.classList.remove('is-loading');
    $('#m-count').textContent = `${m.index + 1} / ${n}`;
    $('#m-thumbs').querySelectorAll('button').forEach((b, bi) => {
      b.setAttribute('aria-current', bi === m.index);
      if (bi === m.index) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    // preload the neighbour
    if (n > 1) new Image().src = IMG_FULL + p.images[(m.index + 1) % n];
  }

  function closeModal({ pop = true } = {}) {
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('is-locked');
    m.lastFocus?.focus?.({ preventScroll: true });
    if (pop && location.hash.startsWith('#p/')) {
      if (history.state?.p) history.back();
      else history.replaceState(null, '', location.pathname + location.search);
    }
  }

  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  $('#m-prev').onclick = () => showImage(m.index - 1);
  $('#m-next').onclick = () => showImage(m.index + 1);
  $('#m-thumbs').onclick = (e) => { const b = e.target.closest('button'); if (b) showImage(+b.dataset.i); };
  $('#m-share').onclick = async () => {
    const url = `${location.href.split('#')[0]}#p/${m.product.id}`;
    try { await navigator.clipboard.writeText(url); toast('Link skopiowany do schowka'); }
    catch { prompt('Skopiuj link:', url); }
  };

  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'ArrowLeft') showImage(m.index - 1);
    else if (e.key === 'ArrowRight') showImage(m.index + 1);
    else if (e.key === 'Tab') {
      const f = [...modal.querySelectorAll('button, a[href]')].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  });

  // swipe on the photo
  let touchX = null;
  const stage = $('#m-stage');
  stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX === null || m.product.images.length < 2) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 45) showImage(m.index + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  function syncFromHash() {
    const match = location.hash.match(/^#p\/(.+)$/);
    if (match) openProduct(decodeURIComponent(match[1]), { push: false });
    else closeModal({ pop: false });
  }
  window.addEventListener('popstate', syncFromHash);

  /* ---------- Misc ---------- */
  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add('is-on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
  }

  const topbar = $('.topbar');
  const onScroll = () => topbar.classList.toggle('is-scrolled', scrollY > 10);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openProduct(card.dataset.id);
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; renderGrid(); }, 120);
  });

  $('#year').textContent = new Date().getFullYear();

  load()
    .then(() => { renderHero(); renderFilters(); renderGrid(); syncFromHash(); })
    .catch((err) => {
      console.error(err);
      $('#grid').innerHTML = '<p class="empty">Nie udało się wczytać galerii. Odśwież stronę.</p>';
    });
})();
