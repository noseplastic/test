// 오버레이 창: 코치 카드만 표시한다. 게임 화면·메모리·입력은 읽지 않는다.
import { renderCoachCard } from './coach-view.js';

const root = document.getElementById('root');
const desk = window.vatDesktop;
let card = null;
let config = { tipSeconds: 25, opacity: 0.82, scale: 1 };
let tipIndex = 0;
let tipTimer = 0;

function render() {
  const hint = desk ? 'Ctrl+Shift+N 다음 팁' : '';
  renderCoachCard(root, card, { tipIndex, hint });
  document.documentElement.style.setProperty('--cc-alpha', String(config.opacity));
  root.style.transform = `scale(${config.scale})`;
  if (desk) {
    const r = root.getBoundingClientRect();
    const hintH = document.body.classList.contains('move') ? 34 : 0;
    desk.reportSize(Math.ceil(r.width), Math.ceil(r.height + hintH));
  }
}

function nextTip() {
  tipIndex++;
  render();
}

function restartTimer() {
  clearInterval(tipTimer);
  if (config.tipSeconds > 0) tipTimer = setInterval(nextTip, config.tipSeconds * 1000);
}

if (desk) {
  desk.onCoach((c) => { card = c; render(); });
  desk.onConfig((c) => { config = { ...config, ...c }; restartTimer(); render(); });
  desk.onNextTip(nextTip);
  desk.onMoveMode((on) => { document.body.classList.toggle('move', on); render(); });
  desk.getState().then((s) => {
    card = s.card;
    config = { ...config, ...s.config };
    restartTimer();
    render();
  });
} else {
  // 브라우저: 트레이너 탭이 localStorage 에 저장한 카드를 표시 (두 번째 모니터용)
  document.body.classList.add('browser');
  const load = () => {
    try { card = JSON.parse(localStorage.getItem('vat.coachCard') || 'null'); } catch { card = null; }
    render();
  };
  window.addEventListener('storage', (e) => { if (e.key === 'vat.coachCard') load(); });
  load();
  restartTimer();
}
