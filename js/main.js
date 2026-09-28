import { Game, DEFAULT_SETTINGS } from './game.js';
import { SCENARIOS } from './scenarios.js';
import { WEAPONS, DIFFICULTY, GAME_YAW } from './config.js';
import { STRAFE_PROFILES, STRAFE_STOPS } from './bots.js';
import { cm360, edpi, degPerCount, convertSens, sensFromCm360, describeEdpi, roundSens } from './sens.js';
import { buildCoachCard } from './coach.js';
import { validateResult } from './match/validate.js';

const $ = (id) => document.getElementById(id);

// localStorage 는 막혀 있을 수 있으므로 항상 try/catch
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 */ }
  },
};

const settings = { ...DEFAULT_SETTINGS, ...store.get('vat.settings', {}) };
let history = store.get('vat.history', []);
let coachSessions = store.get('vat.coachSessions', []);
let currentMode = null;
let wantResume = false;
let lastResult = null;

const show = (id, on = true) => { $(id).hidden = !on; };
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── HUD ───
let feedbackTimer = 0;
let hitTimer = 0;
let stopText = '';
let stopUntil = 0;
let stopKind = '';

// 최근 2초 속도 기록 (나 / 봇)
const GRAPH_SECONDS = 2;
const speedHistory = [];

function drawSpeedGraph(s) {
  const now = performance.now() / 1000;
  speedHistory.push({ t: now, me: s.speed, bot: s.botSpeed, accurate: s.accurate });
  while (speedHistory.length && now - speedHistory[0].t > GRAPH_SECONDS) speedHistory.shift();
  if (!settings.speedGraph) return;
  const c = $('speedCanvas');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const top = s.runSpeed * 1.05;
  const X = (t) => W - ((now - t) / GRAPH_SECONDS) * W;
  const Y = (v) => H - 4 - (v / top) * (H - 8);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#ffffff55';
  g.lineWidth = 2;
  g.setLineDash([6, 6]);
  g.beginPath(); g.moveTo(0, Y(s.threshold)); g.lineTo(W, Y(s.threshold)); g.stroke();
  g.setLineDash([]);
  // 봇
  g.strokeStyle = '#7cc4ff';
  g.lineWidth = 3;
  g.beginPath();
  let started = false;
  for (const p of speedHistory) {
    if (!Number.isFinite(p.bot)) { started = false; continue; }
    if (!started) { g.moveTo(X(p.t), Y(p.bot)); started = true; } else g.lineTo(X(p.t), Y(p.bot));
  }
  g.stroke();
  // 나 (정확 구간이면 초록, 아니면 빨강)
  g.lineWidth = 4;
  for (let i = 1; i < speedHistory.length; i++) {
    const a = speedHistory[i - 1], b = speedHistory[i];
    g.strokeStyle = b.accurate ? '#3ddc97' : '#ff5a5f';
    g.beginPath(); g.moveTo(X(a.t), Y(a.me)); g.lineTo(X(b.t), Y(b.me)); g.stroke();
  }
}

const hooks = {
  onStop(ev) {
    stopText = `멈춤 ${Math.round(ev.ms)}ms · ${ev.counter ? '카운터 스트레이프' : '키만 뗌'}`;
    stopKind = ev.counter && ev.ms <= 75 ? 'stop-good' : 'stop-warn';
    stopUntil = performance.now() + 1500;
  },
  onHud(s) {
    drawSpeedGraph(s);
    $('speedText').textContent = `${s.speed.toFixed(2)} m/s`;
    $('speedFill').style.width = `${Math.min(100, (s.speed / s.runSpeed) * 100)}%`;
    $('speedMark').style.left = `${(s.threshold / s.runSpeed) * 100}%`;
    $('speedBox').classList.toggle('moving', !s.accurate);
    const showStop = performance.now() < stopUntil;
    $('speedState').textContent = showStop ? stopText : s.accurate ? (s.speed < 0.05 ? '정지 · 정확' : '감속 · 정확') : '이동 중 · 부정확';
    $('speedState').className = showStop ? stopKind : '';
    $('compass').textContent = `${s.yaw.toFixed(1)}°  ${s.pitch >= 0 ? '↑' : '↓'}${Math.abs(s.pitch).toFixed(1)}°`;
    $('fps').textContent = `${Math.round(s.fps)} fps`;
    if (s.scenario) {
      $('hudTitle').textContent = s.scenario.title;
      $('hudMain').textContent = s.scenario.main;
      $('hudInfo').textContent = s.scenario.info;
    }
  },
  onFeedback(text, kind) {
    const el = $('feedback');
    el.textContent = text;
    el.className = `show ${kind}`;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { el.className = kind; }, 900);
  },
  onShot(shot) {
    if (!shot.bot) return;
    const c = $('crosshair');
    c.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => c.classList.remove('hit'), 80);
  },
  onDeath() {
    const f = $('flash');
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 60);
  },
  onPause() {
    show('pause');
  },
  onLockChange(locked) {
    if (locked && wantResume) {
      wantResume = false;
      show('clickStart', false);
      show('pause', false);
      show('hud');
      game.resume();
    }
  },
  onEnd(result) {
    show('hud', false);
    show('pause', false);
    showResult(result);
  },
};

