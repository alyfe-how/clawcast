// ClawCast — web viewer
const _token = new URLSearchParams(location.search).get('t') || '';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/view?t=${_token}`;

let ws;
let terminals = [];        // [{ id, name, buffer }]
let xtermInstances = {};   // id → xterm Terminal
let fitAddons = {};        // id → FitAddon
let activeTerminalId = null;
let activeTerminalName = null;

const gridView   = document.getElementById('grid-view');
const fullView   = document.getElementById('full-view');
const fullTitle  = document.getElementById('full-title');
const fullTermEl = document.getElementById('full-terminal');
const inputField = document.getElementById('input-field');
const sendBtn    = document.getElementById('send-btn');
const backBtn    = document.getElementById('back-btn');
const spawnBtn   = document.getElementById('spawn-btn');
const statusEl   = document.getElementById('status');

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    statusEl.textContent = 'Live';
    statusEl.classList.add('live');
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — retrying...';
    statusEl.classList.remove('live');
    setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'terminal_list') {
      syncTerminalList(msg.terminals);
    }

    if (msg.type === 'terminal_data') {
      handleData(msg.terminalId, msg.terminal, msg.data);
    }

    if (msg.type === 'source_disconnected') {
      statusEl.textContent = 'VS Code disconnected';
      statusEl.classList.remove('live');
    }

    if (msg.type === 'buffer_clear') {
      terminals.forEach(t => { t.buffer = ''; });
      if (activeTerminalId && xtermInstances[activeTerminalId]) {
        xtermInstances[activeTerminalId].clear();
      }
      terminals.forEach(t => updateCardPreview(t.id));
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Terminal list sync ─────────────────────────────────────────────────────

function syncTerminalList(list) {
  // Add new terminals
  list.forEach(({ id, name }) => {
    if (!terminals.find(t => t.id === id)) {
      terminals.push({ id, name, buffer: '' });
    } else {
      const t = terminals.find(t => t.id === id);
      if (t) t.name = name;
    }
  });

  // Remove closed terminals
  terminals = terminals.filter(t => list.find(l => l.id === t.id));

  renderGrid();
}

// ── Data handling ──────────────────────────────────────────────────────────

function handleData(id, name, data) {
  let t = terminals.find(t => t.id === id);
  if (!t && name) t = terminals.find(t => t.name === name);

  if (t) {
    t.buffer += data;
    if (t.buffer.length > 50000) t.buffer = t.buffer.slice(-50000);
  }

  // Live write only when terminal is open in full view
  const termId = t?.id || id;
  if (xtermInstances[termId]) {
    xtermInstances[termId].write(stripClaudeRulers(data));
  }
}

// ── Grid ───────────────────────────────────────────────────────────────────

function renderGrid() {
  gridView.innerHTML = '';

  if (terminals.length === 0) {
    gridView.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;opacity:0.4;font-size:13px;">No terminals open in VS Code</div>';
    return;
  }

  terminals.forEach(({ id, name }) => {
    const card = document.createElement('div');
    card.className = 'terminal-card';
    card.dataset.id = id;

    const titleRow = document.createElement('div');
    titleRow.className = 'card-title';
    titleRow.innerHTML = `<span class="card-title-name">${name}</span><span class="card-open-hint">tap to open →</span>`;

    const preview = document.createElement('div');
    preview.className = 'card-preview';
    preview.id = `preview-${id}`;
    const buf = terminals.find(t => t.id === id)?.buffer || '';
    const lines = stripAnsi(buf).split('\n').filter(l => l.trim());
    preview.textContent = lines.slice(-8).join('\n');

    card.appendChild(titleRow);
    card.appendChild(preview);

    // Long-press (800ms) → close terminal; tap → open full
    let lpTimer = null;
    let lpFired = false;
    let lpMoved = false;
    let lpStartX = 0, lpStartY = 0;
    let touchOpened = false;

    card.addEventListener('touchstart', (e) => {
      lpFired = false;
      lpMoved = false;
      touchOpened = false;
      lpStartX = e.touches[0].clientX;
      lpStartY = e.touches[0].clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        lpFired = true;
        confirmClose(id, name);
      }, 800);
    }, { passive: true });

    card.addEventListener('touchend', () => {
      clearTimeout(lpTimer);
      lpTimer = null;
      if (!lpFired && !lpMoved) {
        touchOpened = true;
        openFull(id, name);
      }
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - lpStartX;
      const dy = e.touches[0].clientY - lpStartY;
      if (Math.sqrt(dx * dx + dy * dy) > 10) {
        clearTimeout(lpTimer);
        lpTimer = null;
        lpMoved = true;
      }
    }, { passive: true });

    // Fallback for desktop mouse clicks (touch already handled above)
    card.addEventListener('click', () => {
      if (lpFired) { lpFired = false; return; }
      if (touchOpened) { touchOpened = false; return; }
      openFull(id, name);
    });

    gridView.appendChild(card);
  });
}

function updateCardPreview(id) {
  const el = document.getElementById(`preview-${id}`);
  if (!el) return;
  const t = terminals.find(t => t.id === id);
  const lines = stripAnsi(t?.buffer || '').split('\n').filter(l => l.trim());
  el.textContent = lines.slice(-8).join('\n');
}

// ── Full screen terminal ───────────────────────────────────────────────────

function openFull(id, name) {
  activeTerminalId = id;
  activeTerminalName = name;
  fullTitle.textContent = name;

  gridView.classList.add('hidden');
  fullView.classList.remove('hidden');

  // Dispose any previous xterm in this slot
  if (xtermInstances[id]) {
    xtermInstances[id]._clawcastRO?.disconnect();
    xtermInstances[id].dispose();
    delete xtermInstances[id];
    delete fitAddons[id];
  }

  // Show placeholder immediately — tap acknowledged before heavy xterm init
  fullTermEl.innerHTML = '<div style="padding:20px;font-size:12px;opacity:0.35;font-family:monospace">Opening...</div>';

  // Double-RAF: first frame paints the view switch + placeholder,
  // second frame has settled layout for xterm canvas sizing.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fullTermEl.innerHTML = '';

    const t0 = terminals.find(t => t.id === id);
    const nativeCols = t0?.buffer ? detectBufferCols(t0.buffer) : 80;
    const fontSize = rhsFontSize(fullTermEl.clientWidth || window.innerWidth, nativeCols);
    const term = new Terminal({
      theme: { background: '#0d0d0d', foreground: '#e0e0e0', cursor: '#00ff88' },
      fontSize,
      fontFamily: 'Menlo, Consolas, monospace',
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(fullTermEl);
    fitAddon.fit();
    send({ type: 'terminal_resize', terminalId: id, cols: term.cols, rows: term.rows });

    // Replay buffer only once cols > 0 — if layout wasn't ready at fit() time,
    // ResizeObserver below will trigger the replay when dimensions settle.
    let bufferReplayed = false;
    function replayBuffer() {
      if (bufferReplayed) return;
      bufferReplayed = true;
      const t = terminals.find(t => t.id === id);
      if (!t?.buffer) return;
      const stripped = stripClaudeRulers(stripPositioning(t.buffer));
      const CHUNK = 8192;
      let offset = 0;
      function writeChunk() {
        if (offset >= stripped.length) return;
        term.write(stripped.slice(offset, offset + CHUNK));
        offset += CHUNK;
        if (offset < stripped.length) requestAnimationFrame(writeChunk);
      }
      writeChunk();
    }

    // Fast path: layout already settled
    if (term.cols > 0 && term.rows > 0) replayBuffer();

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      send({ type: 'terminal_resize', terminalId: id, cols: term.cols, rows: term.rows });
      // Fallback: replay buffer once dimensions are actually ready
      if (!bufferReplayed && term.cols > 0) replayBuffer();
    });
    ro.observe(fullTermEl);
    term._clawcastRO = ro;

    xtermInstances[id] = term;
    fitAddons[id] = fitAddon;

    inputField.focus();
  }));
}

function closeFull() {
  if (activeTerminalId && xtermInstances[activeTerminalId]) {
    xtermInstances[activeTerminalId]._clawcastRO?.disconnect();
    xtermInstances[activeTerminalId].dispose();
    delete xtermInstances[activeTerminalId];
    delete fitAddons[activeTerminalId];
  }
  activeTerminalId = null;
  activeTerminalName = null;
  fullView.classList.add('hidden');
  gridView.classList.remove('hidden');
}

// ── Close terminal (long-press) ────────────────────────────────────────────

function confirmClose(id, name) {
  if (!confirm(`Close terminal "${name}"?\n\nThis will kill it in VS Code.`)) return;
  terminals = terminals.filter(t => t.id !== id);
  renderGrid();
  send({ type: 'close_terminal', terminalId: id });
}

// ── Input ──────────────────────────────────────────────────────────────────

function sendInput() {
  if (!activeTerminalId) return;
  const val = inputField.value;
  inputField.value = '';
  send({ type: 'terminal_input', terminalId: activeTerminalId, input: val + '\r' });
}

inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendInput();
});
sendBtn.addEventListener('click', sendInput);
backBtn.addEventListener('click', closeFull);
spawnBtn.addEventListener('click', () => {
  send({ type: 'spawn_terminal', name: 'Remote' });
});

document.querySelectorAll('.key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!activeTerminalId) return;
    send({ type: 'terminal_input', terminalId: activeTerminalId, input: btn.dataset.seq });
  });
});

// ── RHS — Responsive Harmony System (col-aware font sizing) ───────────────

function detectBufferCols(buffer) {
  // Measure ruler lines — they span the full original terminal width
  const rulers = buffer.match(/[━─═·╭╰╮╯]{6,}/g);
  if (rulers && rulers.length > 0) {
    const longest = Math.max(...rulers.map(r => r.length));
    if (longest > 40) return longest;
  }
  // Fallback: longest non-ANSI line
  const clean = buffer.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
  const max = Math.max(...clean.split('\n').map(l => l.length));
  return Math.max(80, Math.min(300, max));
}

function rhsFontSize(containerPx, nativeCols) {
  const cols = nativeCols || 80;
  const CHAR_W = 0.6;  // monospace width/height ratio (Menlo/Consolas)
  const ideal  = containerPx / (cols * CHAR_W);
  return Math.max(7, Math.min(13, Math.floor(ideal)));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[PX^_][^\x1B]*\x1B\\/g, '')
    .replace(/\x1B[^[\]]/g, '')
    .replace(/\r/g, '');
}

function stripPositioning(str) {
  return str
    .replace(/\x1B\[\d*;\d*[Hf]/g, '')
    .replace(/\x1B\[\d*[Hf]/g, '')
    .replace(/\x1B\[\d*[ABCD]/g, '')
    .replace(/\x1B\[\d*[JK]/g, '')
    .replace(/\x1B\[[su]/g, '')
    .replace(/\x1B[78]/g, '')
    .replace(/\x1B\[\?25[hl]/g, '')
    .replace(/\r(?!\n)/g, '\r\n');
}

function stripClaudeRulers(data) {
  return data
    .replace(/[╭╰][─━═·╮╯\s]{4,}[╮╯]\r?\n/g, '\r\n')   // box borders: ╭────╮ / ╰────╯
    .replace(/[━─═·]{6,}\r?\n/g, '\r\n');                  // plain ruler lines
}

// ── Init ───────────────────────────────────────────────────────────────────

connect();
