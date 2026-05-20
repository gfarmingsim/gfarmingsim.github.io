'use strict';

let _uid = 0;
const uid  = () => 'r' + (++_uid);
const esc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const luaQ = s => '"' + String(s ?? '').replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"';

const DEFAULT_CALLBACK_STUB = `-- ┌─────────────────────────────────────────────────────────────┐
-- │      GMod Lua  ·  Client-side  ·  Asynchronous callback     │
-- ├─────────────────────────────────────────────────────────────┘
-- │  The dialogue engine pauses here and waits for a response
-- │  before the player can continue.
-- │
-- ├── To end the response prompt, call:
-- │
-- │       hook.Run("dialogue_engine_response", <boolean>)
-- │
-- ├── This doesn't have to be called immediately — you can send
-- │   a net message to the server and resolve it from the
-- │   net callback once the server responds.
-- │
-- └── If this is never called, the engine times out after ~30 seconds.

`;

const App = {
  speaker:         { name:'', subtitle:'', accent:'#e91e8c' },
  startNode:       'base',
  nodes:           {},
  actionCallbacks: {},

  pan:     { x:160, y:80 },
  editId:  null,
  wiring:  null,

  monacoEdit:   null,
  monacoLua:    null,
  monacoTarget: null,
  _luaCache:    '',
  _ctxItems:    [],

  // ── Init ─────────────────────────────────────────────────────────────────
  init() {
    this._addNode('base', 320, 200);
    this._applyPan();
    this._render();
    this._setupCanvas();
    this._loadMonaco();
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  notify(msg, type = 'info') {
    const wrap = document.getElementById('notif-wrap');
    const el = document.createElement('div');
    el.className = 'notif ' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, 2400);
  },

  // ── Context menu ──────────────────────────────────────────────────────────
  _showCtxMenu(items, x, y) {
    this._ctxItems = items;
    const m = document.getElementById('ctx-menu');
    let h = '';
    items.forEach((item, i) => {
      if (item === null) { h += '<div class="ctx-sep"></div>'; return; }
      h += `<button class="ctx-item${item.danger ? ' danger' : ''}" onclick="App._ctxAction(${i})">${item.label}</button>`;
    });
    m.innerHTML = h;
    m.classList.remove('hidden');
    const mw = m.offsetWidth || 190, mh = m.offsetHeight || 80;
    m.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
    m.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
  },

  _ctxAction(i) {
    this._hideCtxMenu();
    const item = this._ctxItems[i];
    if (item?.action) item.action();
  },

  _hideCtxMenu() {
    document.getElementById('ctx-menu').classList.add('hidden');
  },

  // ── Speaker / start ───────────────────────────────────────────────────────
  syncSpeaker() {
    this.speaker.name     = document.getElementById('sp-name').value;
    this.speaker.subtitle = document.getElementById('sp-subtitle').value;
    this.speaker.accent   = document.getElementById('sp-accent').value;
    document.getElementById('accent-prev').style.background = this.speaker.accent;
  },

  syncStart() {
    this.startNode = document.getElementById('sp-start').value;
    this._renderNodes();
  },

  _updateStartDropdown() {
    const sel = document.getElementById('sp-start');
    const ids = Object.keys(this.nodes);
    sel.innerHTML = ids.map(id =>
      `<option value="${esc(id)}"${id === this.startNode ? ' selected' : ''}>${esc(id)}</option>`
    ).join('');
    if (!this.nodes[this.startNode] && ids.length) {
      this.startNode = ids[0];
      sel.value = this.startNode;
    }
  },

  // ── Node CRUD ─────────────────────────────────────────────────────────────
  _addNode(id, x, y) {
    if (!id) { let n = 1; while (this.nodes['node_' + n]) n++; id = 'node_' + n; }
    this.nodes[id] = { id, x, y, messages: [], responses: [] };
    return id;
  },

  createNode(x, y) {
    if (x == null) {
      x = -this.pan.x + 380 + (Math.random() * 80 - 40);
      y = -this.pan.y + 260 + (Math.random() * 80 - 40);
    }
    const id = this._addNode(null, x, y);
    this._render();
    this.openEditor(id);
    this.notify('Node created', 'ok');
  },

  _renameNode(oldId, newId) {
    newId = newId.trim();
    if (!newId || oldId === newId) return true;
    if (this.nodes[newId]) { alert(`Node "${newId}" already exists.`); return false; }
    this.nodes[newId] = { ...this.nodes[oldId], id: newId };
    delete this.nodes[oldId];
    if (this.startNode === oldId) this.startNode = newId;
    for (const n of Object.values(this.nodes))
      for (const r of n.responses) {
        if (r.next           === oldId) r.next           = newId;
        if (r.action_succeed === oldId) r.action_succeed = newId;
        if (r.action_failure === oldId) r.action_failure = newId;
      }
    if (this.editId === oldId) this.editId = newId;
    this.notify(`Renamed to "${newId}"`, 'ok');
    return true;
  },

  deleteNode(id) {
    if (!confirm(`Delete node "${id}"?`)) return;
    delete this.nodes[id];
    for (const n of Object.values(this.nodes))
      for (const r of n.responses) {
        if (r.next           === id) r.next           = '';
        if (r.action_succeed === id) r.action_succeed = '';
        if (r.action_failure === id) r.action_failure = '';
      }
    if (this.editId === id) {
      this.editId = null;
      document.getElementById('ed-panel').classList.remove('open');
    }
    this._render();
    this.notify(`Deleted "${id}"`, 'err');
  },

  clearAll() {
    if (!confirm('Clear everything?')) return;
    this.nodes = {}; this.actionCallbacks = {}; this.editId = null;
    document.getElementById('ed-panel').classList.remove('open');
    this._addNode('base', 320, 200);
    this._render();
    this.notify('Cleared', 'info');
  },

  _createNodesForResponses(nodeId) {
    const node = this.nodes[nodeId];
    let count = 0, yOff = 0;
    for (const r of node.responses) {
      if (r.type === 'action') {
        if (!r.action_succeed || !this.nodes[r.action_succeed]) {
          r.action_succeed = this._addNode(r.action_succeed || null, node.x + 290, node.y + yOff);
          yOff += 130; count++;
        }
        if (!r.action_failure || !this.nodes[r.action_failure]) {
          r.action_failure = this._addNode(r.action_failure || null, node.x + 290, node.y + yOff);
          yOff += 130; count++;
        }
      } else if (!r.next || !this.nodes[r.next]) {
        r.next = this._addNode(r.next || null, node.x + 290, node.y + yOff);
        yOff += 130; count++;
      }
    }
    this._render();
    this.notify(`Created ${count} node${count !== 1 ? 's' : ''}`, 'ok');
  },

  // ── Render ────────────────────────────────────────────────────────────────
  _render() {
    this._updateStartDropdown();
    this._renderNodes();
    this._renderConnections();
    if (this.editId) this._renderEditor();
  },

  _renderNodes() {
    const cc = document.getElementById('canvas-content');
    cc.innerHTML = '';

    for (const node of Object.values(this.nodes)) {
      const el = document.createElement('div');
      el.className = 'node' + (node.id === this.editId ? ' sel' : '');
      el.dataset.nid = node.id;
      el.style.cssText = `left:${node.x}px;top:${node.y}px`;

      let msgHTML = node.messages.length
        ? node.messages.map(m => `<div class="n-msg">${esc(m)}</div>`).join('')
        : '<div class="n-msg-empty">No messages</div>';

      let respHTML = '';
      if (!node.responses.length) {
        respHTML = '<div class="n-empty">No responses — ends here</div>';
      } else {
        for (const r of node.responses) {
          if (r.type === 'action') {
            respHTML += `<div class="n-resp act">
              <span class="n-resp-label">${esc(r.label || '(unlabeled)')}</span>
              <span class="n-act-badge">⚡ ${esc(r.action || '…')}</span>
              <div class="outport suc" data-nid="${esc(node.id)}" data-rid="${esc(r.id)}" data-port="suc" title="Wire: action_succeed"></div>
              <div class="outport fail" data-nid="${esc(node.id)}" data-rid="${esc(r.id)}" data-port="fail" title="Wire: action_failure"></div>
            </div>`;
          } else {
            respHTML += `<div class="n-resp">
              <span class="n-resp-label">${esc(r.label || '(unlabeled)')}</span>
              <div class="outport" data-nid="${esc(node.id)}" data-rid="${esc(r.id)}" data-port="next" title="Wire: next"></div>
            </div>`;
          }
        }
      }

      el.innerHTML = `
        <div class="n-header" data-nid="${esc(node.id)}">
          <div class="n-inport" data-in="${esc(node.id)}"></div>
          <span class="n-id">${esc(node.id)}</span>
          ${node.id === this.startNode ? '<span class="n-start">START</span>' : ''}
          <button class="n-pencil" data-edit="${esc(node.id)}" title="Edit">✏</button>
        </div>
        <div class="n-msgs">${msgHTML}</div>
        <div class="n-resps">${respHTML}</div>`;

      cc.appendChild(el);
    }
    this._bindNodeEvents(cc);
  },

  _bindNodeEvents(cc) {
    cc.querySelectorAll('.node').forEach(el => {
      // Left-click: complete wire
      el.addEventListener('click', e => {
        if (!this.wiring) return;
        if (e.target.closest('.outport')) return;
        e.stopPropagation();
        this._completeWiring(el.dataset.nid);
      });

      // Left-mousedown: drag (whole node, 4px threshold)
      el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('.n-pencil,.outport,.n-inport')) return;
        if (this.wiring) return;
        const node = this.nodes[el.dataset.nid];
        if (!node) return;
        const ox = node.x, oy = node.y, sx = e.clientX, sy = e.clientY;
        let dragging = false;
        const onMove = ev => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!dragging && Math.hypot(dx, dy) < 4) return;
          dragging = true;
          node.x = ox + dx; node.y = oy + dy;
          const nel = cc.querySelector(`[data-nid="${node.id}"]`);
          if (nel) { nel.style.left = node.x + 'px'; nel.style.top = node.y + 'px'; }
          this._renderConnections();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Right-click: node context menu
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const nodeId = el.dataset.nid;
        const node = this.nodes[nodeId];
        if (!node) return;

        let unconnected = 0;
        for (const r of node.responses) {
          if (r.type === 'action') {
            if (!r.action_succeed || !this.nodes[r.action_succeed]) unconnected++;
            if (!r.action_failure || !this.nodes[r.action_failure]) unconnected++;
          } else if (!r.next || !this.nodes[r.next]) unconnected++;
        }

        const items = [
          { label: `✏ Edit "${nodeId}"`, action: () => this.openEditor(nodeId) },
          { label: '⭐ Set as Start Node', action: () => {
            this.startNode = nodeId;
            this._render();
            this.notify(`"${nodeId}" is now the start node`, 'ok');
          }},
        ];
        if (unconnected > 0) {
          items.push(null);
          items.push({ label: `+ Fill ${unconnected} unconnected port${unconnected !== 1 ? 's' : ''} with new nodes`, action: () => this._createNodesForResponses(nodeId) });
        }
        items.push(null);
        items.push({ label: `🗑 Delete "${nodeId}"`, danger: true, action: () => this.deleteNode(nodeId) });
        this._showCtxMenu(items, e.clientX, e.clientY);
      });
    });

    // Pencil: open editor
    cc.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); this.openEditor(btn.dataset.edit); })
    );

    // Input port: complete wire
    cc.querySelectorAll('.n-inport').forEach(p =>
      p.addEventListener('click', e => {
        if (!this.wiring) return;
        e.stopPropagation();
        this._completeWiring(p.dataset.in);
      })
    );

    // Output port: drag to start wire, release to complete
    cc.querySelectorAll('.outport').forEach(p => {
      p.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        if (this.wiring) this._cancelWiring();
        this._startWiring(p.dataset.nid, p.dataset.rid, p.dataset.port);
        const onUp = ev => {
          document.removeEventListener('mouseup', onUp);
          if (!this.wiring) return;
          const target = document.elementFromPoint(ev.clientX, ev.clientY);
          if (!target || target.closest('.outport')) { this._cancelWiring(); return; }
          const inport = target.closest('.n-inport');
          if (inport?.dataset.in) { this._completeWiring(inport.dataset.in); return; }
          const nodeEl = target.closest('.node[data-nid]');
          if (nodeEl?.dataset.nid) { this._completeWiring(nodeEl.dataset.nid); return; }
          this._cancelWiring();
        };
        document.addEventListener('mouseup', onUp);
      });
    });
  },

  // ── SVG connections ───────────────────────────────────────────────────────
  _portPos(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const wr = document.getElementById('canvas-wrap').getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    return { x: pr.left + pr.width / 2 - wr.left, y: pr.top + pr.height / 2 - wr.top };
  },

  _renderConnections() {
    const svg = document.getElementById('svg-layer');
    let out = `<defs>
      ${this._mkr('aP', 'var(--accent)')}
      ${this._mkr('aG', 'var(--grn)')}
      ${this._mkr('aR', 'var(--red)')}
    </defs>`;

    for (const node of Object.values(this.nodes)) {
      for (const r of node.responses) {
        const nid = node.id, rid = r.id;
        if (r.type === 'action') {
          if (r.action_succeed && this.nodes[r.action_succeed]) {
            const p1 = this._portPos(`.outport.suc[data-nid="${nid}"][data-rid="${rid}"]`);
            const p2 = this._portPos(`.n-inport[data-in="${r.action_succeed}"]`);
            if (p1 && p2) out += this._bez(p1, p2, 'var(--grn)', 'aG', null, { nid, rid, port: 'suc' });
          }
          if (r.action_failure && this.nodes[r.action_failure]) {
            const p1 = this._portPos(`.outport.fail[data-nid="${nid}"][data-rid="${rid}"]`);
            const p2 = this._portPos(`.n-inport[data-in="${r.action_failure}"]`);
            if (p1 && p2) out += this._bez(p1, p2, 'var(--red)', 'aR', null, { nid, rid, port: 'fail' });
          }
        } else if (r.next && this.nodes[r.next]) {
          const p1 = this._portPos(`.outport[data-nid="${nid}"][data-rid="${rid}"][data-port="next"]`);
          const p2 = this._portPos(`.n-inport[data-in="${r.next}"]`);
          if (p1 && p2) out += this._bez(p1, p2, 'var(--accent)', 'aP', null, { nid, rid, port: 'next' });
        }
      }
    }

    if (this.wiring?.mx != null) {
      const w = this.wiring;
      const sel = w.port === 'suc'
        ? `.outport.suc[data-nid="${w.nodeId}"][data-rid="${w.respId}"]`
        : w.port === 'fail'
        ? `.outport.fail[data-nid="${w.nodeId}"][data-rid="${w.respId}"]`
        : `.outport[data-nid="${w.nodeId}"][data-rid="${w.respId}"][data-port="next"]`;
      const p1 = this._portPos(sel);
      if (p1) {
        const col = w.port === 'suc' ? 'var(--grn)' : w.port === 'fail' ? 'var(--red)' : 'var(--accent)';
        out += this._bez(p1, { x: w.mx, y: w.my }, col, null, '7,4', null);
      }
    }

    svg.innerHTML = out;
  },

  _mkr(id, color) {
    return `<marker id="${id}" viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="${color}"/>
    </marker>`;
  },

  _bez(p1, p2, col, marker, dash, conn) {
    const dx = Math.max(Math.abs(p2.x - p1.x) * 0.5, 60);
    const d = `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${(p1.x + dx).toFixed(1)},${p1.y.toFixed(1)} ${(p2.x - dx).toFixed(1)},${p2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    let out = `<path d="${d}" stroke="${col}" stroke-width="2" fill="none" opacity=".85"
      pointer-events="none"
      ${marker ? `marker-end="url(#${marker})"` : ''}
      ${dash   ? `stroke-dasharray="${dash}"`   : ''}/>`;
    if (conn) {
      out += `<path d="${d}" stroke="transparent" stroke-width="14" fill="none"
        style="pointer-events:stroke;cursor:pointer"
        data-fnid="${esc(conn.nid)}" data-frid="${esc(conn.rid)}" data-port="${conn.port}"/>`;
    }
    return out;
  },

  // ── Canvas setup ──────────────────────────────────────────────────────────
  _applyPan() {
    document.getElementById('canvas-content').style.transform =
      `translate(${this.pan.x}px,${this.pan.y}px)`;
    const gx = ((this.pan.x % 30) + 30) % 30;
    const gy = ((this.pan.y % 30) + 30) % 30;
    document.getElementById('canvas-wrap').style.backgroundPosition = `${gx}px ${gy}px`;
  },

  _setupCanvas() {
    const wrap = document.getElementById('canvas-wrap');
    let panStart = null, panMoved = false;

    wrap.addEventListener('mousedown', e => {
      if (e.button === 2) {
        if (e.target.closest('.node')) return; // node right-click handled separately
        e.preventDefault();
        panStart = { sx: e.clientX - this.pan.x, sy: e.clientY - this.pan.y };
        panMoved = false;
      }
    });

    document.addEventListener('mousemove', e => {
      if (panStart) {
        panMoved = true;
        this.pan.x = e.clientX - panStart.sx;
        this.pan.y = e.clientY - panStart.sy;
        this._applyPan();
        this._renderConnections();
      }
      if (this.wiring) {
        const wr = wrap.getBoundingClientRect();
        this.wiring.mx = e.clientX - wr.left;
        this.wiring.my = e.clientY - wr.top;
        this._renderConnections();
      }
    });

    document.addEventListener('mouseup', e => { if (e.button === 2) panStart = null; });

    // Right-click on a connection → sever
    document.getElementById('svg-layer').addEventListener('contextmenu', e => {
      if (!e.target.dataset.fnid) return;
      e.preventDefault(); e.stopPropagation();
      const { fnid, frid, port } = e.target.dataset;
      const resp = this.nodes[fnid]?.responses.find(r => r.id === frid);
      if (!resp) return;
      if (port === 'next') resp.next           = '';
      if (port === 'suc')  resp.action_succeed = '';
      if (port === 'fail') resp.action_failure = '';
      this._render();
      this.notify('Connection severed', 'info');
    });

    // Right-click on canvas background → create node menu
    wrap.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (panMoved) return;
      if (e.target.closest('.node')) return; // handled by node handler
      if (e.target.dataset.fnid) return;     // handled by svg handler

      const wr = wrap.getBoundingClientRect();
      const cx = e.clientX - wr.left - this.pan.x;
      const cy = e.clientY - wr.top  - this.pan.y;

      this._showCtxMenu([
        { label: '+ Create Node here', action: () => {
          const id = this._addNode(null, cx, cy);
          this._render();
          this.openEditor(id);
          this.notify('Node created', 'ok');
        }}
      ], e.clientX, e.clientY);
    });

    // Cancel wiring on background click
    wrap.addEventListener('click', e => {
      if (this.wiring && !e.target.closest('.node,.outport')) this._cancelWiring();
    });

    // Close context menu on any click
    document.addEventListener('click', () => this._hideCtxMenu());

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this._cancelWiring();
        this.closeEditor();
        this._hideCtxMenu();
      }
    });
  },

  // ── Wiring ────────────────────────────────────────────────────────────────
  _startWiring(nodeId, respId, port) {
    if (this.wiring) { this._cancelWiring(); return; }
    this.wiring = { nodeId, respId, port };
    document.body.classList.add('wiring');
    const col = port === 'suc' ? 'var(--grn)' : port === 'fail' ? 'var(--red)' : 'var(--accent)';
    document.documentElement.style.setProperty('--wire-col', col);
  },

  _completeWiring(targetId) {
    if (!this.wiring) return;
    const { nodeId, respId, port } = this.wiring;
    const resp = this.nodes[nodeId]?.responses.find(r => r.id === respId);
    if (resp) {
      if (port === 'next') resp.next           = targetId;
      if (port === 'suc')  resp.action_succeed = targetId;
      if (port === 'fail') resp.action_failure = targetId;
    }
    this._cancelWiring();
    this._render();
    this.notify('Connected', 'ok');
  },

  _cancelWiring() {
    this.wiring = null;
    document.body.classList.remove('wiring');
    document.documentElement.style.removeProperty('--wire-col');
    this._renderConnections();
  },

  // ── Editor ────────────────────────────────────────────────────────────────
  openEditor(id) {
    this.editId = id;
    document.getElementById('ed-panel').classList.add('open');
    this._renderEditor();
    this._renderNodes();
  },

  closeEditor() {
    if (!this.editId) return;
    this.editId = null;
    document.getElementById('ed-panel').classList.remove('open');
    this._renderNodes();
  },

  _renderEditor() {
    const id = this.editId, node = this.nodes[id];
    if (!node) return;
    document.getElementById('ed-head-id').textContent = id;
    let h = '';

    h += `<div>
      <div class="ed-sec-hd">Node ID
        <button class="ibtn del" onclick="App.deleteNode('${esc(id)}')">🗑 Delete</button>
      </div>
      <div class="field" style="margin-bottom:0">
        <input type="text" id="ed-nid" value="${esc(id)}"
          onblur="App._commitRename('${esc(id)}',this.value)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>
    </div>`;

    h += `<div>
      <div class="ed-sec-hd">Messages
        <button class="ibtn" onclick="App._addMsg('${esc(id)}')">+ Add</button>
      </div>`;
    if (!node.messages.length) h += '<div style="font-size:11px;color:var(--sub)">No messages yet.</div>';
    node.messages.forEach((m, i) => {
      h += `<div class="ed-item">
        <div class="ed-row">
          <textarea rows="2" oninput="App._setMsg('${esc(id)}',${i},this.value)">${esc(m)}</textarea>
        </div>
        <div class="ed-row">
          <button class="ibtn" onclick="App._moveMsg('${esc(id)}',${i},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="ibtn" onclick="App._moveMsg('${esc(id)}',${i},1)" ${i === node.messages.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="ibtn del" onclick="App._delMsg('${esc(id)}',${i})">✕</button>
        </div>
      </div>`;
    });
    h += '</div>';

    h += `<div>
      <div class="ed-sec-hd">Responses
        <div style="display:flex;gap:4px">
          <button class="ibtn" onclick="App._addResp('${esc(id)}')">＋ Response</button>
          <button class="ibtn" onclick="App._addAction('${esc(id)}')">⚡ Action</button>
        </div>
      </div>`;
    if (!node.responses.length) h += '<div style="font-size:11px;color:var(--sub)">No responses — dialogue ends here.</div>';
    node.responses.forEach((r, i) => {
      const act = r.type === 'action';
      h += `<div class="ed-item">
        <div class="ed-row">
          <input type="text" placeholder="Response label" value="${esc(r.label)}"
            oninput="App._setResp('${esc(id)}','${esc(r.id)}','label',this.value)">
          <button class="ibtn" onclick="App._moveResp('${esc(id)}',${i},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="ibtn" onclick="App._moveResp('${esc(id)}',${i},1)" ${i === node.responses.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="ibtn del" onclick="App._delResp('${esc(id)}','${esc(r.id)}')">✕</button>
        </div>
        <div class="type-row">
          <button class="type-btn ${!act ? 'on' : ''}" onclick="App._setRespType('${esc(id)}','${esc(r.id)}','next')">→ Next</button>
          <button class="type-btn ${act ? 'on' : ''}"  onclick="App._setRespType('${esc(id)}','${esc(r.id)}','action')">⚡ Action</button>
        </div>`;
      if (!act) {
        h += `<div class="af-row">
          <span class="af-lbl">next</span>
          <input type="text" value="${esc(r.next)}" placeholder="node_id"
            oninput="App._setResp('${esc(id)}','${esc(r.id)}','next',this.value)">
        </div>`;
      } else {
        h += `<div class="af-row">
            <span class="af-lbl">action</span>
            <input type="text" value="${esc(r.action)}" placeholder="buy:item"
              oninput="App._setResp('${esc(id)}','${esc(r.id)}','action',this.value)">
            <button class="penbtn" title="Edit Lua callback" onclick="App.openMonaco('${esc(id)}','${esc(r.id)}')">✏</button>
          </div>
          <div class="af-row">
            <span class="af-lbl">succeed →</span>
            <input type="text" value="${esc(r.action_succeed)}" placeholder="node_id"
              oninput="App._setResp('${esc(id)}','${esc(r.id)}','action_succeed',this.value)">
          </div>
          <div class="af-row">
            <span class="af-lbl">failure →</span>
            <input type="text" value="${esc(r.action_failure)}" placeholder="node_id"
              oninput="App._setResp('${esc(id)}','${esc(r.id)}','action_failure',this.value)">
          </div>`;
      }
      h += '</div>';
    });
    h += '</div>';

    document.getElementById('ed-body').innerHTML = h;
  },

  _commitRename(old, val) {
    if (this._renameNode(old, val)) this._render();
    else document.getElementById('ed-nid').value = old;
  },
  _addMsg(id) {
    const n = this.nodes[id].messages.length + 1;
    this.nodes[id].messages.push(`Message ${n}`);
    this._render();
    setTimeout(() => { const t = document.querySelectorAll('#ed-body textarea'); if (t.length) t[t.length - 1].focus(); }, 40);
  },
  _setMsg(id, i, v)  { this.nodes[id].messages[i] = v; this._renderNodes(); },
  _moveMsg(id, i, d) { const a = this.nodes[id].messages, ni = i + d; if (ni < 0 || ni >= a.length) return; [a[i], a[ni]] = [a[ni], a[i]]; this._render(); },
  _delMsg(id, i)     { this.nodes[id].messages.splice(i, 1); this._render(); },
  _addResp(id) {
    const n = this.nodes[id].responses.length + 1;
    this.nodes[id].responses.push({ id: uid(), label: `Response ${n}`, type: 'next', next: '', action: '', action_succeed: '', action_failure: '' });
    this._render();
  },
  _addAction(id) {
    const n = this.nodes[id].responses.length + 1;
    this.nodes[id].responses.push({ id: uid(), label: `action_response_${n}`, type: 'action', next: '', action: `action:${n}`, action_succeed: `action_response_${n}_succeed`, action_failure: `action_response_${n}_fail` });
    this._render();
  },
  _setResp(id, rid, field, val) {
    const r = this.nodes[id]?.responses.find(r => r.id === rid);
    if (r) r[field] = val;
    this._renderConnections(); this._renderNodes();
  },
  _setRespType(id, rid, type) {
    const r = this.nodes[id]?.responses.find(r => r.id === rid);
    if (r) r.type = type;
    this._render();
  },
  _moveResp(id, i, d) { const a = this.nodes[id].responses, ni = i + d; if (ni < 0 || ni >= a.length) return; [a[i], a[ni]] = [a[ni], a[i]]; this._render(); },
  _delResp(id, rid)   { this.nodes[id].responses = this.nodes[id].responses.filter(r => r.id !== rid); this._render(); },

  // ── Monaco ────────────────────────────────────────────────────────────────
  _loadMonaco() {
    if (typeof require === 'undefined') return;
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      const base = { language: 'lua', theme: 'vs-dark', fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, lineNumbers: 'on' };
      this.monacoEdit = monaco.editor.create(document.getElementById('mc-container'), { ...base });
      this.monacoLua  = monaco.editor.create(document.getElementById('ex-container'), { ...base, readOnly: true, domReadOnly: true });
    });
  },

  openMonaco(nodeId, respId) {
    const resp = this.nodes[nodeId]?.responses.find(r => r.id === respId);
    if (!resp) return;
    const key = resp.action;
    if (!key) { alert('Enter an action key first (e.g. "buy:wheat").'); return; }
    this.monacoTarget = { nodeId, respId, key };
    document.getElementById('mc-label').textContent = `Callback: "${key}"`;
    document.getElementById('mc-modal').classList.remove('hidden');
    if (this.monacoEdit) { this.monacoEdit.setValue(this.actionCallbacks[key] || DEFAULT_CALLBACK_STUB); this.monacoEdit.focus(); }
    else alert('Monaco is still loading, try again in a moment.');
  },

  saveMonaco() {
    if (!this.monacoEdit || !this.monacoTarget) return;
    this.actionCallbacks[this.monacoTarget.key] = this.monacoEdit.getValue();
    this.notify(`Callback "${this.monacoTarget.key}" saved`, 'ok');
    this.closeMonaco();
  },
  closeMonaco() { document.getElementById('mc-modal').classList.add('hidden'); this.monacoTarget = null; },

  // ── Lua export ────────────────────────────────────────────────────────────
  showLuaExport() {
    const lua = this._genLua();
    this._luaCache = lua;
    document.getElementById('ex-modal').classList.remove('hidden');
    if (this.monacoLua) {
      document.getElementById('ex-container').style.display = '';
      document.getElementById('ex-fallback').classList.add('hidden');
      this.monacoLua.setValue(lua);
    } else {
      document.getElementById('ex-container').style.display = 'none';
      document.getElementById('ex-fallback').classList.remove('hidden');
      document.getElementById('ex-fallback').textContent = lua;
    }
  },
  closeLuaExport() { document.getElementById('ex-modal').classList.add('hidden'); },
  copyLua() {
    navigator.clipboard.writeText(this._luaCache).then(() => {
      const b = document.getElementById('copy-lua-btn');
      b.textContent = '✓ Copied!'; setTimeout(() => b.textContent = '📋 Copy', 1600);
      this.notify('Lua copied to clipboard', 'ok');
    });
  },

  _genLua() {
    const sp = this.speaker;
    const L = [];
    L.push('local DIALOGUE = {}');
    L.push('');
    L.push('DIALOGUE.speaker = {');
    L.push(`    name     = ${luaQ(sp.name || 'NPC')},`);
    L.push(`    subtitle = ${luaQ(sp.subtitle || '')},`);
    L.push(`    accent   = ${luaQ(sp.accent || '#ffffff')},`);
    L.push('}');
    L.push('');
    L.push(`DIALOGUE.start_node = ${luaQ(this.startNode || 'base')}`);
    L.push('');
    L.push('DIALOGUE.nodes = {');
    for (const node of Object.values(this.nodes)) {
      L.push(`    [${luaQ(node.id)}] = {`);
      L.push(`        messages = {${node.messages.map(luaQ).join(', ')}},`);
      if (node.responses.length) {
        L.push('        responses = {');
        for (const r of node.responses) {
          if (r.type === 'action') {
            L.push(`            { label = ${luaQ(r.label)}, action = ${luaQ(r.action)}, action_succeed = ${luaQ(r.action_succeed)}, action_failure = ${luaQ(r.action_failure)} },`);
          } else {
            L.push(r.next
              ? `            { label = ${luaQ(r.label)}, next = ${luaQ(r.next)} },`
              : `            { label = ${luaQ(r.label)} },`);
          }
        }
        L.push('        },');
      }
      L.push('    },');
    }
    L.push('}');

    const keys = [...new Set(
      Object.values(this.nodes).flatMap(n =>
        n.responses.filter(r => r.type === 'action' && r.action).map(r => r.action))
    )];
    if (keys.length) {
      L.push('');
      L.push('DIALOGUE.actionCallbacks = {');
      for (const key of keys) {
        const code = (this.actionCallbacks[key] || '').trim();
        L.push(`    [${luaQ(key)}] = function()`);
        if (code) for (const line of code.split('\n')) L.push('        ' + line);
        L.push('    end,');
      }
      L.push('}');
    }

    L.push('');
    L.push('DialogueEngine:RegisterDialogue(DIALOGUE)');
    return L.join('\n');
  },

  // ── JSON ──────────────────────────────────────────────────────────────────
  exportJSON() {
    const state = { speaker: this.speaker, startNode: this.startNode, nodes: this.nodes, actionCallbacks: this.actionCallbacks };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(this.speaker.name || 'dialogue').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`;
    a.click(); URL.revokeObjectURL(url);
    this.notify('JSON saved', 'ok');
  },

  showImport() {
    document.getElementById('import-txt').value = '';
    document.getElementById('import-modal').classList.remove('hidden');
  },
  closeImport() { document.getElementById('import-modal').classList.add('hidden'); },

  async pasteClipboard() {
    try {
      document.getElementById('import-txt').value = await navigator.clipboard.readText();
    } catch (e) { alert('Clipboard read failed. Please paste manually (Ctrl+V).'); }
  },

  importFromText() {
    const txt = document.getElementById('import-txt').value.trim();
    if (!txt) return;
    try { this._applyState(JSON.parse(txt)); this.closeImport(); this.notify('Loaded successfully', 'ok'); }
    catch (e) { alert('Invalid JSON:\n' + e.message); }
  },

  _handleFile(input) {
    const f = input.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try { this._applyState(JSON.parse(ev.target.result)); this.closeImport(); this.notify('Loaded from file', 'ok'); }
      catch (e) { alert('Invalid JSON:\n' + e.message); }
    };
    r.readAsText(f); input.value = '';
  },

  _applyState(s) {
    if (!s.nodes) throw new Error('Missing "nodes" key');
    this.speaker         = s.speaker         || { name: '', subtitle: '', accent: '#e91e8c' };
    this.startNode       = s.startNode        || 'base';
    this.nodes           = s.nodes            || {};
    this.actionCallbacks = s.actionCallbacks  || {};
    this.editId = null;
    document.getElementById('sp-name').value     = this.speaker.name;
    document.getElementById('sp-subtitle').value = this.speaker.subtitle;
    document.getElementById('sp-accent').value   = this.speaker.accent;
    document.getElementById('accent-prev').style.background = this.speaker.accent;
    document.getElementById('ed-panel').classList.remove('open');
    this._render();
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());