import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as QRCode from 'qrcode';
import { spawn, ChildProcess } from 'child_process';

let httpServer: http.Server | undefined;
let wss: WebSocketServer | undefined;
let cloudflaredProcess: ChildProcess | undefined;
let sessionToken: string | undefined;
let panelInstance: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem;
let tunnelUrl: string | undefined;
let outputChannel: vscode.OutputChannel;

// Relay state (embedded)
const viewers = new Set<WebSocket>();
let cachedTerminalList: string | null = null;
const terminalBuffers = new Map<string, string>();
const terminalIds = new WeakMap<vscode.Terminal, string>();
let nextTerminalId = 0;
// Dimension override emitters for ClawCast PTY terminals (keyed by termId)
const ptyDimensionEmitters = new Map<string, vscode.EventEmitter<vscode.TerminalDimensions | undefined>>();
const PHONE_COLS = 50;
const PHONE_ROWS = 24;
function getTerminalId(t: vscode.Terminal): string {
  if (!terminalIds.has(t)) terminalIds.set(t, `t${nextTerminalId++}`);
  return terminalIds.get(t)!;
}

const RELAY_PORT = 3747;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('ClawCast');
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'clawcast.start';
  statusBarItem.text = '$(broadcast) ClawCast';
  statusBarItem.tooltip = 'Start ClawCast terminal mirror';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('clawcast.start', () => startClawCast(context)),
    vscode.commands.registerCommand('clawcast.stop', () => stopClawCast()),
  );
}

// ── Relay server (embedded) ────────────────────────────────────────────────

function startRelay(context: vscode.ExtensionContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const webDir = path.join(context.extensionPath, 'web');

    httpServer = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const params = new URLSearchParams((req.url || '').split('?')[1] || '');

      // Token auth: only required for the HTML entry point and sensitive endpoints.
      // Static assets (CSS, JS) are served freely — they're useless without the WS connection.
      const needsAuth = urlPath === '/' || urlPath === '/index.html' || urlPath === '/refresh';
      if (needsAuth && params.get('t') !== sessionToken) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      if (urlPath === '/refresh') {
        terminalBuffers.clear();
        broadcastToViewers(JSON.stringify({ type: 'buffer_clear' }));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
      }

      let filePath = urlPath === '/' ? '/index.html' : urlPath;
      filePath = path.join(webDir, filePath);

      // Path traversal guard: resolved path must stay inside webDir
      const webDirResolved = path.resolve(webDir);
      const fileResolved = path.resolve(filePath);
      if (!fileResolved.startsWith(webDirResolved + path.sep) && fileResolved !== webDirResolved) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      const ext = path.extname(filePath);
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': mime[ext] || 'text/plain',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(data);
      });
    });

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws, req) => {
      // Token auth on WebSocket upgrade
      const wsParams = new URLSearchParams((req.url || '').split('?')[1] || '');
      if (wsParams.get('t') !== sessionToken) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      // Origin validation: block cross-origin WS connections (CSRF guard).
      // Allowed: localhost (LAN direct), or the active cloudflared tunnel URL.
      const origin = req.headers['origin'] as string | undefined;
      if (origin) {
        const isLocal = /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
                        /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
                        /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||
                        /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin) ||
                        /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(origin);
        const isTunnel = !!tunnelUrl && origin === tunnelUrl;
        if (!isLocal && !isTunnel) {
          outputChannel.appendLine(`[relay] Rejected WS from disallowed origin: ${origin}`);
          ws.close(4003, 'Forbidden origin');
          return;
        }
      }

      if (req.url?.split('?')[0] === '/view') {
        viewers.add(ws);
        outputChannel.appendLine('[relay] Viewer connected');

        // Send cached terminal list + buffered output to new viewer
        if (cachedTerminalList) {
          ws.send(cachedTerminalList);
          terminalBuffers.forEach((buf, id) => {
            if (buf) ws.send(JSON.stringify({ type: 'terminal_data', terminalId: id, data: buf }));
          });
        }

        ws.on('message', (raw) => {
          let msg: any;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            outputChannel.appendLine('[relay] Dropped malformed message');
            return;
          }
          if (msg.type === 'terminal_input') {
            const input = typeof msg.input === 'string' ? msg.input : '';
            if (input.length > 4096) { outputChannel.appendLine('[relay] Dropped oversized input'); return; }
            const term = vscode.window.terminals.find(t => getTerminalId(t) === msg.terminalId);
            term?.sendText(input, false);
          }
          if (msg.type === 'spawn_terminal') {
            createMirroredTerminal(msg.name || 'ClawCast');
          }
          if (msg.type === 'close_terminal') {
            const term = vscode.window.terminals.find(t => getTerminalId(t) === msg.terminalId);
            term?.dispose();
          }
          if (msg.type === 'terminal_resize') {
            if (msg.cols > 0 && msg.rows > 0) {
              const dimEmitter = ptyDimensionEmitters.get(msg.terminalId);
              if (dimEmitter) {
                // ClawCast PTY terminal — resize to match phone's actual viewport
                dimEmitter.fire({ columns: msg.cols, rows: msg.rows });
                outputChannel.appendLine(`[relay] PTY ${msg.terminalId} resized to ${msg.cols}x${msg.rows} (phone fit)`);
              }
            }
          }
        });
        ws.on('close', () => viewers.delete(ws));
      }
    });

    httpServer.listen(RELAY_PORT, '0.0.0.0', () => {
      outputChannel.appendLine(`[relay] Listening on port ${RELAY_PORT}`);
      resolve();
    });
    httpServer.on('error', reject);
  });
}

