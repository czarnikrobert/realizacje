/* Panel administracyjny – zapisuje zmiany w repozytorium GitHub przez API */
(() => {
  const DATA_PATH = 'data/products.json';
  const FULL_DIR = 'images/produkty/';
  const THUMB_DIR = 'images/thumbs/';
  const FULL_MAX = 1800;
  const THUMB_MAX = 700;
  const SETTINGS_KEY = 'pgp-admin-settings';

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PL = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
  const slug = (s) => String(s).toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => PL[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const norm = (s) => slug(s).replace(/-/g, ' ');

  const state = {
    data: { categories: [], products: [] },
    baseline: '',            // JSON last loaded/published – used to detect changes
    fileSha: null,           // sha of products.json in the repo when loaded
    pending: new Map(),      // name -> { full: Blob, thumb: Blob, url } – new photos not yet published
    previews: new Map(),     // name -> object URL of photos published in this session (Pages may lag)
    removed: new Set(),      // photo names removed from products – deleted from repo on publish if unused
    selected: new Set(),
    settings: loadSettings(),
    connected: false,
  };

  /* ---------- Settings ---------- */
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* storage unavailable */ }
    // on <owner>.github.io/<repo>/admin/ we can guess the repository
    const host = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (host && !s.owner) {
      s.owner = host[1];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      s.repo = seg && seg !== 'admin' ? seg : `${host[1]}.github.io`;
    }
    return { branch: 'main', ...s };
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
    catch { toast('Przeglądarka blokuje zapis ustawień – token trzeba będzie wpisać ponownie.', true); }
  }
  const hasToken = () => Boolean(state.settings.token && state.settings.owner && state.settings.repo);

  /* ---------- GitHub API ---------- */
  async function gh(path, { method = 'GET', body } = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${state.settings.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* no JSON body */ }
      const hints = { 401: 'Token jest nieprawidłowy lub wygasł.', 403: 'Token nie ma uprawnień do zapisu (Contents: Read and write).', 404: 'Nie znaleziono repozytorium, gałęzi lub pliku – sprawdź ustawienia i uprawnienia tokenu.', 409: 'Repozytorium jest puste lub zmieniło się w trakcie zapisu.' };
      throw new Error(`${hints[res.status] || 'Błąd GitHub'} (${res.status}: ${msg})`);
    }
    return res.status === 204 ? null : res.json();
  }
  const repoPath = () => `/repos/${encodeURIComponent(state.settings.owner)}/${encodeURIComponent(state.settings.repo)}`;
  const branch = () => encodeURIComponent(state.settings.branch || 'main');

  const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const blobToB64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  /* ---------- Loading ---------- */
  async function loadData() {
    if (hasToken()) {
      try {
        const file = await gh(`${repoPath()}/contents/${DATA_PATH}?ref=${branch()}`);
        setData(JSON.parse(b64ToText(file.content)), file.sha);
        state.connected = true;
        setStatus(`Połączono: ${state.settings.owner}/${state.settings.repo}`, 'ok');
        showNotice('');
        return;
      } catch (err) {
        state.connected = false;
        setStatus('Brak połączenia z GitHub', 'warn');
        showNotice(`Nie udało się wczytać danych z GitHub: ${esc(err.message)} <button class="btn btn--sm btn--ghost" data-goto="settings">Sprawdź ustawienia</button>`);
      }
    } else {
      setStatus('Tryb podglądu (bez zapisu)', 'warn');
      showNotice('Panel działa w trybie podglądu – możesz przeglądać i edytować, ale aby <strong>opublikować</strong> zmiany, skonfiguruj połączenie z GitHub. <button class="btn btn--sm btn--ghost" data-goto="settings">Skonfiguruj</button>');
    }
    const res = await fetch(`../${DATA_PATH}`, { cache: 'no-cache' });
    setData(await res.json(), null);
  }

  function setData(data, sha) {
    state.data = { categories: data.categories || [], products: data.products || [] };
    state.fileSha = sha;
    state.baseline = serialize();
    state.selected.clear();
    renderAll();
  }

  const serialize = () => JSON.stringify(state.data, null, 2) + '\n';
  const isDirty = () => serialize() !== state.baseline || [...state.pending.keys()].some(isReferenced);

  /* ---------- Rendering ---------- */
  function imgSrc(name, kind = 'thumb') {
    const p = state.pending.get(name);
    if (p) return p.url;
    if (state.previews.has(name)) return state.previews.get(name);
    return `../${kind === 'thumb' ? THUMB_DIR : FULL_DIR}${name}`;
  }
  const catName = (id) => state.data.categories.find((c) => c.id === id)?.name || id;

  function renderAll() {
    renderCategoryOptions();
    renderProducts();
    renderCategories();
    updatePublishButton();
  }

  function renderCategoryOptions() {
    const opts = state.data.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const filter = $('#p-filter');
    const cur = filter.value;
    filter.innerHTML = `<option value="">Wszystkie kategorie</option><option value="__none">— bez kategorii —</option>${opts}`;
    filter.value = [...filter.options].some((o) => o.value === cur) ? cur : '';
    $('#bulk-cat').innerHTML = opts;
  }

  function renderProducts() {
    const q = norm($('#p-search').value);
    const cat = $('#p-filter').value;
    const all = state.data.products;
    const list = all.filter((p) => {
      if (cat === '__none' && p.categories?.length) return false;
      if (cat && cat !== '__none' && !p.categories?.includes(cat)) return false;
      return !q || norm(`${p.title} ${p.id} ${(p.tags || []).join(' ')}`).includes(q);
    });
    const filtered = Boolean(q || cat);
    $('#p-list').innerHTML = list.map((p) => {
      const i = all.indexOf(p);
      const cats = (p.categories || []).map((c) => `<span class="pill">${esc(catName(c))}</span>`).join('');
      return `
      <div class="row ${p.hidden ? 'is-hidden-product' : ''}" data-id="${esc(p.id)}">
        <input type="checkbox" class="check" data-act="select" ${state.selected.has(p.id) ? 'checked' : ''} aria-label="Zaznacz">
        ${p.images?.[0] ? `<img class="row__thumb" src="${esc(imgSrc(p.images[0]))}" alt="" loading="lazy">` : '<div class="row__thumb"></div>'}
        <div class="row__main" data-act="edit">
          <div class="row__title">${esc(p.title || '(bez nazwy)')}
            ${p.featured ? '<span class="pill pill--star">★ wyróżniony</span>' : ''}
            ${p.hidden ? '<span class="pill pill--hidden">ukryty</span>' : ''}
            ${!p.images?.length ? '<span class="pill pill--warn">brak zdjęć</span>' : ''}
          </div>
          <div class="row__meta">${cats || '<span class="pill pill--warn">brak kategorii</span>'}<span>· ${p.images?.length || 0} zdj.</span></div>
        </div>
        <div class="row__actions">
          <button class="icon-btn" data-act="up" title="Przesuń wyżej" ${i === 0 || filtered ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="down" title="Przesuń niżej" ${i === all.length - 1 || filtered ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="edit" title="Edytuj">✎</button>
          <button class="icon-btn icon-btn--danger" data-act="delete" title="Usuń">🗑</button>
        </div>
      </div>`;
    }).join('');
    $('#p-empty').hidden = list.length > 0;
    $('#count-products').textContent = all.length;
    renderBulk();
  }

  function renderBulk() {
    // drop selections of products that no longer exist
    const ids = new Set(state.data.products.map((p) => p.id));
    [...state.selected].forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
    $('#bulk').hidden = state.selected.size === 0;
    $('#bulk-count').textContent = `Zaznaczono: ${state.selected.size}`;
  }

  function renderCategories() {
    const { categories, products } = state.data;
    $('#c-list').innerHTML = categories.map((c, i) => {
      const n = products.filter((p) => p.categories?.includes(c.id)).length;
      return `
      <div class="row row--cat" data-id="${esc(c.id)}">
        <div><input class="input" data-act="rename" value="${esc(c.name)}" aria-label="Nazwa kategorii"><code>id: ${esc(c.id)}</code></div>
        <span class="pill">${n} prod.</span>
        <div class="row__actions">
          <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} title="Wyżej">↑</button>
          <button class="icon-btn" data-act="down" ${i === categories.length - 1 ? 'disabled' : ''} title="Niżej">↓</button>
          <button class="icon-btn icon-btn--danger" data-act="delete" title="Usuń kategorię">🗑</button>
        </div>
      </div>`;
    }).join('') || '<p class="muted center">Brak kategorii.</p>';
    $('#count-categories').textContent = categories.length;
  }

  function updatePublishButton() {
    const dirty = isDirty();
    const btn = $('#btn-publish');
    btn.disabled = !dirty || !state.connected;
    btn.textContent = dirty ? 'Opublikuj zmiany •' : 'Opublikuj zmiany';
    btn.title = !state.connected ? 'Najpierw połącz panel z GitHub (zakładka „Połączenie z GitHub”)' : dirty ? 'Wyślij zmiany na stronę' : 'Brak zmian do opublikowania';
  }

  /* ---------- Tabs & notices ---------- */
  function goTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    if (name === 'settings') fillSettingsForm();
  }
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) goTab(b.dataset.tab); });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b) goTab(b.dataset.goto); });

  function showNotice(html) { const n = $('#notice'); n.innerHTML = html; n.hidden = !html; }
  function setStatus(text, kind) { const s = $('#status'); s.textContent = text; s.className = `status is-${kind}`; }

  let toastTimer;
  function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', error);
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), error ? 6000 : 3000);
  }
  function busy(text) { $('#overlay').hidden = !text; if (text) $('#overlay-text').textContent = text; }

  /* ---------- Product list actions ---------- */
  $('#p-search').addEventListener('input', renderProducts);
  $('#p-filter').addEventListener('change', renderProducts);
  $('#btn-new').addEventListener('click', () => openEditor(null));

  $('#p-list').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!row || !act) return;
    const products = state.data.products;
    const i = products.findIndex((p) => p.id === row.dataset.id);
    const p = products[i];
    if (act === 'edit') { openEditor(p); return; }
    if (act === 'select') {
      e.target.checked ? state.selected.add(p.id) : state.selected.delete(p.id);
      renderBulk();
      return;
    } else if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      [products[i], products[j]] = [products[j], products[i]];
    } else if (act === 'delete') {
      if (!confirm(`Usunąć produkt „${p.title}”? Zmiana będzie widoczna po opublikowaniu.`)) return;
      products.splice(i, 1);
      (p.images || []).forEach(forgetImage);
    }
    changed();
  });

  function bulk(add) {
    const cat = $('#bulk-cat').value;
    if (!cat) return;
    state.data.products.forEach((p) => {
      if (!state.selected.has(p.id)) return;
      const set = new Set(p.categories || []);
      add ? set.add(cat) : set.delete(cat);
      p.categories = state.data.categories.map((c) => c.id).filter((id) => set.has(id));
    });
    toast(`${add ? 'Dodano do' : 'Usunięto z'} kategorii „${catName(cat)}”: ${state.selected.size} prod.`);
    changed();
  }
  $('#bulk-add').addEventListener('click', () => bulk(true));
  $('#bulk-remove').addEventListener('click', () => bulk(false));
  $('#bulk-clear').addEventListener('click', () => { state.selected.clear(); renderProducts(); });

  /* ---------- Categories ---------- */
  $('#c-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim();
    if (!name) return;
    let id = slug(name) || 'kategoria';
    const base = id;
    for (let n = 2; state.data.categories.some((c) => c.id === id); n++) id = `${base}-${n}`;
    state.data.categories.push({ id, name });
    $('#c-name').value = '';
    toast(`Dodano kategorię „${name}”`);
    changed();
  });

  $('#c-list').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'rename') return;
    const c = state.data.categories.find((x) => x.id === e.target.closest('.row').dataset.id);
    const name = e.target.value.trim();
    if (!name) { e.target.value = c.name; return; }
    c.name = name;
    changed();
  });

  $('#c-list').addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    const cats = state.data.categories;
    const i = cats.findIndex((c) => c.id === e.target.closest('.row').dataset.id);
    if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      [cats[i], cats[j]] = [cats[j], cats[i]];
    } else if (act === 'delete') {
      const c = cats[i];
      const n = state.data.products.filter((p) => p.categories?.includes(c.id)).length;
      if (!confirm(`Usunąć kategorię „${c.name}”?${n ? ` Zostanie odpięta od ${n} produktów (produkty zostaną).` : ''}`)) return;
      cats.splice(i, 1);
      state.data.products.forEach((p) => { p.categories = (p.categories || []).filter((x) => x !== c.id); });
    }
    changed();
  });

  function changed() {
    renderAll();
  }

  /* ---------- Product editor ---------- */
  const editor = { original: null, images: [], idTouched: false };
  const drawer = $('#drawer');

  function openEditor(product) {
    editor.original = product;
    editor.images = [...(product?.images || [])];
    editor.idTouched = Boolean(product);
    $('#e-heading').textContent = product ? 'Edytuj produkt' : 'Nowy produkt';
    $('#e-title').value = product?.title || '';
    $('#e-id').value = product?.id || '';
    $('#e-desc').value = product?.description || '';
    $('#e-tags').value = (product?.tags || []).join(', ');
    $('#e-featured').checked = Boolean(product?.featured);
    $('#e-hidden').checked = Boolean(product?.hidden);
    $('#e-delete').hidden = !product;
    $('#e-cats').innerHTML = state.data.categories.map((c) => `
      <label><input type="checkbox" value="${esc(c.id)}" ${product?.categories?.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')
      || '<span class="muted">Najpierw dodaj kategorie w zakładce „Kategorie”.</span>';
    updateIdPreview();
    renderEditorImages();
    drawer.hidden = false;
    document.body.classList.add('is-locked');
    setTimeout(() => $('#e-title').focus(), 50);
  }

  function closeEditor(force = false) {
    if (!force && editorDirty() && !confirm('Zamknąć bez zapisywania zmian w tym produkcie?')) return;
    // photos uploaded in the editor but never saved to a product are dropped
    [...state.pending.keys()].forEach((n) => { if (!isReferenced(n)) dropPending(n); });
    drawer.hidden = true;
    document.body.classList.remove('is-locked');
  }

  function editorDirty() {
    const p = editor.original;
    const draft = readEditor();
    if (!p) return Boolean(draft.title || draft.description || draft.images.length);
    return JSON.stringify({ ...draft, id: undefined }) !== JSON.stringify({ ...normalizeProduct(p), id: undefined }) || draft.id !== p.id;
  }

  function normalizeProduct(p) {
    const out = { id: p.id, title: p.title || '', categories: p.categories || [], description: p.description || '', tags: p.tags || [], images: p.images || [] };
    if (p.featured) out.featured = true;
    if (p.hidden) out.hidden = true;
    return out;
  }

  function readEditor() {
    return normalizeProduct({
      id: $('#e-id').value.trim(),
      title: $('#e-title').value.trim(),
      categories: [...$('#e-cats').querySelectorAll('input:checked')].map((i) => i.value),
      description: $('#e-desc').value.replace(/\r/g, '').trim(),
      tags: $('#e-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      images: [...editor.images],
      featured: $('#e-featured').checked,
      hidden: $('#e-hidden').checked,
    });
  }

  function updateIdPreview() { $('#e-id-preview').textContent = $('#e-id').value || '…'; }
  $('#e-title').addEventListener('input', () => {
    if (!editor.idTouched) { $('#e-id').value = slug($('#e-title').value); updateIdPreview(); }
  });
  $('#e-id').addEventListener('input', () => {
    editor.idTouched = true;
    const v = slug($('#e-id').value.replace(/-+$/, '')) + ($('#e-id').value.endsWith('-') ? '-' : '');
    if (v !== $('#e-id').value) $('#e-id').value = v;
    updateIdPreview();
  });

  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeEditor(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) closeEditor(); });

  $('#e-delete').addEventListener('click', () => {
    const p = editor.original;
    if (!p || !confirm(`Usunąć produkt „${p.title}”?`)) return;
    state.data.products.splice(state.data.products.indexOf(p), 1);
    editor.images = [];
    (p.images || []).forEach(forgetImage);
    closeEditor(true);
    changed();
  });

  $('#e-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const draft = readEditor();
    if (!draft.title) { toast('Podaj nazwę produktu.', true); $('#e-title').focus(); return; }
    draft.id = slug(draft.id) || slug(draft.title);
    if (!draft.id) { toast('Podaj adres produktu.', true); return; }
    if (state.data.products.some((p) => p.id === draft.id && p !== editor.original)) {
      toast('Produkt o takim adresie już istnieje – zmień pole „Adres”.', true);
      $('#e-id').focus();
      return;
    }
    const p = editor.original;
    if (p) {
      const removedImages = (p.images || []).filter((n) => !draft.images.includes(n));
      if (state.selected.delete(p.id)) state.selected.add(draft.id);
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, draft);
      removedImages.forEach(forgetImage);
    } else {
      state.data.products.unshift(draft);
    }
    closeEditor(true);
    toast(p ? 'Zapisano produkt. Pamiętaj o „Opublikuj zmiany”.' : 'Dodano produkt. Pamiętaj o „Opublikuj zmiany”.');
    changed();
  });

  /* editor – images */
  function renderEditorImages() {
    $('#e-images').innerHTML = editor.images.map((n, i) => `
      <div class="img-tile" draggable="true" data-i="${i}">
        <img src="${esc(imgSrc(n))}" alt="">
        ${i === 0 ? '<span class="img-tile__badge">okładka</span>' : ''}
        ${state.pending.has(n) ? '<span class="img-tile__new">nowe</span>' : ''}
        <div class="img-tile__tools">
          ${i > 0 ? '<button type="button" data-act="cover" title="Ustaw jako okładkę">★</button><button type="button" data-act="left" title="W lewo">←</button>' : ''}
          ${i < editor.images.length - 1 ? '<button type="button" data-act="right" title="W prawo">→</button>' : ''}
          <button type="button" data-act="remove" title="Usuń zdjęcie">✕</button>
        </div>
      </div>`).join('');
  }

  $('#e-images').addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    const i = +e.target.closest('.img-tile').dataset.i;
    const imgs = editor.images;
    if (act === 'remove') imgs.splice(i, 1);
    else if (act === 'cover') imgs.unshift(imgs.splice(i, 1)[0]);
    else if (act === 'left') [imgs[i - 1], imgs[i]] = [imgs[i], imgs[i - 1]];
    else if (act === 'right') [imgs[i + 1], imgs[i]] = [imgs[i], imgs[i + 1]];
    renderEditorImages();
  });

  let dragFrom = null;
  const imagesBox = $('#e-images');
  imagesBox.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.img-tile');
    if (!t) return;
    dragFrom = +t.dataset.i;
    t.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  imagesBox.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    imagesBox.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
    e.target.closest('.img-tile')?.classList.add('is-over');
  });
  imagesBox.addEventListener('drop', (e) => {
    const t = e.target.closest('.img-tile');
    if (dragFrom === null || !t) return;
    e.preventDefault();
    const to = +t.dataset.i;
    editor.images.splice(to, 0, editor.images.splice(dragFrom, 1)[0]);
    dragFrom = null;
    renderEditorImages();
  });
  imagesBox.addEventListener('dragend', () => { dragFrom = null; renderEditorImages(); });

  const drop = $('#e-drop');
  $('#e-files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  drop.addEventListener('dragover', (e) => { if (dragFrom !== null) return; e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    if (dragFrom !== null) return;
    e.preventDefault();
    drop.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!files.length) return;
    const prefix = slug($('#e-id').value || $('#e-title').value) || 'produkt';
    let ok = 0;
    for (const [k, file] of files.entries()) {
      busy(`Przygotowuję zdjęcie ${k + 1} z ${files.length}…`);
      try {
        const full = await resizeImage(file, FULL_MAX, 0.82);
        const thumb = await resizeImage(file, THUMB_MAX, 0.78);
        const name = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
        state.pending.set(name, { full, thumb, url: URL.createObjectURL(thumb) });
        editor.images.push(name);
        ok++;
      } catch (err) {
        console.error(err);
        toast(`Nie udało się wczytać „${file.name}”. Zapisz zdjęcie jako JPG lub PNG i spróbuj ponownie.`, true);
      }
    }
    busy('');
    renderEditorImages();
    updatePublishButton();
    if (ok) toast(`Dodano zdjęcia: ${ok}`);
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  async function resizeImage(file, max, quality) {
    const src = await decodeImage(file);
    const w = src.width, h = src.height;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', quality));
  }

  /* ---------- Image bookkeeping ---------- */
  const isReferenced = (name) => state.data.products.some((p) => p.images?.includes(name));
  function dropPending(name) {
    const p = state.pending.get(name);
    if (p) URL.revokeObjectURL(p.url);
    state.pending.delete(name);
  }
  function forgetImage(name) {
    if (isReferenced(name)) return;
    if (state.pending.has(name)) dropPending(name);
    else state.removed.add(name);
  }

  /* ---------- Publish ---------- */
  async function publish() {
    if (!state.connected) { goTab('settings'); return; }
    const problems = state.data.products.filter((p) => !p.hidden && !p.images?.length);
    if (problems.length && !confirm(`Produkty bez zdjęć nie pojawią się na stronie: ${problems.map((p) => p.title).join(', ')}. Kontynuować?`)) return;

    const repo = repoPath();
    try {
      busy('Sprawdzam repozytorium…');
      const current = await gh(`${repo}/contents/${DATA_PATH}?ref=${branch()}`);
      if (state.fileSha && current.sha !== state.fileSha &&
        !confirm('Dane na GitHub zmieniły się od momentu wczytania panelu (np. edycja z innego komputera). Nadpisać je Twoją wersją?')) { busy(''); return; }

      const ref = await gh(`${repo}/git/ref/heads/${branch()}`);
      const headSha = ref.object.sha;
      const head = await gh(`${repo}/git/commits/${headSha}`);
      const tree = [];

      const uploads = [...state.pending.entries()].filter(([name]) => isReferenced(name));
      for (const [k, [name, img]] of uploads.entries()) {
        busy(`Wysyłam zdjęcie ${k + 1} z ${uploads.length}…`);
        for (const [dir, blob] of [[FULL_DIR, img.full], [THUMB_DIR, img.thumb]]) {
          const b = await gh(`${repo}/git/blobs`, { method: 'POST', body: { content: await blobToB64(blob), encoding: 'base64' } });
          tree.push({ path: dir + name, mode: '100644', type: 'blob', sha: b.sha });
        }
      }

      const toDelete = [...state.removed].filter((n) => !isReferenced(n));
      if (toDelete.length) {
        busy('Porządkuję usunięte zdjęcia…');
        const existing = await gh(`${repo}/git/trees/${head.tree.sha}?recursive=1`);
        const paths = new Set(existing.tree.map((t) => t.path));
        toDelete.forEach((n) => [FULL_DIR + n, THUMB_DIR + n].forEach((path) => {
          if (paths.has(path)) tree.push({ path, mode: '100644', type: 'blob', sha: null });
        }));
      }

      busy('Zapisuję dane…');
      const json = serialize();
      const jb = await gh(`${repo}/git/blobs`, { method: 'POST', body: { content: json, encoding: 'utf-8' } });
      tree.push({ path: DATA_PATH, mode: '100644', type: 'blob', sha: jb.sha });

      const newTree = await gh(`${repo}/git/trees`, { method: 'POST', body: { base_tree: head.tree.sha, tree } });
      const summary = [`${state.data.products.length} produktów`, uploads.length && `+${uploads.length} zdjęć`, toDelete.length && `-${toDelete.length} zdjęć`].filter(Boolean).join(', ');
      const commit = await gh(`${repo}/git/commits`, { method: 'POST', body: { message: `Aktualizacja realizacji z panelu (${summary})`, tree: newTree.sha, parents: [headSha] } });
      await gh(`${repo}/git/refs/heads/${branch()}`, { method: 'PATCH', body: { sha: commit.sha } });

      // keep showing freshly uploaded photos until GitHub Pages rebuilds
      uploads.forEach(([name, img]) => state.previews.set(name, img.url));
      state.pending.clear();
      state.removed.clear();
      state.fileSha = jb.sha; // the contents API reports the blob sha
      state.baseline = json;
      busy('');
      renderAll();
      toast('Opublikowano! Strona zaktualizuje się w ciągu 1–2 minut.');
    } catch (err) {
      console.error(err);
      busy('');
      toast(`Nie udało się opublikować: ${err.message}`, true);
    }
  }
  $('#btn-publish').addEventListener('click', publish);

  $('#btn-export').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([serialize()], { type: 'application/json' }));
    a.download = 'products.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    if (state.pending.size) toast('Uwaga: nowe zdjęcia nie są w pliku JSON – publikuj przez GitHub, aby je zapisać.', true);
  });

  /* ---------- Settings form ---------- */
  function fillSettingsForm() {
    const s = state.settings;
    $('#s-owner').value = s.owner || '';
    $('#s-repo').value = s.repo || '';
    $('#s-branch').value = s.branch || 'main';
    $('#s-token').value = s.token || '';
  }

  $('#s-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isDirty() && !confirm('Masz nieopublikowane zmiany – ponowne połączenie wczyta dane z GitHub i je odrzuci. Kontynuować?')) return;
    state.settings = {
      owner: $('#s-owner').value.trim(),
      repo: $('#s-repo').value.trim(),
      branch: $('#s-branch').value.trim() || 'main',
      token: $('#s-token').value.trim(),
    };
    busy('Łączę z GitHub…');
    try {
      const info = await gh(repoPath());
      if (info.permissions && !info.permissions.push) throw new Error('Token nie ma uprawnień do zapisu (Contents: Read and write).');
      saveSettings();
      state.pending.clear();
      state.removed.clear();
      await loadData();
      busy('');
      if (state.connected) { toast('Połączono z GitHub.'); goTab('products'); }
    } catch (err) {
      busy('');
      toast(err.message, true);
    }
  });

  $('#s-logout').addEventListener('click', () => {
    state.settings = { owner: state.settings.owner, repo: state.settings.repo, branch: state.settings.branch };
    saveSettings();
    $('#s-token').value = '';
    state.connected = false;
    setStatus('Tryb podglądu (bez zapisu)', 'warn');
    updatePublishButton();
    toast('Token usunięty z tej przeglądarki.');
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  loadData().catch((err) => {
    console.error(err);
    showNotice(`Nie udało się wczytać danych: ${esc(err.message)}`);
  });
})();