const game = new Game($('view'), hooks);
game.settings = settings;

function saveSettings() {
  store.set('vat.settings', settings);
  game.sfx.volume = settings.volume;
  applyCrosshair();
  renderSensStats();
  pushCoach();
}

// 오버레이 코치 카드 갱신 (데스크톱 앱: 오버레이 창, 브라우저: overlay.html 탭)
function pushCoach() {
  const card = buildCoachCard({ settings, history, sessions: coachSessions });
  store.set('vat.coachCard', card);
  window.vatDesktop?.pushCoach(card);
}

function applyCrosshair() {
  const root = document.documentElement.style;
  root.setProperty('--cross', settings.crossColor);
  root.setProperty('--cross-size', `${settings.crossSize}px`);
  root.setProperty('--cross-gap', `${settings.crossGap}px`);
  document.querySelector('#crosshair .dot').style.display = settings.crossDot ? '' : 'none';
  $('speedBox').classList.toggle('no-graph', !settings.speedGraph);
}

// ─── 메뉴 구성 ───
function fillSelect(id, entries) {
  $(id).innerHTML = entries.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
}

function initMenu() {
  $('modes').innerHTML = Object.entries(SCENARIOS)
    .map(([key, s]) => `<button class="mode" data-mode="${key}"><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.desc)}</span></button>`)
    .join('');
  $('modes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) startMode(btn.dataset.mode);
  });

  fillSelect('weapon', Object.entries(WEAPONS).map(([k, w]) => [k, `${w.name} (${(6.75 * w.moveMult).toFixed(2)} m/s)`]));
  fillSelect('difficulty', Object.entries(DIFFICULTY).map(([k, d]) => [k, `${d.name} (${d.reactionMs}ms)`]));
  fillSelect('strafeProfile', Object.entries(STRAFE_PROFILES).map(([k, p]) => [k, p.name]));
  fillSelect('strafeStops', Object.entries(STRAFE_STOPS).map(([k, p]) => [k, p.name]));
  fillSelect('convGame', Object.entries(GAME_YAW).filter(([k]) => k !== 'valorant').map(([k, g]) => [k, g.name]));

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener('input', () => {
      if (el.type === 'checkbox') settings[key] = el.checked;
      else if (el.type === 'number' || el.type === 'range') {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v) || (v <= 0 && el.type === 'number')) return;
        settings[key] = v;
      } else settings[key] = el.value;
      saveSettings();
    });
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'history') renderHistory();
  }));

  const updateConv = () => {
    const v = parseFloat($('convSens').value);
    $('convOut').textContent = Number.isFinite(v) ? roundSens(convertSens(v, $('convGame').value)) : '-';
    const cm = parseFloat($('cmIn').value);
    $('cmOut').textContent = Number.isFinite(cm) && cm > 0 ? roundSens(sensFromCm360(cm, settings.dpi)) : '-';
  };
  ['convSens', 'convGame', 'cmIn'].forEach((id) => $(id).addEventListener('input', updateConv));
  $('dpi').addEventListener('input', updateConv);
  updateConv();
  const applySens = (id) => {
    const v = parseFloat($(id).textContent);
    if (!Number.isFinite(v)) return;
    settings.sens = v;
    $('sens').value = v;
    saveSettings();
  };
  $('convApply').addEventListener('click', () => applySens('convOut'));
  $('cmApply').addEventListener('click', () => applySens('cmOut'));

  $('resEngine').addEventListener('toggle', () => { if ($('resEngine').open) renderEngineCheck(); });
  $('resEngineSave').addEventListener('click', saveSession);
  $('csGo').addEventListener('click', requestResume);
  $('pResume').addEventListener('click', requestResume);
  $('pRestart').addEventListener('click', () => startMode(currentMode));
  $('pFinish').addEventListener('click', () => game.finish());
  $('pMenu').addEventListener('click', toMenu);
  $('resAgain').addEventListener('click', () => startMode(currentMode));
  $('resMenu').addEventListener('click', toMenu);
  $('clearHistory').addEventListener('click', () => {
    history = [];
    coachSessions = [];
    store.set('vat.history', history);
    store.set('vat.coachSessions', coachSessions);
    renderHistory();
    pushCoach();
  });

  applyCrosshair();
  renderSensStats();
  pushCoach();
}