function broadcastToViewers(raw: string) {
  viewers.forEach(v => v.readyState === WebSocket.OPEN && v.send(raw));
}

// ── Main start ─────────────────────────────────────────────────────────────

async function startClawCast(context: vscode.ExtensionContext) {
  if (httpServer?.listening) {
    vscode.window.showInformationMessage('[ClawCast] Already running.');
    return;
  }

  sessionToken = crypto.randomBytes(16).toString('hex');

  try {
    await startRelay(context);
  } catch (err: any) {
    vscode.window.showErrorMessage(`[ClawCast] Relay failed to start: ${err.message}`);
    return;
  }

  vscode.window.showInformationMessage('[ClawCast] Relay started');
  sendTerminalList();
  hookAllTerminals(context);
  launchTunnel(context);
}

// ── Mirrored terminal (pseudoterminal + spawned shell) ─────────────────────

function createMirroredTerminal(name: string = 'ClawCast') {
  const termId = `t${nextTerminalId++}`;
  const writeEmitter = new vscode.EventEmitter<string>();
  const dimEmitter = new vscode.EventEmitter<vscode.TerminalDimensions | undefined>();
  ptyDimensionEmitters.set(termId, dimEmitter);

  const forward = (data: Buffer) => {
    const text = data.toString();
    writeEmitter.fire(text);
    const prev = terminalBuffers.get(termId) || '';
    const next = prev + text;
    terminalBuffers.set(termId, next.length > 50000 ? next.slice(-50000) : next);
    broadcastToViewers(JSON.stringify({ type: 'terminal_data', terminalId: termId, terminal: name, data: text }));
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidOverrideDimensions: dimEmitter.event,
    open: () => {
      // Start at phone-friendly width; phone's fitAddon will send actual dims on connect
      dimEmitter.fire({ columns: PHONE_COLS, rows: PHONE_ROWS });
      const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
      const args = process.platform === 'win32' ? ['-NoLogo'] : [];
      const proc = spawn(shell, args, {
        env: { ...process.env, COLUMNS: String(PHONE_COLS), LINES: String(PHONE_ROWS) },
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
      proc.stdout?.on('data', forward);
      proc.stderr?.on('data', forward);
      proc.on('exit', (code) => {
        writeEmitter.fire(`\r\n\x1b[2m[Process exited: ${code}]\x1b[0m\r\n`);
      });
      (pty as any)._proc = proc;
    },
    close: () => {
      (pty as any)._proc?.kill();
      ptyDimensionEmitters.get(termId)?.dispose();
      ptyDimensionEmitters.delete(termId);
    },
    handleInput: (data: string) => { (pty as any)._proc?.stdin?.write(data); },
  };

  const terminal = vscode.window.createTerminal({ name, pty });
  terminalIds.set(terminal, termId);
  terminal.show();
  sendTerminalList();
  return terminal;
}

// ── Terminal handling ──────────────────────────────────────────────────────

function sendTerminalList() {
  const list = vscode.window.terminals.map(t => ({ id: getTerminalId(t), name: t.name }));
  const raw = JSON.stringify({ type: 'terminal_list', terminals: list });
  cachedTerminalList = raw;
  broadcastToViewers(raw);
}

function hookAllTerminals(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => sendTerminalList()),
    vscode.window.onDidCloseTerminal(() => sendTerminalList()),
    vscode.window.onDidStartTerminalShellExecution(async event => {
      const stream = event.execution.read();
      const termId = getTerminalId(event.terminal);
      const termName = event.terminal.name;
      for await (const data of stream) {
        const prev = terminalBuffers.get(termId) || '';
        const next = prev + data;
        terminalBuffers.set(termId, next.length > 50000 ? next.slice(-50000) : next);
        broadcastToViewers(JSON.stringify({ type: 'terminal_data', terminalId: termId, terminal: termName, data }));
      }
    }),
  );
}

