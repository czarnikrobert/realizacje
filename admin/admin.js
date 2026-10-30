/* Panel administracyjny – zapisuje zmiany w repozytorium GitHub przez API */
(() => {
  const DATA_PATH = 'data/products.json';
  const FULL_DIR = 'images/produkty/';
  const THUMB_DIR = 'images/thumbs/';
  const FULL_MAX = 1800;
  const THUMB_MAX = 700;
  const LEGACY_SETTINGS_KEY = 'pgp-admin-settings'; // plain-text token from the first version – removed on start
  const AUTH_PATH = 'admin/auth.json';
  const AUTH_CACHE_KEY = 'pgp-admin-auth';
  const SESSION_KEY = 'pgp-admin-session';
  const PBKDF2_ITERATIONS = 600000;
  const MIN_PASSWORD = 10;

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
    settings: {},            // { owner, repo, branch, token } – only in memory/session after login
    connected: false,
  };

  const store = {
    get(area, key) { try { return JSON.parse(window[area].getItem(key)); } catch { return null; } },
    set(area, key, value) { try { window[area].setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } },
    remove(area, key) { try { window[area].removeItem(key); } catch { /* storage blocked */ } },
  };

  // on <owner>.github.io/<repo>/admin/ we can guess the repository
  function guessRepo() {
    const host = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (!host) return {};
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return { owner: host[1], repo: seg && seg !== 'admin' ? seg : `${host[1]}.github.io` };
  }

  /* ---------- Password encryption of the GitHub token ---------- */
  const bytesToB64 = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptSettings(settings, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(settings)));
    return {
      v: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS,
      salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(data)),
      updated: new Date().toISOString(),
    };
  }

  // throws when the password is wrong (AES-GCM authentication fails)
  async function decryptSettings(auth, password) {
    const key = await deriveKey(password, b64ToBytes(auth.salt), auth.iterations);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(auth.iv) }, key, b64ToBytes(auth.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // newest of: auth.json published on the site, copy cached in this browser (Pages may lag after a change)
  async function fetchAuth() {
    let remote = null;
    try {
      const res = await fetch('auth.json', { cache: 'no-cache' });
      if (res.ok) remote = await res.json();
    } catch { /* offline or not published yet */ }
    const cached = store.get('localStorage', AUTH_CACHE_KEY);
    if (remote && cached) return (cached.updated || '') > (remote.updated || '') ? cached : remote;
    return remote || cached;
  }

  async function saveAuth(auth) {
    let sha;
    try { sha = (await gh(`${repoPath()}/contents/${AUTH_PATH}?ref=${branch()}`)).sha; }
    catch (err) { if (err.status !== 404) throw err; }
    await gh(`${repoPath()}/contents/${AUTH_PATH}`, {
      method: 'PUT',
      body: {
        message: 'Panel: aktualizacja zaszyfrowanych danych logowania',
        content: btoa(JSON.stringify(auth, null, 2) + '\n'),
        branch: state.settings.branch || 'main',
        ...(sha ? { sha } : {}),
      },
    });
    store.set('localStorage', AUTH_CACHE_KEY, auth);
  }

  async function verifyRepoAccess() {
    const info = await gh(repoPath());
    if (info.permissions && !info.permissions.push) throw new Error('Token nie ma uprawnień do zapisu (Contents: Read and write).');
  }

  /* ---------- Login screen ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function startLock() {
    store.remove('localStorage', LEGACY_SETTINGS_KEY);
    const session = store.get('sessionStorage', SESSION_KEY);
    if (session?.token) { await unlock(session); return; }

    const auth = await fetchAuth();
    $('#l-loading').hidden = true;
    if (auth) {
      $('#l-login').hidden = false;
      $('#l-pass').focus();
    } else {
      const g = guessRepo();
      $('#u-owner').value = g.owner || '';
      $('#u-repo').value = g.repo || '';
      $('#l-setup').hidden = false;
    }
  }

  async function unlock(settings) {
    state.settings = { branch: 'main', ...settings };
    store.set('sessionStorage', SESSION_KEY, state.settings);
    document.body.classList.remove('is-locked-out');
    $('#s-info').textContent = `Panel jest połączony z repozytorium ${state.settings.owner}/${state.settings.repo} (gałąź ${state.settings.branch}).`;
    updateAiSettingsInfo();
    await loadData();
  }

  function updateAiSettingsInfo() {
    const has = Boolean(state.settings.deepseekKey);
    $('#s-ai-state').textContent = has ? '(zapisany – wpisz nowy, aby go zmienić)' : '(brak – dodaj, aby pisać opisy przez AI)';
    $('#s-ai-remove-row').hidden = !has;
  }

  $('#l-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#l-login button');
    btn.disabled = true;
    $('#l-err').textContent = '';
    try {
      const auth = await fetchAuth();
      const settings = await decryptSettings(auth, $('#l-pass').value);
      $('#l-pass').value = '';
      await unlock(settings);
    } catch {
      await sleep(800); // slows down guessing a little
      $('#l-err').textContent = 'Nieprawidłowe hasło.';
      $('#l-pass').select();
    } finally {
      btn.disabled = false;
    }
  });

  $('#l-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#u-err');
    err.textContent = '';
    const pass = $('#u-pass').value;
    if (pass.length < MIN_PASSWORD) { err.textContent = `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`; return; }
    if (pass !== $('#u-pass2').value) { err.textContent = 'Hasła nie są takie same.'; return; }
    state.settings = {
      owner: $('#u-owner').value.trim(),
      repo: $('#u-repo').value.trim(),
      branch: $('#u-branch').value.trim() || 'main',
      token: $('#u-token').value.trim(),
    };
    busy('Sprawdzam dostęp do GitHub…');
    try {
      await verifyRepoAccess();
      busy('Szyfruję i zapisuję dane logowania…');
      await saveAuth(await encryptSettings(state.settings, pass));
      busy('');
      e.target.reset();
      await unlock(state.settings);
      toast('Gotowe! Od teraz logujesz się samym hasłem.');
    } catch (error) {
      busy('');
      err.textContent = error.message;
    }
  });

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
      throw Object.assign(new Error(`${hints[res.status] || 'Błąd GitHub'} (${res.status}: ${msg})`), { status: res.status });
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
      const expired = err.status === 401;
      showNotice(`Nie udało się wczytać danych z GitHub: ${esc(err.message)}${expired ? ' Utwórz nowy token i wpisz go w zakładce „Konto i hasło”.' : ''} <button class="btn btn--sm btn--ghost" data-goto="settings">Konto i hasło</button>`);
    }
    // read-only fallback so the list is still visible
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
    resetAi();
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

  /* ---------- AI descriptions (DeepSeek) ---------- */
  const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
  const DEEPSEEK_MODEL = 'deepseek-chat';
  const ai = { previous: null, controller: null };

  function resetAi() {
    ai.controller?.abort();
    ai.previous = null;
    $('#ai-hints').value = '';
    $('#ai-undo').hidden = true;
    $('#ai-status').textContent = '';
    $('.ai').classList.remove('is-busy');
  }

  // a few existing descriptions show the model the house style
  function styleExamples(skipId) {
    return state.data.products
      .filter((p) => p.id !== skipId && p.description && p.description.length > 80)
      .slice(0, 3)
      .map((p) => `„${p.title}”: ${p.description}`)
      .join('\n\n');
  }

  function aiPrompt(mode) {
    const draft = readEditor();
    const cats = draft.categories.map((id) => state.data.categories.find((c) => c.id === id)?.name).filter(Boolean);
    const facts = [
      `Nazwa produktu: ${draft.title || '(brak)'}`,
      cats.length && `Kategorie: ${cats.join(', ')}`,
      draft.tags.length && `Tagi: ${draft.tags.join(', ')}`,
      $('#ai-hints').value.trim() && `Wskazówki od autora: ${$('#ai-hints').value.trim()}`,
      mode === 'improve' && `Obecny opis do poprawienia:\n${draft.description}`,
    ].filter(Boolean).join('\n');
    const system = 'Jesteś copywriterem firmy Polskie Gry Planszowe z Krakowa, która produkuje na zamówienie drewniane figurki, obrazy i ikony, '
      + 'pamiątki regionalne, medaliony, zawieszki, magnesy i elementy gier (sklejka, wycinanie laserowe, pełnokolorowy nadruk). '
      + 'Piszesz opisy produktów do galerii realizacji. Zasady: po polsku, rzeczowo i ciepło, bez przesadnych ozdobników i wykrzykników, '
      + '2–4 zdania (do ok. 450 znaków), zwykły tekst bez nagłówków, list, cudzysłowów i emoji. '
      + 'Nie wymyślaj faktów: wymiarów, liczby sztuk, materiałów ani technik, których nie ma w danych – w razie braku pisz ogólniej.';
    const user = (mode === 'improve'
      ? 'Popraw poniższy opis: popraw język i styl, zachowaj wszystkie fakty, nie dodawaj nowych.'
      : 'Napisz opis produktu na podstawie danych.')
      + `\n\n${facts}\n\nPrzykłady opisów w stylu firmy:\n${styleExamples(editor.original?.id)}\n\nZwróć wyłącznie sam opis.`;
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  async function aiErrorMessage(res) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
    if (res.status === 401) return 'DeepSeek odrzucił klucz API – sprawdź go w zakładce „Konto i hasło”.';
    if (res.status === 402) return 'Brak środków na koncie DeepSeek – doładuj je na platform.deepseek.com.';
    if (res.status === 429) return 'Za dużo zapytań do DeepSeek – spróbuj za chwilę.';
    return `Błąd DeepSeek (${res.status})${detail ? `: ${detail}` : ''}.`;
  }

  async function aiGenerate(mode) {
    const key = state.settings.deepseekKey;
    if (!key) { toast('Najpierw dodaj klucz API DeepSeek w zakładce „Konto i hasło”.', true); return; }
    if (!$('#e-title').value.trim()) { toast('Najpierw wpisz nazwę produktu.', true); $('#e-title').focus(); return; }
    if (mode === 'improve' && !$('#e-desc').value.trim()) { toast('Opis jest pusty – użyj „Napisz opis”.', true); return; }

    const box = $('.ai');
    box.classList.add('is-busy');
    $('#ai-status').textContent = 'DeepSeek pisze…';
    ai.controller = new AbortController();
    try {
      let res;
      try {
        res = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          signal: ai.controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: aiPrompt(mode), temperature: 0.7, max_tokens: 500 }),
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        throw new Error('Brak połączenia z DeepSeek (sieć lub blokada przeglądarki).');
      }
      if (!res.ok) throw new Error(await aiErrorMessage(res));
      const text = (await res.json())?.choices?.[0]?.message?.content?.trim().replace(/^["„]|["”]$/g, '');
      if (!text) throw new Error('DeepSeek zwrócił pustą odpowiedź – spróbuj ponownie.');
      ai.previous = $('#e-desc').value;
      $('#e-desc').value = text;
      $('#ai-undo').hidden = false;
      $('#ai-status').textContent = 'Gotowe – przeczytaj i popraw, jeśli trzeba.';
    } catch (err) {
      $('#ai-status').textContent = '';
      toast(err.message, true);
    } finally {
      box.classList.remove('is-busy');
      ai.controller = null;
    }
  }

  $('#ai-write').addEventListener('click', () => aiGenerate('write'));
  $('#ai-improve').addEventListener('click', () => aiGenerate('improve'));
  $('#ai-undo').addEventListener('click', () => {
    if (ai.previous === null) return;
    $('#e-desc').value = ai.previous;
    ai.previous = null;
    $('#ai-undo').hidden = true;
    $('#ai-status').textContent = 'Przywrócono poprzedni opis.';
  });

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

  /* ---------- Account: change password / token, logout ---------- */
  $('#s-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPass = $('#s-pass').value;
    const newToken = $('#s-token').value.trim();
    const newAiKey = $('#s-ai-key').value.trim();
    const removeAiKey = $('#s-ai-remove').checked;
    if (!newPass && !newToken && !newAiKey && !removeAiKey) { toast('Wpisz nowe hasło, token lub klucz DeepSeek.', true); return; }
    if (newPass && newPass.length < MIN_PASSWORD) { toast(`Nowe hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`, true); return; }
    if (newPass !== $('#s-pass2').value) { toast('Nowe hasła nie są takie same.', true); return; }

    busy('Sprawdzam obecne hasło…');
    try {
      const current = await fetchAuth();
      try { await decryptSettings(current, $('#s-current').value); }
      catch { throw new Error('Obecne hasło jest nieprawidłowe.'); }

      const previous = state.settings;
      if (newToken) {
        state.settings = { ...state.settings, token: newToken };
        busy('Sprawdzam nowy token…');
        try { await verifyRepoAccess(); } catch (err) { state.settings = previous; throw err; }
      }
      const next = { ...state.settings };
      if (newAiKey) next.deepseekKey = newAiKey;
      else if (removeAiKey) delete next.deepseekKey;
      busy('Zapisuję…');
      await saveAuth(await encryptSettings(next, newPass || $('#s-current').value));
      state.settings = next;
      store.set('sessionStorage', SESSION_KEY, state.settings);
      e.target.reset();
      updateAiSettingsInfo();
      busy('');
      toast(newPass ? 'Hasło zostało zmienione.' : newToken ? 'Token został zaktualizowany.'
        : newAiKey ? 'Klucz DeepSeek został zapisany.' : 'Klucz DeepSeek został usunięty.');
      if (newToken && !state.connected) await loadData();
    } catch (err) {
      busy('');
      toast(err.message, true);
    }
  });

  $('#s-logout').addEventListener('click', () => {
    if (isDirty() && !confirm('Masz nieopublikowane zmiany. Wylogować się i je utracić?')) return;
    store.remove('sessionStorage', SESSION_KEY);
    state.baseline = serialize(); // nothing to warn about any more
    state.pending.clear();
    location.reload();
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  startLock().catch((err) => {
    console.error(err);
    $('#l-loading').textContent = `Nie udało się uruchomić panelu: ${err.message}`;
  });
})();
