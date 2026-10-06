// The window's script. Plain ES5-style code with no template literals, so it can sit verbatim inside String.raw.
export const SCRIPT = String.raw`
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('t') || '';
  var S = { info: null, docs: [], jobs: new Map(), recent: [], view: 'home', ui: {}, lastDoc: null, mine: new Set(), pendingTool: null };
  var D = null; // the built document view: { id, rev, frames, ... }
  var $ = function (id) { return document.getElementById(id); };

  // ---------- helpers ----------
  function q(path) { return path + (path.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(token); }
  function api(method, path, body, headers) {
    var init = { method: method, headers: headers || {} };
    if (body instanceof Blob) { init.body = body; init.headers['content-type'] = 'application/pdf'; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    return fetch(q(path), init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  function append(el, kids) {
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  var ICONS = {
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    export: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 15h7M13 12l3 3-3 3"/>',
    ocr: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
    organize: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    combine: '<rect x="3" y="3" width="9" height="12" rx="1.5"/><rect x="12" y="9" width="9" height="12" rx="1.5"/>',
    split: '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M2 12h2M8 12h2M14 12h2M20 12h2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    rotl: '<path d="M4 4v6h6"/><path d="M5 15a8 8 0 1 0 1.8-8.4L4 10"/>',
    rotr: '<path d="M20 4v6h-6"/><path d="M19 15a8 8 0 1 1-1.8-8.4L20 10"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    extract: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14l3 3 3-3"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
    tools: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M17 14v6M14 17h6"/>',
    fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
    check: '<path d="M5 12l5 5 9-10"/>'
  };
  function icon(name) {
    var wrap = document.createElement('span');
    wrap.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return wrap.firstChild;
  }
  function size(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
  function ago(ms) {
    var s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString();
  }
  function toast(text, kind, action) {
    var el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, h('span', { style: { flex: '1' } }, text), action ? h('button', { onclick: function () { action.run(); el.remove(); } }, action.label) : null);
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'error' ? 9000 : 5000);
  }
  function docById(id) { return S.docs.find(function (d) { return d.id === id; }) || null; }
  function ui(id) {
    if (!S.ui[id]) {
      var doc = docById(id);
      S.ui[id] = { zoom: 'fit', page: 0, tool: 'export', rail: true, panel: true, search: { q: '', hits: [], at: -1 }, org: null, folder: null };
      if (doc && S.info) S.ui[id].folder = doc.path ? folderOf(doc.path) : S.info.outDir;
    }
    return S.ui[id];
  }
  function folderOf(path) { var i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')); return i > 0 ? path.slice(0, i) : path; }

  var TOOLS = [
    { id: 'export', name: 'Export PDF', icon: 'export', desc: 'Convert to Word, Excel, PowerPoint or OpenDocument. Scanned pages are read with OCR.' },
    { id: 'ocr', name: 'Scan & OCR', icon: 'ocr', desc: 'Recognise the text in scanned pages so the PDF can be searched and copied from.' },
    { id: 'organize', name: 'Organize Pages', icon: 'organize', desc: 'Reorder, rotate, delete and extract pages.' },
    { id: 'combine', name: 'Combine Files', icon: 'combine', desc: 'Merge several PDFs into one document.' },
    { id: 'split', name: 'Split PDF', icon: 'split', desc: 'Divide a PDF into several files, by page count or page ranges.' },
    { id: 'images', name: 'Export Images', icon: 'image', desc: 'Save pages as PNG or JPG pictures.' },
    { id: 'search', name: 'Find Text', icon: 'search', desc: 'Search a document and jump between the matches.' },
    { id: 'info', name: 'Document Properties', icon: 'info', desc: 'File location, page count, page size and title.' }
  ];
  var PANEL_TOOLS = ['export', 'ocr', 'organize', 'split', 'images', 'info'];
  var FORMAT_NAMES = { docx: 'Word (.docx)', xlsx: 'Excel (.xlsx)', pptx: 'PowerPoint (.pptx)', odt: 'OpenDocument Text (.odt)', ods: 'OpenDocument Sheet (.ods)', odp: 'OpenDocument Slides (.odp)' };

  // ---------- opening files ----------
  function afterOpen(ids) {
    if (!ids.length) return;
    var id = ids[ids.length - 1];
    if (S.pendingTool) { ui(id).tool = S.pendingTool === 'search' ? ui(id).tool : S.pendingTool; var t = S.pendingTool; S.pendingTool = null; go(id); if (t === 'search') focusSearch(); }
    else go(id);
  }
  function askPassword(name) {
    return new Promise(function (resolve) {
      var input = h('input', { type: 'password', placeholder: 'Password', style: { width: '100%' } });
      var close = modal(h('div', null,
        h('h3', { text: 'Password required' }),
        h('p', { class: 'muted', text: name + ' is protected. Enter its password to open it.' }),
        input,
        h('div', { class: 'buttons' },
          h('button', { class: 'outline', onclick: function () { close(); resolve(null); } }, 'Cancel'),
          h('button', { class: 'primary', onclick: function () { close(); resolve(input.value); } }, 'Open'))));
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { close(); resolve(input.value); } });
      setTimeout(function () { input.focus(); }, 0);
    });
  }
  function openPath(path, password) {
    return api('POST', '/api/open', { path: path, password: password }).then(function (r) { afterOpen([r.id]); }).catch(function (err) {
      if (err.status === 401) return askPassword(path.split(/[\\/]/).pop()).then(function (pw) { if (pw !== null) return openPath(path, pw); });
      toast(err.message, 'error');
    });
  }
  function openFiles() {
    if (S.info && S.info.dialogs) {
      api('POST', '/api/open-dialog').then(function (r) {
        var chain = Promise.resolve();
        r.errors.forEach(function (e) {
          chain = chain.then(function () {
            if (e.needsPassword) return askPassword(e.path.split(/[\\/]/).pop()).then(function (pw) { if (pw !== null) return openPath(e.path, pw); });
            toast(e.error, 'error');
          });
        });
        afterOpen(r.opened);
      }).catch(function (err) { toast(err.message, 'error'); });
    } else $('file-input').click();
  }
  function uploadFile(file, password) {
    var headers = password ? { 'x-scan2doc-password': encodeURIComponent(password) } : {};
    return api('POST', '/api/upload?name=' + encodeURIComponent(file.name), file, headers).then(function (r) { return r.id; }).catch(function (err) {
      if (err.status === 401) return askPassword(file.name).then(function (pw) { return pw === null ? null : uploadFile(file, pw); });
      toast(file.name + ': ' + err.message, 'error');
      return null;
    });
  }
  function uploadAll(files) {
    var ids = [];
    var chain = Promise.resolve();
    Array.prototype.forEach.call(files, function (f) {
      chain = chain.then(function () { return uploadFile(f).then(function (id) { if (id) ids.push(id); }); });
    });
    return chain.then(function () { afterOpen(ids); return ids; });
  }

  // ---------- navigation ----------
  function go(view) {
    S.view = view;
    if (docById(view)) S.lastDoc = view;
    render();
  }
  function closeDoc(id) {
    var doc = docById(id);
    if (doc && doc.dirty && !confirm(doc.name + ' has changes that are not saved. Close it anyway?')) return;
    api('POST', '/api/docs/' + id + '/close').then(function () {
      delete S.ui[id];
      var rest = S.docs.filter(function (d) { return d.id !== id; });
      if (S.view === id) go(rest.length ? rest[rest.length - 1].id : 'home');
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  function useTool(id) {
    if (id === 'combine') return openCombine();
    var target = docById(S.view) ? S.view : docById(S.lastDoc) ? S.lastDoc : null;
    if (!target) { S.pendingTool = id; return openFiles(); }
    if (id !== 'search') ui(target).tool = id;
    go(target);
    if (id === 'search') focusSearch();
  }

  // ---------- render ----------
  function render() {
    renderTabs();
    var doc = docById(S.view);
    if (doc) {
      if (!D || D.id !== doc.id || D.rev !== doc.rev || D.organize !== (ui(doc.id).tool === 'organize')) buildDoc(doc);
      else { renderPane(); updateDocBar(); }
      return;
    }
    D = null;
    if (S.view !== 'tools') S.view = 'home';
    var view = $('view');
    view.textContent = '';
    view.appendChild(S.view === 'tools' ? buildTools() : buildHome());
  }
  function renderTabs() {
    var tabs = $('tabs');
    tabs.textContent = '';
    function tab(id, label, ic) {
      return h('div', { class: 'tab' + (S.view === id ? ' active' : ''), role: 'tab', tabindex: '0', onclick: function () { go(id); }, onkeydown: function (e) { if (e.key === 'Enter') go(id); } }, icon(ic), h('span', { class: 'label', text: label }));
    }
    tabs.appendChild(tab('home', 'Home', 'home'));
    tabs.appendChild(tab('tools', 'Tools', 'tools'));
    S.docs.forEach(function (d) {
      var t = tab(d.id, d.name, 'file');
      t.title = d.path || d.name;
      if (d.dirty) t.appendChild(h('span', { class: 'dot', title: 'Not saved' }, '•'));
      t.appendChild(h('span', { class: 'x', title: 'Close (Ctrl+W)', onclick: function (e) { e.stopPropagation(); closeDoc(d.id); } }, icon('x')));
      tabs.appendChild(t);
    });
    var actions = $('bar-actions');
    actions.textContent = '';
    actions.appendChild(h('button', { class: 'outline', title: 'Open (Ctrl+O)', onclick: openFiles }, icon('open'), 'Open'));
  }

  function toolCard(t) {
    return h('button', { class: 'card', onclick: function () { useTool(t.id); } }, h('div', { class: 'ic' }, icon(t.icon)), h('div', null, h('b', { text: t.name }), h('span', { class: 'd', text: t.desc })));
  }
  function buildHome() {
    var recent = S.recent.length
      ? h('table', { class: 'list' },
          h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Folder' }), h('th', { text: 'Opened' }), h('th'))),
          h('tbody', null, S.recent.map(function (r) {
            return h('tr', { class: 'row', onclick: function () { openPath(r.path); }, title: r.path },
              h('td', null, h('div', { class: 'file-name' }, icon('file'), r.name)),
              h('td', { class: 'muted small', text: r.folder }),
              h('td', { class: 'muted small', text: ago(r.openedAt) }),
              h('td', { style: { width: '1%' } }, h('button', { title: 'Remove from this list', onclick: function (e) { e.stopPropagation(); api('POST', '/api/recent/remove', { path: r.path }); } }, icon('x'))));
          })))
      : h('div', { class: 'empty' }, S.info && S.info.dialogs ? 'Files you open will be listed here.' : 'Files you open from your computer are listed here.');
    var jobs = Array.from(S.jobs.values()).reverse().slice(0, 8);
    return h('div', { class: 'page-scroll' }, h('div', { class: 'home' },
      h('h1', { text: 'Welcome to Scan2Doc' }),
      h('div', { class: 'muted', text: 'Open a PDF to view, search, organise and convert it. Everything stays on this computer.' }),
      h('div', { class: 'hero' },
        h('div', { class: 'drop' },
          icon('file'),
          h('strong', { text: 'Drop PDF files anywhere in this window' }),
          h('span', { class: 'muted', text: 'or' }),
          h('button', { class: 'primary', onclick: openFiles }, icon('open'), 'Open files…')),
        h('div', { class: 'quick' }, TOOLS.slice(0, 4).map(toolCard))),
      h('h2', { text: 'Recent files' }),
      recent,
      jobs.length ? [h('h2', { text: 'Recent tasks' }), h('div', { class: 'jobs' }, jobs.map(jobCard))] : null));
  }
  function buildTools() {
    return h('div', { class: 'page-scroll' }, h('div', { class: 'home' },
      h('h1', { text: 'All tools' }),
      h('div', { class: 'muted', text: S.lastDoc && docById(S.lastDoc) ? 'Tools open on ' + docById(S.lastDoc).name + '.' : 'Pick a tool, then choose the PDF to use it on.' }),
      h('div', { class: 'tools-grid', style: { marginTop: '18px' } }, TOOLS.map(toolCard))));
  }

  // ---------- document view ----------
  function pageUrl(doc, i, w) { return q('/api/docs/' + doc.id + '/page/' + i + '?w=' + Math.round(w) + '&r=' + doc.rev); }
  function buildDoc(doc) {
    if (D && D.observer) D.observer.disconnect();
    var st = ui(doc.id);
    var organize = st.tool === 'organize';
    D = { id: doc.id, rev: doc.rev, organize: organize, frames: [], thumbs: [], visible: new Set() };
    var view = $('view');
    view.textContent = '';
    var bar = buildDocBar(doc);
    var body = h('div', { class: 'doc-body' });
    D.rail = h('aside', { class: 'rail' + (st.rail && !organize ? '' : ' hidden') });
    doc.pages.forEach(function (p, i) {
      var t = h('div', { class: 'thumb', onclick: function () { scrollToPage(i); } },
        h('div', { class: 'frame', style: { aspectRatio: p.widthPt + ' / ' + p.heightPt } }, h('img', { loading: 'lazy', alt: '', src: pageUrl(doc, i, 224) })),
        String(i + 1));
      D.thumbs.push(t);
      D.rail.appendChild(t);
    });
    body.appendChild(D.rail);
    body.appendChild(organize ? buildOrganize(doc) : buildViewer(doc));
    D.panel = h('aside', { class: 'panel' + (st.panel ? '' : ' hidden') });
    D.strip = h('div', { class: 'toolstrip' });
    D.pane = h('div', { class: 'toolpane' });
    D.panel.appendChild(D.strip);
    D.panel.appendChild(D.pane);
    body.appendChild(D.panel);
    view.appendChild(h('div', { class: 'doc' }, bar, body));
    renderPane();
    if (!organize) {
      layoutPages();
      requestAnimationFrame(function () { scrollToPage(st.page, true); drawHits(); });
    }
  }
  function buildDocBar(doc) {
    var st = ui(doc.id);
    D.pageInput = h('input', { type: 'text', class: 'pg', value: String(st.page + 1), 'aria-label': 'Page number', onchange: function () { var n = parseInt(D.pageInput.value, 10); if (n >= 1 && n <= doc.pages.length) scrollToPage(n - 1); else D.pageInput.value = String(st.page + 1); } });
    D.zoomLabel = h('span', { class: 'zoom muted small' });
    D.searchInput = h('input', { type: 'text', placeholder: 'Find in document', value: st.search.q, 'aria-label': 'Find text', onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); search(D.searchInput.value, e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { D.searchInput.value = ''; search('', 1); } } });
    D.searchCount = h('span', { class: 'muted small' });
    return h('div', { class: 'doc-bar' },
      h('button', { title: 'Page thumbnails', onclick: function () { st.rail = !st.rail; D.rail.classList.toggle('hidden', !st.rail || st.tool === 'organize'); layoutPages(); } }, icon('sidebar')),
      h('span', { class: 'sep' }),
      h('button', { title: 'Previous page', onclick: function () { scrollToPage(Math.max(0, st.page - 1)); } }, icon('up')),
      h('button', { title: 'Next page', onclick: function () { scrollToPage(Math.min(doc.pages.length - 1, st.page + 1)); } }, icon('down')),
      D.pageInput, h('span', { class: 'muted small', text: '/ ' + doc.pages.length }),
      h('span', { class: 'sep' }),
      h('button', { title: 'Zoom out (Ctrl+-)', onclick: function () { zoomBy(1 / 1.2); } }, icon('minus')),
      D.zoomLabel,
      h('button', { title: 'Zoom in (Ctrl+=)', onclick: function () { zoomBy(1.2); } }, icon('plus')),
      h('button', { title: 'Fit width', onclick: function () { st.zoom = 'fit'; layoutPages(); } }, icon('fit')),
      h('div', { class: 'search' }, icon('search'), D.searchInput, D.searchCount,
        h('button', { title: 'Previous match (Shift+Enter)', onclick: function () { search(D.searchInput.value, -1); } }, icon('left')),
        h('button', { title: 'Next match (Enter)', onclick: function () { search(D.searchInput.value, 1); } }, icon('right'))),
      h('span', { class: 'spacer' }),
      h('button', { class: 'outline', title: 'Save (Ctrl+S)', onclick: function () { save(doc.id, false); } }, icon('save'), 'Save'),
      h('button', { class: 'outline', title: 'Save a copy as… (Ctrl+Shift+S)', onclick: function () { save(doc.id, true); } }, 'Save as…'),
      h('button', { title: 'Tools panel', onclick: function () { st.panel = !st.panel; D.panel.classList.toggle('hidden', !st.panel); layoutPages(); } }, icon('panel')));
  }
  function updateDocBar() {
    if (!D || !D.pageInput) return;
    var st = ui(D.id);
    if (document.activeElement !== D.pageInput) D.pageInput.value = String(st.page + 1);
    D.thumbs.forEach(function (t, i) { t.classList.toggle('active', i === st.page); });
  }
  function buildViewer(doc) {
    D.viewer = h('div', { class: 'viewer', tabindex: '0' });
    D.pages = h('div', { class: 'pages' });
    D.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var i = Number(en.target.dataset.i);
        if (en.isIntersecting) { D.visible.add(i); var f = D.frames[i]; if (f.img.getAttribute('src') !== f.want) f.img.src = f.want; }
        else D.visible.delete(i);
      });
    }, { root: D.viewer, rootMargin: '800px 0px' });
    doc.pages.forEach(function (p, i) {
      var img = h('img', { alt: 'Page ' + (i + 1), draggable: 'false' });
      var sheet = h('div', { class: 'sheet', 'data-i': String(i) }, img, h('span', { class: 'num', text: String(i + 1) }));
      D.frames.push({ el: sheet, img: img, want: '', w: 0, h: 0 });
      D.pages.appendChild(sheet);
      D.observer.observe(sheet);
    });
    D.viewer.appendChild(D.pages);
    var ticking = false;
    D.viewer.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; trackPage(); });
    });
    D.viewer.addEventListener('wheel', function (e) { if (e.ctrlKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
    window.addEventListener('resize', onResize);
    return D.viewer;
  }
  function onResize() { if (D && D.viewer && ui(D.id).zoom === 'fit') layoutPages(); }
  function scale(doc) {
    var st = ui(doc.id);
    if (st.zoom !== 'fit') return st.zoom;
    var widest = Math.max.apply(null, doc.pages.map(function (p) { return p.widthPt; }));
    var room = Math.max(200, (D.viewer ? D.viewer.clientWidth : 800) - 40);
    return Math.min(room / (widest * 96 / 72), 2.5);
  }
  function layoutPages() {
    var doc = docById(D && D.id);
    if (!doc || !D.viewer) return;
    var keep = ui(doc.id).page;
    var s = scale(doc);
    var dpr = window.devicePixelRatio || 1;
    doc.pages.forEach(function (p, i) {
      var f = D.frames[i];
      f.w = Math.round(p.widthPt * 96 / 72 * s);
      f.h = Math.round(p.heightPt * 96 / 72 * s);
      f.el.style.width = f.w + 'px';
      f.el.style.height = f.h + 'px';
      f.want = pageUrl(doc, i, f.w * dpr);
      if (D.visible.has(i)) f.img.src = f.want;
    });
    D.zoomLabel.textContent = Math.round(s * 100) + '%';
    scrollToPage(keep, true);
  }
  function zoomBy(factor) {
    var doc = docById(D && D.id);
    if (!doc || !D.viewer) return;
    var st = ui(doc.id);
    st.zoom = Math.min(5, Math.max(0.1, scale(doc) * factor));
    layoutPages();
  }
  function scrollToPage(i, instant) {
    if (!D || !D.viewer || !D.frames[i]) return;
    var st = ui(D.id);
    st.page = i;
    D.viewer.scrollTo({ top: D.frames[i].el.offsetTop - 12, behavior: instant ? 'auto' : 'smooth' });
    updateDocBar();
  }
  function trackPage() {
    if (!D || !D.viewer) return;
    var mid = D.viewer.scrollTop + D.viewer.clientHeight / 3;
    var current = 0;
    D.frames.forEach(function (f, i) { if (f.el.offsetTop <= mid) current = i; });
    var st = ui(D.id);
    if (st.page !== current) { st.page = current; updateDocBar(); var t = D.thumbs[current]; if (t) t.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------- search ----------
  function focusSearch() { setTimeout(function () { if (D && D.searchInput) { D.searchInput.focus(); D.searchInput.select(); } }, 30); }
  function search(text, step) {
    if (!D) return;
    var st = ui(D.id);
    var s = st.search;
    if (text.trim() && text === s.q && s.hits.length) {
      s.at = (s.at + step + s.hits.length) % s.hits.length;
      return showHit();
    }
    s.q = text; s.hits = []; s.at = -1;
    if (!text.trim()) { drawHits(); D.searchCount.textContent = ''; return; }
    api('GET', '/api/docs/' + D.id + '/search?q=' + encodeURIComponent(text)).then(function (r) {
      s.hits = r.hits;
      if (!r.hits.length) { D.searchCount.textContent = 'No matches'; drawHits(); toast('No matches for "' + text + '". Scanned pages need Scan & OCR before they can be searched.'); return; }
      var after = r.hits.findIndex(function (hit) { return hit.page >= st.page; });
      s.at = after < 0 ? 0 : after;
      showHit();
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  function drawHits() {
    if (!D || !D.frames) return;
    var s = ui(D.id).search;
    D.frames.forEach(function (f) { Array.prototype.slice.call(f.el.querySelectorAll('.hl')).forEach(function (n) { n.remove(); }); });
    s.hits.forEach(function (hit, k) {
      var f = D.frames[hit.page];
      if (!f) return;
      hit.rects.forEach(function (r) {
        f.el.appendChild(h('div', { class: 'hl' + (k === s.at ? ' active' : ''), style: { left: (r.x * 100) + '%', top: (r.y * 100) + '%', width: (r.w * 100) + '%', height: (r.h * 100) + '%' } }));
      });
    });
  }
  function showHit() {
    var s = ui(D.id).search;
    drawHits();
    D.searchCount.textContent = (s.at + 1) + ' of ' + s.hits.length;
    var hit = s.hits[s.at];
    var f = D.frames[hit.page];
    if (!f) return;
    var r = hit.rects[0];
    D.viewer.scrollTo({ top: f.el.offsetTop + r.y * f.h - D.viewer.clientHeight / 3, behavior: 'smooth' });
    ui(D.id).page = hit.page;
    updateDocBar();
  }

  // ---------- organize ----------
  function buildOrganize(doc) {
    var st = ui(doc.id);
    if (!st.org) st.org = { pages: doc.pages.map(function (_, i) { return { source: i, rotate: 0 }; }), sel: new Set(), anchor: -1, rev: doc.rev };
    var org = st.org;
    var grid = h('div', { class: 'org-grid' });
    var drag = -1;
    function changed() { return org.pages.length !== doc.pages.length || org.pages.some(function (p, i) { return p.source !== i || p.rotate !== 0; }); }
    function draw() {
      grid.textContent = '';
      org.pages.forEach(function (p, i) {
        var img = h('img', { alt: '', loading: 'lazy', src: pageUrl(doc, p.source, 280), style: { transform: 'rotate(' + p.rotate + 'deg)' } });
        var card = h('div', { class: 'org-page' + (org.sel.has(i) ? ' sel' : ''), draggable: 'true', tabindex: '0', title: 'Page ' + (p.source + 1) },
          h('div', { class: 'frame' }, img), String(i + 1) + (p.source !== i ? ' (was ' + (p.source + 1) + ')' : ''));
        card.addEventListener('click', function (e) {
          if (e.shiftKey && org.anchor >= 0) { var a = Math.min(org.anchor, i), b = Math.max(org.anchor, i); for (var k = a; k <= b; k++) org.sel.add(k); }
          else if (e.ctrlKey || e.metaKey) { if (org.sel.has(i)) org.sel.delete(i); else org.sel.add(i); org.anchor = i; }
          else { org.sel = new Set([i]); org.anchor = i; }
          draw(); renderPane();
        });
        card.addEventListener('dragstart', function (e) { drag = i; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
        card.addEventListener('dragend', function () { drag = -1; draw(); });
        card.addEventListener('dragover', function (e) { if (drag < 0) return; e.preventDefault(); e.stopPropagation(); card.classList.add('drop-before'); });
        card.addEventListener('dragleave', function () { card.classList.remove('drop-before'); });
        card.addEventListener('drop', function (e) {
          if (drag < 0) return;
          e.preventDefault(); e.stopPropagation();
          var moving = org.sel.has(drag) ? Array.from(org.sel).sort(function (a, b) { return a - b; }) : [drag];
          var items = moving.map(function (k) { return org.pages[k]; });
          var target = org.pages[i];
          org.pages = org.pages.filter(function (_, k) { return moving.indexOf(k) < 0; });
          var at = moving.indexOf(i) >= 0 ? Math.min(moving[0], org.pages.length) : org.pages.indexOf(target);
          Array.prototype.splice.apply(org.pages, [at, 0].concat(items));
          org.sel = new Set(items.map(function (_, k) { return at + k; }));
          draw(); renderPane();
        });
        grid.appendChild(card);
      });
    }
    function selected() { return Array.from(org.sel).sort(function (a, b) { return a - b; }); }
    function rotate(by) { selected().forEach(function (k) { org.pages[k].rotate = (org.pages[k].rotate + by + 360) % 360; }); draw(); renderPane(); }
    function remove() {
      var sel = selected();
      if (sel.length >= org.pages.length) return toast('A PDF needs at least one page.', 'error');
      org.pages = org.pages.filter(function (_, k) { return sel.indexOf(k) < 0; });
      org.sel = new Set(); draw(); renderPane();
    }
    D.orgActions = {
      rotate: rotate, remove: remove, changed: changed, selected: selected,
      selectAll: function () { org.sel = new Set(org.pages.map(function (_, k) { return k; })); draw(); renderPane(); },
      reset: function () { st.org = null; buildDoc(doc); },
      apply: function () {
        api('POST', '/api/docs/' + doc.id + '/organize', { pages: org.pages }).then(function () { st.org = null; toast('Pages updated. Save to keep the changes.'); })
          .catch(function (err) { toast(err.message, 'error'); });
      },
      extract: function () {
        var sel = selected();
        if (!sel.length) return toast('Select the pages to extract first.', 'error');
        api('POST', '/api/docs/' + doc.id + '/extract', { pages: sel.map(function (k) { return org.pages[k].source; }) }).then(function (r) { go(r.id); toast('Extracted ' + sel.length + ' page' + (sel.length === 1 ? '' : 's') + ' into a new document.'); })
          .catch(function (err) { toast(err.message, 'error'); });
      }
    };
    draw();
    var bar = h('div', { class: 'org-bar' },
      h('button', { onclick: function () { D.orgActions.selectAll(); } }, 'Select all'),
      h('span', { class: 'sep' }),
      h('button', { title: 'Rotate left', onclick: function () { rotate(-90); } }, icon('rotl'), 'Left'),
      h('button', { title: 'Rotate right', onclick: function () { rotate(90); } }, icon('rotr'), 'Right'),
      h('button', { class: 'danger', title: 'Delete (Del)', onclick: remove }, icon('trash'), 'Delete'),
      h('button', { title: 'Extract to a new document', onclick: function () { D.orgActions.extract(); } }, icon('extract'), 'Extract'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small', text: 'Drag pages to reorder. Ctrl/Shift+click selects several.' }));
    var wrap = h('div', { class: 'organize', tabindex: '0', onkeydown: function (e) { if (e.key === 'Delete') remove(); if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); D.orgActions.selectAll(); } } }, bar, grid);
    return wrap;
  }

  // ---------- tool panel ----------
  function renderPane() {
    if (!D || !D.pane) return;
    var doc = docById(D.id);
    if (!doc) return;
    var st = ui(doc.id);
    D.strip.textContent = '';
    PANEL_TOOLS.forEach(function (id) {
      var t = TOOLS.find(function (x) { return x.id === id; });
      D.strip.appendChild(h('button', { class: st.tool === id ? 'on' : '', title: t.name, onclick: function () {
        var wasOrg = st.tool === 'organize';
        st.tool = id;
        if (wasOrg !== (id === 'organize')) buildDoc(doc); else renderPane();
      } }, icon(t.icon)));
    });
    var pane = D.pane;
    var keep = pane.scrollTop;
    pane.textContent = '';
    var builder = { export: paneExport, ocr: paneOcr, organize: paneOrganize, split: paneSplit, images: paneImages, info: paneInfo }[st.tool] || paneExport;
    pane.appendChild(builder(doc, st));
    pane.scrollTop = keep;
  }
  function langSelect(st, key) {
    var sel = h('select', { onchange: function () { st[key] = sel.value; } }, h('option', { value: 'auto', text: 'Detect automatically' }));
    S.info.languages.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (l) { sel.appendChild(h('option', { value: l.code, text: l.name, selected: st[key] === l.code })); });
    return sel;
  }
  function folderField(st) {
    return h('div', { class: 'field' }, h('span', { class: 'label', text: 'Save to' }),
      h('div', { class: 'folder' }, h('code', { title: st.folder, text: st.folder }),
        S.info.dialogs ? h('button', { class: 'outline', onclick: function () {
          api('POST', '/api/pick-folder', { start: st.folder }).then(function (r) { if (r.path) { st.folder = r.path; renderPane(); } }).catch(function (err) { toast(err.message, 'error'); });
        } }, 'Change…') : null));
  }
  function start(path, body, doc) {
    return api('POST', '/api/docs/' + doc.id + path, body).then(function (r) { S.mine.add(r.job); }).catch(function (err) { toast(err.message, 'error'); });
  }
  function jobsFor(doc, kind) {
    var list = Array.from(S.jobs.values()).filter(function (j) { return j.docId === doc.id && j.kind === kind; }).reverse();
    return list.length ? h('div', { class: 'jobs' }, list.map(jobCard)) : null;
  }
  function jobCard(job) {
    var label = { queued: 'Waiting', running: 'Working…', done: 'Done' + (job.seconds != null ? ' in ' + job.seconds + ' s' : ''), failed: 'Failed' }[job.status];
    return h('div', { class: 'job' },
      h('div', { class: 't' }, h('span', { text: job.title }), h('span', { class: 'st ' + job.status, text: label })),
      job.progress ? [h('div', { class: 'bar' }, h('div', { style: { width: (job.progress.total ? Math.round(100 * job.progress.done / job.progress.total) : 0) + '%' } })), h('div', { class: 'muted small', text: job.progress.text })] : null,
      job.outputs.map(function (o) {
        return h('div', { class: 'out' }, icon('file'), h('span', { class: 'n', title: o.path, text: o.name + ' · ' + size(o.bytes) }),
          h('button', { class: 'outline', onclick: function () { api('POST', '/api/reveal', { path: o.path }).catch(function (err) { toast(err.message, 'error'); }); } }, 'Show in folder'));
      }),
      job.resultDocId && docById(job.resultDocId) ? h('div', { class: 'out' }, icon('file'), h('span', { class: 'n', text: docById(job.resultDocId).name }), h('button', { class: 'outline', onclick: function () { go(job.resultDocId); } }, 'Open')) : null,
      job.notes.map(function (n) { return h('div', { class: 'note', text: n }); }),
      job.error ? h('div', { class: 'err', text: job.error }) : null);
  }
  function paneExport(doc, st) {
    if (!st.formats) st.formats = ['auto'];
    var box = h('div', { class: 'choices' });
    function chip(value, label, wide) {
      var input = h('input', { type: 'checkbox', checked: st.formats.indexOf(value) >= 0, onchange: function () {
        if (value === 'auto') st.formats = input.checked ? ['auto'] : [];
        else { st.formats = st.formats.filter(function (f) { return f !== 'auto' && f !== value; }); if (input.checked) st.formats.push(value); }
        if (!st.formats.length) st.formats = ['auto'];
        renderPane();
      } });
      return h('label', { class: 'choice' + (wide ? ' wide' : '') }, input, label);
    }
    box.appendChild(chip('auto', 'Automatic: Word, Excel or PowerPoint by content', true));
    S.info.formats.forEach(function (f) { box.appendChild(chip(f, FORMAT_NAMES[f] || f)); });
    var pages = h('input', { type: 'text', placeholder: 'All pages, or e.g. 1-3, 5', value: st.exportPages || '', oninput: function () { st.exportPages = pages.value; } });
    return h('div', null,
      h('h3', { text: 'Export PDF' }),
      h('p', { class: 'lead', text: 'Convert into editable Office or OpenDocument files. Text, headings, tables and pictures are rebuilt; scanned pages are read with OCR.' }),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Convert to' }), box),
      h('div', { class: 'field' }, h('label', { text: 'Language of the text' }), langSelect(st, 'lang')),
      h('div', { class: 'field' }, h('label', { text: 'Pages' }), pages),
      folderField(st),
      h('button', { class: 'primary go', onclick: function () { start('/export', { formats: st.formats.join(','), lang: st.lang || 'auto', pages: st.exportPages || '', folder: st.folder }, doc); } }, icon('export'), 'Export'),
      jobsFor(doc, 'export'));
  }
  function paneOcr(doc, st) {
    return h('div', null,
      h('h3', { text: 'Scan & OCR' }),
      h('p', { class: 'lead', text: 'Recognise the text in scanned pages and lay it invisibly under the page images, so the PDF can be searched, selected and copied from. Pages that already have text are left alone. The result opens as a new document; save it to keep it.' }),
      h('div', { class: 'field' }, h('label', { text: 'Language of the text' }), langSelect(st, 'ocrLang')),
      h('button', { class: 'primary go', onclick: function () { start('/ocr', { lang: st.ocrLang || 'auto' }, doc); } }, icon('ocr'), 'Recognise text'),
      jobsFor(doc, 'ocr'));
  }
  function paneOrganize(doc, st) {
    var a = D.orgActions;
    var n = st.org ? st.org.sel.size : 0;
    var changed = a && a.changed();
    return h('div', null,
      h('h3', { text: 'Organize Pages' }),
      h('p', { class: 'lead', text: 'Drag pages to change their order. Select pages to rotate, delete or extract them. Changes apply when you press Apply; then save the document.' }),
      h('dl', { class: 'info' }, h('dt', { text: 'Pages' }), h('dd', { text: String(st.org ? st.org.pages.length : doc.pages.length) }), h('dt', { text: 'Selected' }), h('dd', { text: String(n) })),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
        h('button', { class: 'primary', disabled: !changed, onclick: function () { a.apply(); } }, icon('check'), 'Apply changes'),
        h('button', { class: 'outline', disabled: !changed, onclick: function () { a.reset(); } }, 'Reset')));
  }
  function paneSplit(doc, st) {
    if (!st.splitMode) st.splitMode = 'every';
    var every = h('input', { type: 'number', min: '1', value: String(st.splitEvery || 1), oninput: function () { st.splitEvery = every.value; } });
    var ranges = h('input', { type: 'text', placeholder: 'e.g. 1-3, 4-6, 7', value: st.splitRanges || '', oninput: function () { st.splitRanges = ranges.value; } });
    function radio(value, label, extra) {
      return h('label', { class: 'choice wide' }, h('input', { type: 'radio', name: 'splitmode', checked: st.splitMode === value, onchange: function () { st.splitMode = value; renderPane(); } }), label, extra);
    }
    return h('div', null,
      h('h3', { text: 'Split PDF' }),
      h('p', { class: 'lead', text: 'Divide ' + doc.name + ' (' + doc.pages.length + ' pages) into several PDFs.' }),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Split' }), h('div', { class: 'choices' }, radio('every', 'Every N pages'), radio('ranges', 'By page ranges'))),
      st.splitMode === 'every' ? h('div', { class: 'field' }, h('label', { text: 'Pages per file' }), every) : h('div', { class: 'field' }, h('label', { text: 'One file per range' }), ranges),
      folderField(st),
      h('button', { class: 'primary go', onclick: function () { start('/split', { mode: st.splitMode, every: Number(st.splitEvery || 1), ranges: st.splitRanges || '', folder: st.folder }, doc); } }, icon('split'), 'Split'),
      jobsFor(doc, 'split'));
  }
  function paneImages(doc, st) {
    if (!st.imgFormat) st.imgFormat = 'png';
    var dpi = h('select', { onchange: function () { st.imgDpi = dpi.value; } }, [72, 150, 300, 600].map(function (v) { return h('option', { value: String(v), text: v + ' dpi' + (v === 150 ? ' (screen)' : v === 300 ? ' (print)' : ''), selected: String(st.imgDpi || 150) === String(v) }); }));
    var pages = h('input', { type: 'text', placeholder: 'All pages, or e.g. 1-3, 5', value: st.imgPages || '', oninput: function () { st.imgPages = pages.value; } });
    function radio(value, label) { return h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'imgfmt', checked: st.imgFormat === value, onchange: function () { st.imgFormat = value; } }), label); }
    return h('div', null,
      h('h3', { text: 'Export Images' }),
      h('p', { class: 'lead', text: 'Save each page as a picture.' }),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Format' }), h('div', { class: 'choices' }, radio('png', 'PNG (sharp)'), radio('jpg', 'JPG (smaller)'))),
      h('div', { class: 'field' }, h('label', { text: 'Resolution' }), dpi),
      h('div', { class: 'field' }, h('label', { text: 'Pages' }), pages),
      folderField(st),
      h('button', { class: 'primary go', onclick: function () { start('/images', { format: st.imgFormat, dpi: Number(st.imgDpi || 150), pages: st.imgPages || '', folder: st.folder }, doc); } }, icon('image'), 'Export images'),
      jobsFor(doc, 'images'));
  }
  function paneInfo(doc) {
    var p = doc.pages[0];
    var mm = function (pt) { return Math.round(pt / 72 * 25.4); };
    return h('div', null,
      h('h3', { text: 'Document Properties' }),
      h('dl', { class: 'info', style: { marginTop: '12px' } },
        h('dt', { text: 'File' }), h('dd', { text: doc.name }),
        h('dt', { text: 'Location' }), h('dd', { text: doc.path ? folderOf(doc.path) : 'Not saved yet' }),
        h('dt', { text: 'Title' }), h('dd', { text: doc.title || '—' }),
        h('dt', { text: 'Pages' }), h('dd', { text: String(doc.pages.length) }),
        h('dt', { text: 'Page size' }), h('dd', { text: mm(p.widthPt) + ' × ' + mm(p.heightPt) + ' mm' }),
        h('dt', { text: 'File size' }), h('dd', { text: size(doc.bytes) }),
        h('dt', { text: 'Status' }), h('dd', { text: doc.dirty ? 'Changed, not saved' : 'Saved' })));
  }

  // ---------- combine ----------
  function modal(content) {
    var scrim = h('div', { class: 'scrim', onclick: function (e) { if (e.target === scrim) close(); } }, h('div', { class: 'dialog', role: 'dialog' }, content));
    function close() { scrim.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    document.body.appendChild(scrim);
    return close;
  }
  function openCombine() {
    var order = S.docs.map(function (d) { return d.id; });
    var chosen = new Set(order);
    var list = h('div', { class: 'combine-list' });
    var go2;
    function draw() {
      order = order.filter(function (id) { return docById(id); });
      S.docs.forEach(function (d) { if (order.indexOf(d.id) < 0) { order.push(d.id); chosen.add(d.id); } });
      list.textContent = '';
      if (!order.length) list.appendChild(h('div', { class: 'empty', text: 'Add the PDFs to combine.' }));
      order.forEach(function (id, i) {
        var d = docById(id);
        list.appendChild(h('div', { class: 'combine-item' },
          h('input', { type: 'checkbox', checked: chosen.has(id), onchange: function (e) { if (e.target.checked) chosen.add(id); else chosen.delete(id); draw(); } }),
          icon('file'), h('span', { class: 'n', text: d.name + ' · ' + d.pages.length + ' p.' }),
          h('button', { title: 'Move up', disabled: i === 0, onclick: function () { order.splice(i - 1, 0, order.splice(i, 1)[0]); draw(); } }, icon('up')),
          h('button', { title: 'Move down', disabled: i === order.length - 1, onclick: function () { order.splice(i + 1, 0, order.splice(i, 1)[0]); draw(); } }, icon('down'))));
      });
      if (go2) go2.disabled = order.filter(function (id) { return chosen.has(id); }).length < 2;
    }
    go2 = h('button', { class: 'primary', onclick: function () {
      var ids = order.filter(function (id) { return chosen.has(id); });
      api('POST', '/api/combine', { ids: ids }).then(function (r) { close(); go(r.id); toast('Combined ' + ids.length + ' files. Save the result to keep it.'); }).catch(function (err) { toast(err.message, 'error'); });
    } }, icon('combine'), 'Combine');
    var close = modal(h('div', null,
      h('h3', { text: 'Combine Files' }),
      h('p', { class: 'muted', text: 'The checked documents are joined in this order into a new PDF.' }),
      list,
      h('button', { class: 'outline', onclick: function () { S.pendingTool = null; openFiles(); } }, icon('open'), 'Add files…'),
      h('div', { class: 'buttons' }, h('button', { class: 'outline', onclick: function () { close(); } }, 'Cancel'), go2)));
    draw();
    S.redrawCombine = draw;
  }

  // ---------- saving ----------
  function save(id, as) {
    var doc = docById(id);
    if (!doc) return;
    api('POST', '/api/docs/' + id + (as || !doc.path ? '/save-as' : '/save')).then(function (r) { if (r.path) toast('Saved ' + r.path); }).catch(function (err) { toast(err.message, 'error'); });
  }

  // ---------- events from the app ----------
  function onEvent(ev) {
    if (ev.type === 'docs') {
      S.docs = ev.docs;
      if (S.redrawCombine && document.querySelector('.combine-list')) S.redrawCombine();
      if (D && !docById(D.id)) { D = null; if (S.view !== 'home' && S.view !== 'tools' && !docById(S.view)) S.view = 'home'; }
      render();
    } else if (ev.type === 'job') {
      var before = S.jobs.get(ev.job.id);
      S.jobs.set(ev.job.id, ev.job);
      var finished = ev.job.status === 'done' || ev.job.status === 'failed';
      if (S.mine.has(ev.job.id) && finished && (!before || before.status !== ev.job.status)) {
        if (ev.job.status === 'failed') toast(ev.job.title + ' failed: ' + ev.job.error, 'error');
        else if (ev.job.resultDocId) { go(ev.job.resultDocId); toast('Text recognised. Save the searchable copy to keep it.'); }
        else if (ev.job.outputs.length) toast(ev.job.title + ': ' + ev.job.outputs.length + ' file' + (ev.job.outputs.length === 1 ? '' : 's') + ' saved.', null, { label: 'Show', run: function () { api('POST', '/api/reveal', { path: ev.job.outputs[0].path }); } });
      }
      if (D) renderPane(); else if (S.view === 'home') render();
    } else if (ev.type === 'recent') {
      S.recent = ev.recent;
      if (S.view === 'home') render();
    }
  }
  function connect() {
    var es = new EventSource(q('/api/events'));
    var failures = 0;
    es.onopen = function () { failures = 0; };
    es.onmessage = function (e) { onEvent(JSON.parse(e.data)); };
    es.onerror = function () { if (++failures > 4) { es.close(); document.body.classList.add('stopped'); } };
  }

  // ---------- window-wide input ----------
  $('file-input').addEventListener('change', function (e) { uploadAll(e.target.files); e.target.value = ''; });
  var depth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { depth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    var files = Array.prototype.filter.call(e.dataTransfer.files, function (f) { return /\.pdf$/i.test(f.name) || f.type === 'application/pdf'; });
    if (!files.length) { if (e.dataTransfer.files.length) toast('Only PDF files can be opened.', 'error'); return; }
    uploadAll(files);
  });
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var key = e.key.toLowerCase();
    var doc = docById(S.view);
    if (key === 'o') { e.preventDefault(); openFiles(); }
    else if (key === 's' && doc) { e.preventDefault(); save(doc.id, e.shiftKey); }
    else if (key === 'f' && doc) { e.preventDefault(); if (ui(doc.id).tool === 'organize') { ui(doc.id).tool = 'export'; buildDoc(doc); } focusSearch(); }
    else if (key === 'w' && doc) { e.preventDefault(); closeDoc(doc.id); }
    else if ((key === '=' || key === '+') && doc) { e.preventDefault(); zoomBy(1.2); }
    else if (key === '-' && doc) { e.preventDefault(); zoomBy(1 / 1.2); }
    else if (key === '0' && doc) { e.preventDefault(); ui(doc.id).zoom = 'fit'; layoutPages(); }
  });
  window.addEventListener('beforeunload', function (e) { if (S.docs.some(function (d) { return d.dirty; })) { e.preventDefault(); e.returnValue = ''; } });

  api('GET', '/api/state').then(function (st) {
    S.info = st;
    S.docs = st.docs;
    S.recent = st.recent;
    st.jobs.forEach(function (j) { S.jobs.set(j.id, j); });
    document.title = 'Scan2Doc';
    render();
    connect();
  }).catch(function (err) {
    document.body.classList.add('stopped');
    console.error(err);
  });
})();
`;