function renderSensStats() {
  const s = settings;
  const e = edpi(s.sens, s.dpi);
  const cm = cm360(s.sens, s.dpi);
  $('sensStats').innerHTML = [
    ['eDPI', fmt(e, 0)],
    ['cm / 360°', `${fmt(cm, 1)} cm`],
    ['inch / 360°', `${fmt(cm / 2.54, 1)} in`],
    ['1카운트당 회전', `${fmt(degPerCount(s.sens), 4)}°`],
    ['90° 플릭 거리', `${fmt(cm / 4, 1)} cm`],
  ].map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');
  const d = describeEdpi(e);
  const el = $('edpiDesc');
  el.className = `note ${d.level}`;
  el.innerHTML = `<b>${escapeHtml(d.label)}</b> · ${escapeHtml(d.text)}`;
}

// ─── 게임 흐름 ───
function startMode(key) {
  const def = SCENARIOS[key];
  if (!def) return;
  currentMode = key;
  game.sfx.volume = settings.volume;
  game.start(new def.cls(game, def.opts || {}));
  game.paused = true;
  show('menu', false);
  show('results', false);
  show('pause', false);
  show('hud');
  $('csTitle').textContent = def.name;
  $('csDesc').textContent = def.desc;
  show('clickStart');
}

function requestResume() {
  wantResume = true;
  game.lock().then((ok) => {
    if (!ok) {
      wantResume = false;
      hooks.onFeedback('포인터 락 실패 · 다시 클릭하세요', 'warn');
    }
  });
}

function toMenu() {
  game.abort();
  show('pause', false);
  show('clickStart', false);
  show('results', false);
  show('hud', false);
  show('menu');
}

