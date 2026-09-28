import { Game, DEFAULT_SETTINGS } from './game.js';
import { SCENARIOS } from './scenarios.js';
import { WEAPONS, DIFFICULTY, GAME_YAW } from './config.js';
import { STRAFE_PROFILES, STRAFE_STOPS } from './bots.js';
import { cm360, edpi, degPerCount, convertSens, sensFromCm360, describeEdpi, roundSens } from './sens.js';

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
const hooks = {
  onHud(s) {
    $('speedText').textContent = `${s.speed.toFixed(2)} m/s`;
    $('speedFill').style.width = `${Math.min(100, (s.speed / s.runSpeed) * 100)}%`;
    $('speedMark').style.left = `${(s.threshold / s.runSpeed) * 100}%`;
    $('speedBox').classList.toggle('moving', !s.accurate);
    $('speedState').textContent = s.accurate ? (s.speed < 0.05 ? '정지 · 정확' : '감속 · 정확') : '이동 중 · 부정확';
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
}

function applyCrosshair() {
  const root = document.documentElement.style;
  root.setProperty('--cross', settings.crossColor);
  root.setProperty('--cross-size', `${settings.crossSize}px`);
  root.setProperty('--cross-gap', `${settings.crossGap}px`);
  document.querySelector('#crosshair .dot').style.display = settings.crossDot ? '' : 'none';
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

  $('csGo').addEventListener('click', requestResume);
  $('pResume').addEventListener('click', requestResume);
  $('pRestart').addEventListener('click', () => startMode(currentMode));
  $('pFinish').addEventListener('click', () => game.finish());
  $('pMenu').addEventListener('click', toMenu);
  $('resAgain').addEventListener('click', () => startMode(currentMode));
  $('resMenu').addEventListener('click', toMenu);
  $('clearHistory').addEventListener('click', () => {
    history = [];
    store.set('vat.history', history);
    renderHistory();
  });

  applyCrosshair();
  renderSensStats();
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

  show('results');
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
