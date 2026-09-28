// 데스크톱 실행파일용 Electron 진입점.
// - 트레이너 창: dist/valo-aim-trainer.html
// - 오버레이 창: dist/overlay.html (항상 위, 클릭 통과). 게임 화면·메모리·입력은 읽지 않고 코치 카드만 표시한다.
const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, screen, dialog } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 에임 트레이너는 프레임 제한이 없을수록 입력 지연이 줄어든다
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');

Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) app.quit();

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const MARGIN = 16;
const POSITIONS = ['right-center', 'left-center', 'top-right', 'top-left', 'bottom-right', 'bottom-left', 'custom'];
const HOTKEYS = {
  toggle: 'CommandOrControl+Shift+O',
  nextTip: 'CommandOrControl+Shift+N',
  move: 'CommandOrControl+Shift+L',
  trainer: 'CommandOrControl+Shift+T',
};

const DEFAULT_CONFIG = {
  enabled: true,
  position: 'right-center',
  x: null,
  y: null,
  opacity: 0.82,
  scale: 1,
  tipSeconds: 25,
};

let configPath = '';
let config = { ...DEFAULT_CONFIG };
let card = null;
let trainer = null;
let overlay = null;
let tray = null;
let moveMode = false;
let overlaySize = { w: 348, h: 300 };
const failedHotkeys = [];

// ─── 설정 저장 (userData/overlay.json) ───
function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'overlay.json');
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = sanitize({ ...DEFAULT_CONFIG, ...saved.config });
    card = saved.card || null;
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ config, card }));
  } catch { /* 저장 불가 */ }
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function sanitize(c) {
  return {
    enabled: !!c.enabled,
    position: POSITIONS.includes(c.position) ? c.position : DEFAULT_CONFIG.position,
    x: Number.isFinite(c.x) ? Math.round(c.x) : null,
    y: Number.isFinite(c.y) ? Math.round(c.y) : null,
    opacity: clamp(c.opacity, 0.3, 1, DEFAULT_CONFIG.opacity),
    scale: clamp(c.scale, 0.7, 1.6, DEFAULT_CONFIG.scale),
    tipSeconds: clamp(c.tipSeconds, 0, 600, DEFAULT_CONFIG.tipSeconds),
  };
}

function publicConfig() {
  return { ...config, hotkeys: HOTKEYS, failedHotkeys };
}

// ─── 트레이너 창 ───
function createTrainer() {
  trainer = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#0f1419',
    title: '발로 에임 트레이너',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, preload: PRELOAD },
  });
  trainer.maximize();
  trainer.loadFile(path.join(APP_DIR, 'index.html'));

  // F11: 전체화면 전환
  trainer.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      trainer.setFullScreen(!trainer.isFullScreen());
      event.preventDefault();
    }
  });
  // 오버레이를 쓰는 중이면 트레이너를 닫아도 트레이에서 계속 실행
  trainer.on('closed', () => {
    trainer = null;
    if (!config.enabled) app.quit();
  });
}

function showTrainer() {
  if (!trainer) createTrainer();
  else {
    if (trainer.isMinimized()) trainer.restore();
    trainer.show();
    trainer.focus();
  }
}