// ─── 결과 ───
function showResult(res) {
  if (!res) { toMenu(); return; }
  lastResult = res;
  const st = res.stats;
  $('resTitle').textContent = `${res.modeName} 결과`;
  const w = WEAPONS[res.settings.weapon]?.name || '';
  $('resSub').textContent = `감도 ${res.settings.sens} · ${res.settings.dpi} DPI · eDPI ${Math.round(res.settings.sens * res.settings.dpi)} · ${w}`;

  const tiles = [];
  const t = (label, value) => { if (value !== '-' && value !== undefined) tiles.push([label, value]); };
  if (res.mode === 'peek' || res.mode === 'hold' || res.settings.duel) t('승 / 패', `${st.kills} / ${st.deaths}`);
  else t('킬', `${st.kills}`);
  t('정확도', pct(st.accuracy));
  t('헤드샷 비율', pct(st.headshotRate));
  if (res.mode !== 'flick') t('반응 속도 (중앙값)', Number.isFinite(st.reactionMs) ? `${Math.round(st.reactionMs)}ms` : '-');
  if (res.mode === 'flick') t('타겟당 평균', Number.isFinite(st.avgFlickMs) ? `${st.avgFlickMs}ms` : '-');
  else t('TTK (보인 뒤 킬)', Number.isFinite(st.ttkMs) ? `${Math.round(st.ttkMs)}ms` : '-');
  t('이동 중 사격', pct(st.movingShotRate));
  if (st.stopSamples > 0) {
    t('멈춤 시간 (중앙값)', `${Math.round(st.stopMs)}ms`);
    t('카운터 스트레이프', pct(st.counterRate));
  }
  t('크로스헤어 상하 오차', Number.isFinite(st.placementPitch) ? `${fmt(st.placementPitch, 1)}°` : '-');
  if (res.mode !== 'flick' && res.mode !== 'strafe') t('크로스헤어 좌우 오차', Number.isFinite(st.placementYaw) ? `${fmt(st.placementYaw, 1)}°` : '-');
  t('오버슈팅', pct(st.overshootRate));
  t('언더슈팅', pct(st.undershootRate));
  if (res.mode === 'strafe') {
    t('빗나감: 뒤처짐', pct(st.lagRate));
    t('빗나감: 앞서감', pct(st.leadRate));
    t('멈춘 봇 명중률', pct(st.accStopped));
    t('움직이는 봇 명중률', pct(st.accMoving));
  }
  $('resStats').innerHTML = tiles.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');

  // 감도 추천
  const rec = res.recommendation;
  if (rec) {
    const rows = rec.blocks.map((b) => `<tr><td>×${b.multiplier.toFixed(2)}</td><td>${roundSens(res.settings.sens * b.multiplier)}</td>
      <td>${Math.round(b.avgTime * 1000)}ms</td><td>${b.hits}/${b.shots}</td><td>${pct(b.overshootRate)}</td><td>${pct(b.undershootRate)}</td>
      <td>${b.score.toFixed(3)}</td></tr>`).join('');
    $('resRec').innerHTML = `<div class="rec">
      <small class="muted">추천 발로란트 감도</small>
      <div class="big">${rec.sens}</div>
      <div class="muted">eDPI ${Math.round(rec.edpi)} · ${rec.cm360.toFixed(1)} cm/360 (현재 ${res.settings.sens})</div>
      <ul>${rec.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      <table><tr><th>배율</th><th>감도</th><th>타겟당</th><th>헤드/발사</th><th>오버</th><th>언더</th><th>점수(낮을수록 좋음)</th></tr>${rows}</table>
      <p class="muted">한 번의 테스트는 컨디션 영향을 받습니다. 2~3번 반복해서 비슷한 값이 나오면 그 감도로 1주일 이상 적응해보세요.</p>
      <button id="recApply" class="primary">이 감도 적용</button>
    </div>`;
    $('recApply').addEventListener('click', () => {
      settings.sens = rec.sens;
      $('sens').value = rec.sens;
      saveSettings();
      $('recApply').textContent = '적용됨';
    });
  } else {
    $('resRec').innerHTML = '';
  }

  // 피킹 유형별
  if (res.byType) {
    const rows = Object.values(res.byType).map((b) => `<tr><td>${escapeHtml(b.name)}</td><td>${b.win}/${b.n}</td>
      <td>${Number.isFinite(b.reaction) ? `${b.reaction}ms` : '-'}</td></tr>`).join('');
    $('resExtra').innerHTML = `<h3>피킹 유형별</h3><table><tr><th>유형</th><th>승/전체</th><th>평균 반응</th></tr>${rows}</table>`;
  } else {
    $('resExtra').innerHTML = '';
  }

  $('resEngine').open = false;
  $('resEngine').hidden = !res.session;
  $('resEngineBody').innerHTML = '';

  $('resAdvice').innerHTML = res.advice.length
    ? res.advice.map((a) => `<div class="adv ${a.level}"><b>${escapeHtml(a.title)}</b><p>${escapeHtml(a.text)}</p></div>`).join('')
    : '<p class="muted">데이터가 부족합니다. 조금 더 길게 플레이해보세요.</p>';

  history.unshift({
    date: res.date, mode: res.mode, modeName: res.modeName, sens: res.settings.sens, dpi: res.settings.dpi,
    kills: st.kills, deaths: st.deaths, acc: st.accuracy, hs: st.headshotRate,
    reaction: st.reactionMs, ttk: res.mode === 'flick' ? st.avgFlickMs : st.ttkMs,
    rec: rec ? rec.sens : null,
  });
  history = history.slice(0, 100);
  store.set('vat.history', history);
  coachSessions.unshift({ modeName: res.modeName, date: res.date, advice: res.advice.map(({ level, title, key }) => ({ level, title, key })) });
  coachSessions = coachSessions.slice(0, 5);
  store.set('vat.coachSessions', coachSessions);
  pushCoach();

  show('results');
}

// ─── 실전 분석 엔진 검증 ───
function fmtStat(row, v) {
  if (!Number.isFinite(v)) return '-';
  if (row.scale === 100) return `${Math.round(v * 100)}%`;
  return row.key === 'reactionMs' ? `${Math.round(v)}` : Number.isInteger(v) ? `${v}` : v.toFixed(2);
}

