(() => {
  const config = window.ADMIN_CONFIG || {};
  const apiBase = String(config.API_BASE_URL || '').replace(/\/$/, '');
  const $ = (selector) => document.querySelector(selector);
  const loginCard = $('#login-card');
  const panel = $('#panel');
  const tokenKey = 'nane-admin-token';
  let token = localStorage.getItem(tokenKey) || sessionStorage.getItem(tokenKey) || '';
  let catalog = { categories: [], products: [], beverages: [] };
  let orders = [];
  let currentWorkspace = 'orders';
  let currentCatalog = 'products';
  let selectedFile = null;
  let selectedBannerFile = null;
  let bannerPreviewUrl = '';
  let dirty = false;
  let toastTimer;
  const defaultBannerImage = 'assets/banner-cardapio.jpeg';

  function setMessage(element, text, kind = '') {
    element.textContent = text;
    element.className = 'message' + (kind ? ` ${kind}` : '');
  }

  function notify(text) {
    const toast = $('#toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function setDirty(value) {
    dirty = value;
    $('#save-all').disabled = !dirty;
    $('#save-all').textContent = dirty ? 'Salvar alterações' : 'Tudo salvo';
  }

  function slugify(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function getCollection() {
    return currentCatalog === 'products' ? catalog.products : catalog.beverages;
  }

  function getCategories() {
    return catalog.categories.filter((category) => category.catalog === currentCatalog);
  }

  async function request(path, options = {}) {
    if (!apiBase) throw new Error('O endereço do serviço ainda não foi configurado no Render.');
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) };
    const response = await fetch(`${apiBase}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && token) logout(false);
      throw new Error(data.error || 'Não foi possível concluir essa ação.');
    }
    return data;
  }

  function setLoggedIn(value) {
    loginCard.classList.toggle('hidden', value);
    panel.classList.toggle('hidden', !value);
    $('#logout').classList.toggle('hidden', !value);
  }

  function logout(showMessage = true) {
    token = '';
    localStorage.removeItem(tokenKey);
    sessionStorage.removeItem(tokenKey);
    $('#remember-login').checked = false;
    setLoggedIn(false);
    if (showMessage) setMessage($('#login-message'), 'Você saiu do painel.');
  }

  async function login(event) {
    event.preventDefault();
    const button = event.submitter || $('#login-form button[type="submit"]');
    button.disabled = true;
    setMessage($('#login-message'), 'Conectando ao painel…');
    try {
      const data = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      token = data.token;
      if ($('#remember-login').checked) {
        localStorage.setItem(tokenKey, token);
        sessionStorage.removeItem(tokenKey);
      } else {
        sessionStorage.setItem(tokenKey, token);
        localStorage.removeItem(tokenKey);
      }
      $('#password').value = '';
      await loadCatalog();
      setLoggedIn(true);
      switchWorkspace('orders');
      setMessage($('#login-message'), '');
      await loadOrders().catch((error) => setMessage($('#app-message'), error.message, 'error'));
    } catch (error) {
      setMessage($('#login-message'), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function loadCatalog() {
    const data = await request('/api/admin/catalog');
    if (!Array.isArray(data.categories) || !Array.isArray(data.products) || !Array.isArray(data.beverages)) throw new Error('O formato do catálogo está incompleto.');
    catalog = data;
    if (!catalog.banners || typeof catalog.banners !== 'object' || Array.isArray(catalog.banners)) catalog.banners = {};
    if (typeof catalog.banners.menuImage !== 'string' || !catalog.banners.menuImage) catalog.banners.menuImage = defaultBannerImage;
    drawCategories();
    drawList();
    drawBannerPreview();
    resetForm();
    setDirty(false);
  }

  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function orderBalance(order) {
    return Math.max(0, Number(order.amount || 0) - Number(order.paid || 0));
  }

  function orderStatusClass(stage) {
    if (stage === 'Entregue') return 'done';
    if (stage === 'Cancelado') return 'cancelled';
    if (stage === 'Pronto') return 'ready';
    if (stage === 'Aguardando confirmação') return 'pending';
    return '';
  }

  async function loadOrders() {
    const result = await request('/api/admin/orders');
    orders = Array.isArray(result.orders) ? result.orders : [];
    renderOrders();
  }

  function renderOrders() {
    const today = localDateKey();
    const active = orders.filter((order) => !['Entregue', 'Cancelado'].includes(order.stage));
    const dueToday = active.filter((order) => order.date === today);
    $('#order-stat-open').textContent = active.length;
    $('#order-stat-today').textContent = dueToday.length;
    $('#order-stat-balance').textContent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
      .format(active.reduce((sum, order) => sum + orderBalance(order), 0));
    const query = ($('#order-search')?.value || '').trim().toLocaleLowerCase('pt-BR');
    const status = $('#order-status-filter')?.value || 'todos';
    const date = $('#order-date-filter')?.value || '';
    const list = [...orders].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).filter((order) => {
      const text = `${order.client} ${order.phone} ${order.items} ${order.notes} ${order.address}`.toLocaleLowerCase('pt-BR');
      return (status === 'todos' || order.stage === status) && (!date || order.date === date) && (!query || text.includes(query));
    });
    if (!list.length) {
      $('#orders-list').innerHTML = '<div class="empty-state">Nenhum pedido encontrado. Os agendamentos feitos na loja aparecerão aqui. ♡</div>';
      return;
    }
    const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
    const statusChoices = ['Aguardando confirmação', 'Confirmado', 'Em preparo', 'Pronto', 'Entregue', 'Cancelado'];
    $('#orders-list').innerHTML = list.map((order) => {
      const displayDate = order.date ? new Date(`${order.date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : 'Data não informada';
      const phoneDigits = String(order.phone || '').replace(/\D/g, '');
      const whatsappPhone = phoneDigits.length <= 11 ? `55${phoneDigits}` : phoneDigits;
      const whatsappMessage = encodeURIComponent(`Olá, ${order.client}! Passando para confirmar seu pedido de ${order.items}, para ${displayDate} às ${order.time}. — Nane Salgados e Churros`);
      return `<article class="order-admin-card" data-order-id="${escapeHTML(order.id)}">
        <div class="order-admin-head"><div><h3>${escapeHTML(order.client)}</h3><div class="order-admin-sub">${escapeHTML(displayDate)} · ${escapeHTML(order.time || '')} · ${order.delivery === 'delivery' ? 'Entrega' : 'Retirada'}</div></div><span class="order-admin-status ${orderStatusClass(order.stage)}">${escapeHTML(order.stage || 'Aguardando confirmação')}</span></div>
        <div class="order-admin-details"><p class="order-admin-items">${escapeHTML(order.items || 'Itens não informados')}${order.address ? `\n\nEndereço: ${escapeHTML(order.address)}` : ''}${order.notes ? `\nObservação: ${escapeHTML(order.notes)}` : ''}</p><p class="order-admin-contact">WhatsApp: <b>${escapeHTML(order.phone || 'Não informado')}</b><br>Total estimado: <b>${money(order.amount)}</b><br>Recebido: <b>${money(order.paid)}</b><br>Saldo: <b>${money(orderBalance(order))}</b></p></div>
        <div class="order-admin-controls"><label>Etapa do pedido<select data-stage>${statusChoices.map((item) => `<option${item === order.stage ? ' selected' : ''}>${item}</option>`).join('')}</select></label><label>Valor recebido<input data-paid type="number" min="0" step="0.01" max="${Number(order.amount || 0)}" value="${Number(order.paid || 0)}"></label><div class="order-admin-actions">${phoneDigits.length >= 10 ? `<button type="button" data-whatsapp="https://wa.me/${escapeHTML(whatsappPhone)}?text=${whatsappMessage}">WhatsApp</button>` : ''}<button type="button" data-save-order>Salvar</button><button type="button" class="delete-order" data-delete-order>Excluir</button></div></div>
      </article>`;
    }).join('');
  }

  function switchWorkspace(workspace) {
    currentWorkspace = workspace;
    $('#orders-workspace').classList.toggle('hidden', workspace !== 'orders');
    $('#catalog-workspace').classList.toggle('hidden', workspace !== 'catalog');
    $('#save-all').classList.toggle('hidden', workspace !== 'catalog');
    document.querySelectorAll('.main-tab').forEach((tab) => {
      const active = tab.dataset.workspace === workspace;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    if (workspace === 'orders') loadOrders().catch((error) => setMessage($('#app-message'), error.message, 'error'));
  }

  function drawCategories() {
    const categories = getCategories();
    const current = $('#category').value;
    $('#category').innerHTML = categories.map((category) => `<option value="${escapeHTML(category.id)}">${escapeHTML(category.name)}</option>`).join('');
    $('#filter-category').innerHTML = '<option value="all">Todas as categorias</option>' + categories.map((category) => `<option value="${escapeHTML(category.id)}">${escapeHTML(category.name)}</option>`).join('');
    if (categories.some((category) => category.id === current)) $('#category').value = current;
  }

  function getImageUrl(path) {
    if (!path) return '';
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `https://raw.githubusercontent.com/kislhakk-ux/SALGADOS/main/${encodedPath}`;
  }

  function drawBannerPreview() {
    const preview = $('#menu-banner-preview');
    if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl);
    bannerPreviewUrl = '';
    if (selectedBannerFile) {
      bannerPreviewUrl = URL.createObjectURL(selectedBannerFile);
      preview.src = bannerPreviewUrl;
      $('#menu-banner-caption').textContent = 'Nova foto selecionada · salve para publicar';
      return;
    }
    preview.src = getImageUrl(catalog.banners?.menuImage || defaultBannerImage);
    $('#menu-banner-caption').textContent = catalog.banners?.menuImage === defaultBannerImage
      ? 'Imagem original da loja'
      : 'Imagem atual da loja';
  }

  function drawList() {
    const search = $('#search').value.trim().toLocaleLowerCase('pt-BR');
    const filter = $('#filter-category').value;
    const items = getCollection().filter((item) => (filter === 'all' || item.category === filter) && (!search || `${item.name} ${item.description || ''}`.toLocaleLowerCase('pt-BR').includes(search)));
    const activeCount = getCollection().filter((item) => item.active !== false).length;
    $('#item-count').textContent = `${activeCount} ${activeCount === 1 ? 'item ativo' : 'itens ativos'}`;
    if (!items.length) {
      $('#product-list').innerHTML = '<div class="empty-state">Nenhum produto encontrado. Adicione o primeiro item no formulário ao lado.</div>';
      return;
    }
    $('#product-list').innerHTML = items.map((item) => {
      const category = catalog.categories.find((entry) => entry.id === item.category)?.name || 'Sem categoria';
      const price = item.price == null || item.price === '' ? 'Preço a combinar' : `${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(item.price))} / ${escapeHTML(item.unitLabel || 'unidade')}`;
      const image = getImageUrl(item.image) || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 60 60%22%3E%3Crect fill=%22%23f2e4d7%22 width=%2260%22 height=%2260%22/%3E%3Ctext x=%2230%22 y=%2238%22 text-anchor=%22middle%22 font-size=%2225%22 fill=%22%23bd605b%22%3E%E2%99%A1%3C/text%3E%3C/svg%3E';
      return `<article class="item-row ${item.active === false ? 'inactive' : ''}"><img class="item-thumb" src="${image}" alt="" loading="lazy"><div class="item-info"><div class="item-copy"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(category)} · ${escapeHTML(item.description || '')}</small></div><div class="item-actions"><button type="button" data-edit="${escapeHTML(item.id)}">Editar</button><button type="button" data-toggle="${escapeHTML(item.id)}">${item.active === false ? 'Ativar' : 'Ocultar'}</button></div></div><span class="item-price">${price}</span></article>`;
    }).join('');
  }

  function resetForm() {
    $('#product-form').reset();
    $('#product-id').value = '';
    $('#form-title').textContent = 'Adicionar item';
    $('#submit-product').textContent = 'Adicionar ao catálogo';
    $('#cancel-edit').classList.add('hidden');
    $('#image-preview-wrap').classList.add('hidden');
    $('#image-preview').removeAttribute('src');
    selectedFile = null;
    drawCategories();
  }

  function editItem(id) {
    const item = getCollection().find((entry) => entry.id === id);
    if (!item) return;
    $('#product-id').value = item.id;
    $('#name').value = item.name;
    $('#category').value = item.category;
    $('#price').value = item.price == null ? '' : String(item.price).replace('.', ',');
    $('#unit').value = item.unitLabel || 'unidade';
    $('#description').value = item.description || '';
    $('#form-title').textContent = 'Editar item';
    $('#submit-product').textContent = 'Atualizar item';
    $('#cancel-edit').classList.remove('hidden');
    selectedFile = null;
    $('#photo').value = '';
    const preview = $('#image-preview');
    if (item.image && apiBase) {
      preview.src = getImageUrl(item.image);
      $('#image-preview-label').textContent = 'Foto atual · escolha outra para trocar';
      $('#image-preview-wrap').classList.remove('hidden');
    } else $('#image-preview-wrap').classList.add('hidden');
    if (window.matchMedia('(max-width: 850px)').matches) {
      $('.editor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $('#name').focus({ preventScroll: true });
  }

  function addCategory(event) {
    event.preventDefault();
    const name = $('#new-category').value.trim();
    const id = slugify(name);
    if (!id) return setMessage($('#app-message'), 'Digite o nome da categoria.', 'error');
    if (catalog.categories.some((category) => category.id === id)) return setMessage($('#app-message'), 'Essa categoria já existe.', 'error');
    catalog.categories.push({ id, name, catalog: currentCatalog });
    $('#new-category').value = '';
    drawCategories();
    $('#category').value = id;
    setDirty(true);
    setMessage($('#app-message'), `Categoria “${name}” adicionada. Clique em Salvar alterações para publicar.`, 'success');
  }

  async function compressImage(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('Não foi possível abrir essa imagem. Escolha outra foto.'); }
    const maxDimension = 1400;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
    if (!blob) throw new Error('Não foi possível preparar essa foto.');
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Não foi possível ler essa foto.'));
      reader.readAsDataURL(blob);
    });
    return { dataBase64, filename: file.name.replace(/\.[^.]+$/, '') || 'produto', mimeType: 'image/jpeg' };
  }

  async function submitProduct(event) {
    event.preventDefault();
    const button = $('#submit-product');
    button.disabled = true;
    const previousText = button.textContent;
    try {
      const editingId = $('#product-id').value;
      const id = editingId || slugify($('#name').value);
      if (!id) throw new Error('Digite o nome do produto.');
      const rawPrice = $('#price').value.trim().replace(/\s/g, '');
      const parsedPrice = rawPrice.includes(',') ? rawPrice.replace(/\./g, '').replace(',', '.') : rawPrice;
      const item = {
        id,
        name: $('#name').value.trim(),
        category: $('#category').value,
        price: rawPrice === '' ? null : Number(parsedPrice),
        unitLabel: $('#unit').value,
        image: currentCatalog === 'products' ? 'assets/salgados-sortidos.jpg' : 'assets/bebidas/agua-crystal-500ml.jpg',
        description: $('#description').value.trim(),
        active: true
      };
      if (!item.name) throw new Error('Digite o nome do produto.');
      if (item.price != null && (!Number.isFinite(item.price) || item.price < 0)) throw new Error('Confira o preço. Use um valor como 1,50.');
      const list = getCollection();
      const original = list.find((entry) => entry.id === id);
      const usedElsewhere = [...catalog.products, ...catalog.beverages].some((entry) => entry.id === id && entry !== original);
      if (usedElsewhere) throw new Error('Já existe um item com esse nome. Escolha outro nome para diferenciar.');
      if (original && !editingId) throw new Error('Já existe um produto com esse nome. Clique em Editar para alterá-lo.');
      if (original) item.image = original.image;
      else if (list.some((entry) => entry.id === id)) throw new Error('Já existe um produto com esse nome nessa lista.');
      if (selectedFile) {
        button.textContent = 'Salvando foto…';
        const photo = await compressImage(selectedFile);
        const savedPhoto = await request('/api/admin/images', { method: 'POST', body: JSON.stringify(photo) });
        item.image = savedPhoto.image;
      }
      if (original) Object.assign(original, item);
      else list.push(item);
      drawList();
      setDirty(true);
      resetForm();
      setMessage($('#app-message'), 'Item atualizado no rascunho. Clique em Salvar alterações para enviar para a loja.', 'success');
    } catch (error) {
      setMessage($('#app-message'), error.message, 'error');
    } finally {
      button.textContent = previousText;
      button.disabled = false;
    }
  }

  async function saveCatalog() {
    const button = $('#save-all');
    button.disabled = true;
    button.textContent = 'Salvando…';
    setMessage($('#app-message'), selectedBannerFile ? 'Enviando a nova foto e salvando as alterações…' : 'Gravando alterações no catálogo…');
    try {
      if (selectedBannerFile) {
        const photo = await compressImage(selectedBannerFile);
        const savedPhoto = await request('/api/admin/images', { method: 'POST', body: JSON.stringify(photo) });
        catalog.banners.menuImage = savedPhoto.image;
        selectedBannerFile = null;
        $('#menu-banner-photo').value = '';
        drawBannerPreview();
      }
      const result = await request('/api/admin/catalog', { method: 'PUT', body: JSON.stringify(catalog) });
      catalog = result.catalog;
      drawCategories();
      drawList();
      drawBannerPreview();
      setDirty(false);
      setMessage($('#app-message'), 'Catálogo salvo. As alterações já podem aparecer na loja.', 'success');
    } catch (error) {
      setMessage($('#app-message'), error.message, 'error');
      setDirty(true);
    }
  }

  function switchCatalog(kind) {
    currentCatalog = kind;
    document.querySelectorAll('.catalog-tab').forEach((tab) => {
      const active = tab.dataset.catalog === kind;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    const title = kind === 'products' ? 'Salgados, centos e doces' : 'Bebidas';
    $('#list-title').textContent = title;
    $('#new-category').placeholder = kind === 'products' ? 'Ex.: Centos mistos' : 'Ex.: Sucos naturais';
    $('#search').value = '';
    resetForm();
    drawCategories();
    drawList();
  }

  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', () => logout());
  $('#category-form').addEventListener('submit', addCategory);
  $('#product-form').addEventListener('submit', submitProduct);
  $('#save-all').addEventListener('click', saveCatalog);
  $('#cancel-edit').addEventListener('click', resetForm);
  $('#search').addEventListener('input', drawList);
  $('#filter-category').addEventListener('change', drawList);
  $('#photo').addEventListener('change', () => {
    selectedFile = $('#photo').files?.[0] || null;
    if (!selectedFile) return;
    $('#image-preview').src = URL.createObjectURL(selectedFile);
    $('#image-preview-label').textContent = selectedFile.name;
    $('#image-preview-wrap').classList.remove('hidden');
  });
  $('#menu-banner-photo').addEventListener('change', () => {
    selectedBannerFile = $('#menu-banner-photo').files?.[0] || null;
    if (!selectedBannerFile) return;
    drawBannerPreview();
    setDirty(true);
    setMessage($('#app-message'), 'Nova foto do banner selecionada. Clique em Salvar alterações para publicar.', 'success');
  });
  $('#restore-menu-banner').addEventListener('click', () => {
    selectedBannerFile = null;
    $('#menu-banner-photo').value = '';
    catalog.banners.menuImage = defaultBannerImage;
    drawBannerPreview();
    setDirty(true);
    setMessage($('#app-message'), 'Imagem original selecionada. Clique em Salvar alterações para publicar.', 'success');
  });
  $('#remove-photo').addEventListener('click', () => {
    selectedFile = null;
    $('#photo').value = '';
    $('#image-preview-wrap').classList.add('hidden');
    $('#image-preview').removeAttribute('src');
  });
  $('#product-list').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]');
    const toggle = event.target.closest('[data-toggle]');
    if (edit) return editItem(edit.dataset.edit);
    if (toggle) {
      const item = getCollection().find((entry) => entry.id === toggle.dataset.toggle);
      if (!item) return;
      item.active = item.active === false;
      drawList();
      setDirty(true);
      setMessage($('#app-message'), 'Visibilidade alterada no rascunho. Salve as alterações para atualizar a loja.', 'success');
    }
  });
  document.querySelectorAll('.catalog-tab').forEach((tab) => tab.addEventListener('click', () => switchCatalog(tab.dataset.catalog)));
  document.querySelectorAll('.main-tab').forEach((tab) => tab.addEventListener('click', () => switchWorkspace(tab.dataset.workspace)));
  $('#refresh-orders').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Atualizando…';
    try { await loadOrders(); setMessage($('#app-message'), 'Agenda atualizada.', 'success'); }
    catch (error) { setMessage($('#app-message'), error.message, 'error'); }
    finally { button.disabled = false; button.textContent = '↻ Atualizar'; }
  });
  $('#order-search').addEventListener('input', renderOrders);
  $('#order-status-filter').addEventListener('change', renderOrders);
  $('#order-date-filter').addEventListener('change', renderOrders);
  $('#orders-list').addEventListener('click', async (event) => {
    const card = event.target.closest('[data-order-id]');
    if (!card) return;
    const order = orders.find((item) => String(item.id) === card.dataset.orderId);
    if (!order) return;
    const whatsapp = event.target.closest('[data-whatsapp]');
    if (whatsapp) { window.open(whatsapp.dataset.whatsapp, '_blank', 'noopener,noreferrer'); return; }
    const remove = event.target.closest('[data-delete-order]');
    if (remove) {
      if (!window.confirm(`Excluir o pedido de ${order.client}?`)) return;
      card.classList.add('order-saving');
      try {
        await request(`/api/admin/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
        orders = orders.filter((item) => String(item.id) !== String(order.id));
        renderOrders();
        notify('Pedido excluído da agenda.');
      } catch (error) {
        card.classList.remove('order-saving');
        setMessage($('#app-message'), error.message, 'error');
      }
      return;
    }
    const save = event.target.closest('[data-save-order]');
    if (save) {
      const next = { ...order, stage: card.querySelector('[data-stage]').value, paid: Number(card.querySelector('[data-paid]').value || 0) };
      card.classList.add('order-saving');
      try {
        const result = await request(`/api/admin/orders/${encodeURIComponent(order.id)}`, { method: 'PUT', body: JSON.stringify(next) });
        orders = orders.map((item) => String(item.id) === String(order.id) ? result.order : item);
        renderOrders();
        notify('Pedido atualizado.');
      } catch (error) {
        card.classList.remove('order-saving');
        setMessage($('#app-message'), error.message, 'error');
      }
    }
  });

  if (!apiBase) setMessage($('#login-message'), 'O link do serviço ainda precisa ser configurado no Render.', 'error');
  if (token) {
    loadCatalog().then(() => {
      setLoggedIn(true);
      switchWorkspace('orders');
      loadOrders().catch((error) => setMessage($('#app-message'), error.message, 'error'));
    }).catch((error) => {
      logout(false);
      setMessage($('#login-message'), error.message, 'error');
    });
  }
  window.setInterval(() => {
    if (token && currentWorkspace === 'orders') loadOrders().catch((error) => setMessage($('#app-message'), error.message, 'error'));
  }, 45_000);
})();