// ─── 오버레이 창 ───
function overlayBounds() {
  const { w, h } = overlaySize;
  if (config.position === 'custom' && config.x !== null && config.y !== null) {
    const d = screen.getDisplayNearestPoint({ x: config.x, y: config.y }).bounds;
    return {
      x: Math.min(Math.max(config.x, d.x), d.x + d.width - w),
      y: Math.min(Math.max(config.y, d.y), d.y + d.height - h),
      width: w,
      height: h,
    };
  }
  // 게임은 보통 창 모드 전체화면이므로 작업표시줄을 빼지 않은 전체 화면 기준
  const b = screen.getPrimaryDisplay().bounds;
  const [v, hz] = config.position.includes('-center')
    ? ['center', config.position.split('-')[0]]
    : config.position.split('-');
  const x = hz === 'left' ? b.x + MARGIN : b.x + b.width - w - MARGIN;
  const y = v === 'top' ? b.y + MARGIN + 60 : v === 'bottom' ? b.y + b.height - h - MARGIN - 60 : b.y + Math.round((b.height - h) / 2);
  return { x, y, width: w, height: h };
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(APP_DIR, 'overlay.html'));
  overlay.once('ready-to-show', () => { if (config.enabled) overlay.showInactive(); });
  overlay.on('moved', () => {
    if (!moveMode) return;
    const [x, y] = overlay.getPosition();
    config = { ...config, position: 'custom', x, y };
    saveConfig();
    sendConfig();
  });
  overlay.on('closed', () => { overlay = null; });
}

function applyOverlay() {
  if (!overlay) return;
  if (!moveMode) overlay.setBounds(overlayBounds());
  if (config.enabled && !overlay.isVisible()) overlay.showInactive();
  if (!config.enabled && overlay.isVisible()) overlay.hide();
}

function sendConfig() {
  const c = publicConfig();
  for (const w of [overlay, trainer]) if (w) w.webContents.send('overlay:config', c);
  updateTray();
}

function setConfig(partial) {
  config = sanitize({ ...config, ...partial });
  saveConfig();
  applyOverlay();
  sendConfig();
}

function toggleOverlay() {
  setConfig({ enabled: !config.enabled });
}

// 위치 이동 모드: 이때만 마우스 입력을 받아 드래그할 수 있다
function toggleMoveMode() {
  if (!overlay) return;
  moveMode = !moveMode;
  if (moveMode && !config.enabled) setConfig({ enabled: true });
  overlay.setIgnoreMouseEvents(!moveMode);
  overlay.setFocusable(moveMode);
  overlay.webContents.send('overlay:move', moveMode);
  if (!moveMode) applyOverlay();
  updateTray();
}

// ─── 트레이 ───
function trayIcon() {
  // 16x16 빨간 원 (BGRA)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const i = (y * size + x) * 4;
      if (d <= 7) buf.set([0x55, 0x46, 0xff, 0xff], i);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '트레이너 열기', accelerator: HOTKEYS.trainer, click: showTrainer },
    { label: '오버레이 표시', type: 'checkbox', checked: config.enabled, accelerator: HOTKEYS.toggle, click: toggleOverlay },
    { label: '다음 팁', accelerator: HOTKEYS.nextTip, click: () => overlay?.webContents.send('overlay:next-tip') },
    { label: '오버레이 위치 이동', type: 'checkbox', checked: moveMode, accelerator: HOTKEYS.move, click: toggleMoveMode },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
}

// ─── IPC ───
ipcMain.handle('overlay:get-state', () => ({ card, config: publicConfig() }));
ipcMain.handle('overlay:set-config', (_e, partial) => {
  if (partial && typeof partial === 'object') setConfig(partial);
  return publicConfig();
});
ipcMain.on('coach:push', (_e, next) => {
  if (!next || typeof next !== 'object') return;
  card = next;
  saveConfig();
  overlay?.webContents.send('overlay:coach', card);
});
ipcMain.on('overlay:size', (e, w, h) => {
  if (!overlay || e.sender !== overlay.webContents) return;
  const nw = clamp(w, 100, 1000, overlaySize.w);
  const nh = clamp(h, 50, 1200, overlaySize.h);
  if (nw === overlaySize.w && nh === overlaySize.h) return;
  overlaySize = { w: nw, h: nh };
  if (moveMode) {
    const [x, y] = overlay.getPosition();
    overlay.setBounds({ x, y, width: nw, height: nh });
  } else overlay.setBounds(overlayBounds());
});