// ── Cloudflared tunnel ─────────────────────────────────────────────────────

function launchTunnel(context: vscode.ExtensionContext) {
  const bundled = path.join(context.extensionPath, 'cloudflared.exe');
  const bin = fs.existsSync(bundled) ? bundled : 'cloudflared';

  outputChannel.appendLine(`[ClawCast] Starting cloudflared: ${bin}`);
  outputChannel.show(true);

  cloudflaredProcess = spawn(bin, [
    'tunnel', '--url', `http://localhost:${RELAY_PORT}`, '--no-autoupdate'
  ]);

  const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  const onData = (data: Buffer) => {
    const text = data.toString();
    outputChannel.append(text);
    if (!tunnelUrl) {
      const match = text.match(urlRegex);
      if (match) {
        tunnelUrl = match[0];
        onTunnelReady(tunnelUrl, context);
      }
    }
  };

  cloudflaredProcess.stdout?.on('data', onData);
  cloudflaredProcess.stderr?.on('data', onData);

  cloudflaredProcess.on('error', (err) => {
    outputChannel.appendLine(`[ClawCast] cloudflared failed: ${err.message}`);
    vscode.window.showErrorMessage(`[ClawCast] cloudflared failed: ${err.message}`);
  });

  cloudflaredProcess.on('exit', (code) => {
    outputChannel.appendLine(`[ClawCast] cloudflared exited (code ${code})`);
  });
}

async function onTunnelReady(url: string, context: vscode.ExtensionContext) {
  const authedUrl = `${url}?t=${sessionToken}`;
  statusBarItem.text = '$(broadcast) ClawCast ●';
  statusBarItem.tooltip = `Live: ${url} — click to show QR`;
  statusBarItem.command = 'clawcast.start'; // just re-shows panel on click

  const qrDataUrl = await QRCode.toDataURL(authedUrl);
  showPanel(context, authedUrl, qrDataUrl);
}

// ── QR panel ───────────────────────────────────────────────────────────────

function showPanel(context: vscode.ExtensionContext, url: string, qrDataUrl: string) {
  if (panelInstance) panelInstance.dispose();

  panelInstance = vscode.window.createWebviewPanel(
    'clawcast', 'ClawCast', vscode.ViewColumn.Beside, { enableScripts: false }
  );

  panelInstance.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; margin: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  .badge {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; background: #1a1a2e;
    border: 1px solid #00ff88; color: #00ff88;
    padding: 4px 12px; border-radius: 12px;
    margin-bottom: 24px; letter-spacing: 1px;
  }
  .dot { width: 7px; height: 7px; background: #00ff88; border-radius: 50%; }
  img { width: 220px; height: 220px; border-radius: 12px; }
  .url { margin-top: 16px; font-size: 11px; opacity: 0.6; word-break: break-all; text-align: center; max-width: 260px; }
  h2 { margin: 0 0 4px; font-size: 18px; }
  p { margin: 0 0 24px; font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
  <div class="badge"><div class="dot"></div> LIVE</div>
  <h2>ClawCast</h2>
  <p>Scan to open your terminals on any device</p>
  <img src="${qrDataUrl}" alt="QR Code" />
  <div class="url">${url}</div>
</body>
</html>`;
}

// ── Stop ───────────────────────────────────────────────────────────────────

function stopClawCast() {
  cloudflaredProcess?.kill();
  panelInstance?.dispose();
  wss?.close();
  httpServer?.close();
  tunnelUrl = undefined;
  sessionToken = undefined;
  cachedTerminalList = null;
  terminalBuffers.clear();
  ptyDimensionEmitters.forEach(e => e.dispose());
  ptyDimensionEmitters.clear();
  httpServer = undefined;
  statusBarItem.text = '$(broadcast) ClawCast';
  statusBarItem.tooltip = 'Start ClawCast terminal mirror';
  vscode.window.showInformationMessage('[ClawCast] Stopped.');
}

export function deactivate() {
  stopClawCast();
}