function fmtDiff(row) {
  if (!Number.isFinite(row.diff)) return '';
  const d = row.diff;
  const unit = row.scale === 100 ? '%p' : row.key === 'reactionMs' ? 'ms' : row.key.startsWith('placement') ? '°' : '';
  const txt = `${d >= 0 ? '+' : ''}${row.key === 'reactionMs' || row.scale === 100 ? Math.round(d) : d.toFixed(2)}${unit}`;
  return ` <small class="diff">(${txt})</small>`;
}

function renderEngineCheck() {
  if (!lastResult?.session || $('resEngineBody').innerHTML) return;
  const v = validateResult(lastResult);
  if (!v) return;
  const head = `<tr><th>항목</th><th>트레이너 정답</th>${v.runs.map((r) => `<th>${escapeHtml(r.name)}</th>`).join('')}</tr>`;
  const rows = v.runs[0].rows.map((row, i) => {
    if (!Number.isFinite(row.truth) && v.runs.every((r) => !Number.isFinite(r.rows[i].est))) return '';
    return `<tr><td>${escapeHtml(row.label)}</td><td>${fmtStat(row, row.truth)}</td>${
      v.runs.map((r) => `<td>${fmtStat(r.rows[i], r.rows[i].est)}${fmtDiff(r.rows[i])}</td>`).join('')}</tr>`;
  }).join('');
  const est = v.runs[0].est.stats;
  const extra = [
    Number.isFinite(est.aimMovingShotRate) ? `조준 이동 중 사격 ${pct(est.aimMovingShotRate)}` : '',
    Number.isFinite(est.jitterDeg) ? `각 잡을 때 떨림 ${est.jitterDeg.toFixed(2)}°` : '',
    Number.isFinite(est.pitchDriftDegPerSec) ? `이동 중 시야 흐름 ${est.pitchDriftDegPerSec.toFixed(2)}°/s` : '',
  ].filter(Boolean).join(' · ');
  const per = v.runs.filter((r) => r.per).map((r) => {
    const p = r.per;
    const parts = [`교전 ${p.matched}/${p.truthCount} 찾음`];
    if (Number.isFinite(p.reactionErrMs)) parts.push(`반응 오차 ${Math.round(p.reactionErrMs)}ms`);
    if (Number.isFinite(p.placementErrDeg)) parts.push(`배치 오차 ${p.placementErrDeg.toFixed(2)}°`);
    if (p.flickPairs) parts.push(`오버/언더 판정 일치 ${pct(p.flickAgree)} (${p.flickPairs}개)`);
    parts.push(`녹화 지연 추정 ${r.est.stats.frameLagMs}ms (실제 30ms)`);
    return `<li><b>${escapeHtml(r.name)}</b>: ${escapeHtml(parts.join(' · '))}</li>`;
  }).join('');
  $('resEngineBody').innerHTML = `<table class="engine-table">${head}${rows}</table>
    ${per ? `<p class="muted">교전별 비교 (중앙값)</p><ul class="engine-per">${per}</ul>` : ''}
    ${extra ? `<p class="muted">입력 기록 전용 분석 (정답 없음): ${escapeHtml(extra)}</p>` : ''}`;
}

function saveSession() {
  if (!lastResult?.session) return;
  const blob = new Blob([JSON.stringify(lastResult.session)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `session-${lastResult.mode}-${new Date(lastResult.date).toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderHistory() {
  if (!history.length) {
    $('historyList').innerHTML = '<p class="muted">아직 기록이 없습니다.</p>';
    return;
  }
  const rows = history.map((h) => {
    const d = new Date(h.date);
    const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<tr><td>${date}</td><td>${escapeHtml(h.modeName)}</td><td>${h.sens}</td><td>${h.kills}${h.deaths ? ` / ${h.deaths}` : ''}</td>
      <td>${pct(h.acc)}</td><td>${pct(h.hs)}</td><td>${Number.isFinite(h.reaction) ? Math.round(h.reaction) + 'ms' : '-'}</td>
      <td>${Number.isFinite(h.ttk) ? Math.round(h.ttk) + 'ms' : '-'}</td><td>${h.rec ?? ''}</td></tr>`;
  }).join('');
  $('historyList').innerHTML = `<table><tr><th>날짜</th><th>모드</th><th>감도</th><th>킬/데스</th><th>정확도</th><th>헤드</th>
    <th>반응</th><th>TTK/타겟</th><th>추천 감도</th></tr>${rows}</table>`;
}

initMenu();
window.__app = { game, settings, startMode, get lastResult() { return lastResult; } };