// ─── 리플레이 (.vrf) 해석 ───
// ValorantReplayParser 의 CliReader.exe (CI 에서 빌드해 resources/parser 에 포함) 로 NDJSON 을 만든다.
// 게임이 저장한 리플레이 파일만 읽고, 게임 실행 중인 프로세스에는 접근하지 않는다.
const exportedFiles = new Set();

function demosDir() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'VALORANT', 'Saved', 'Demos');
}

function parserPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'parser', 'CliReader.exe'),
    path.join(__dirname, 'parser', 'CliReader.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

ipcMain.handle('replay:list', async () => {
  const dir = demosDir();
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.vrf'));
    const files = await Promise.all(names.map(async (name) => {
      const st = await fs.promises.stat(path.join(dir, name));
      return { name, path: path.join(dir, name), size: st.size, mtime: st.mtimeMs };
    }));
    files.sort((a, b) => b.mtime - a.mtime);
    return { dir, files };
  } catch {
    return { dir, files: [], error: `리플레이 폴더가 없습니다: ${dir}` };
  }
});

ipcMain.handle('replay:pick', async () => {
  const r = await dialog.showOpenDialog(trainer, {
    title: '발로란트 리플레이 선택',
    defaultPath: demosDir(),
    filters: [{ name: 'VALORANT replay', extensions: ['vrf'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('replay:export', async (_e, vrfPath) => {
  if (typeof vrfPath !== 'string' || !vrfPath.toLowerCase().endsWith('.vrf') || !fs.existsSync(vrfPath)) {
    return { error: '리플레이 파일을 찾을 수 없습니다.' };
  }
  const exe = parserPath();
  if (!exe) return { error: '리플레이 해석기(CliReader.exe)가 앱에 포함되어 있지 않습니다.' };
  const st = fs.statSync(vrfPath);
  const base = path.basename(vrfPath, path.extname(vrfPath)).replace(/[^\w.-]/g, '_');
  const out = path.join(app.getPath('userData'), 'replays', `${base}-${Math.round(st.mtimeMs)}`);
  const events = path.join(out, 'events.ndjson');
  const movement = path.join(out, 'movement.ndjson');
  if (!(fs.existsSync(events) && fs.existsSync(movement))) {
    await fs.promises.mkdir(out, { recursive: true });
    const res = await new Promise((resolve) => {
      execFile(exe, ['export', vrfPath, '-o', out], { timeout: 10 * 60 * 1000, maxBuffer: 64 << 20, windowsHide: true },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    if (res.err || !fs.existsSync(events) || !fs.existsSync(movement)) {
      const msg = String(res.stderr || res.stdout || res.err?.message || '').trim().split('\n').slice(-5).join(' ');
      return { error: `해석기 오류 (패치 버전이 지원되지 않을 수 있음): ${msg}` };
    }
  }
  exportedFiles.add(events);
  exportedFiles.add(movement);
  return { name: path.basename(vrfPath), events, movement };
});

// 해석 결과 파일만 조각으로 읽을 수 있다
ipcMain.handle('replay:read', async (_e, file, offset, length) => {
  if (!exportedFiles.has(file)) throw new Error('허용되지 않은 파일');
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.max(0, Math.min(Number(length) || 0, 16 << 20, size - offset));
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, len), eof: offset + len >= size };
  } finally {
    await fh.close();
  }
});

app.on('second-instance', showTrainer);

app.whenReady().then(() => {
  loadConfig();
  createTrainer();
  createOverlay();

  tray = new Tray(trayIcon());
  tray.setToolTip('발로 에임 트레이너');
  tray.on('click', showTrainer);
  updateTray();

  const actions = {
    toggle: toggleOverlay,
    nextTip: () => overlay?.webContents.send('overlay:next-tip'),
    move: toggleMoveMode,
    trainer: showTrainer,
  };
  for (const [name, accel] of Object.entries(HOTKEYS)) {
    if (!globalShortcut.register(accel, actions[name])) failedHotkeys.push(accel);
  }

  screen.on('display-metrics-changed', applyOverlay);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
