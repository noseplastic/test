// 코치 카드 DOM 렌더링. 트레이너 미리보기와 오버레이 창이 같이 쓴다.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const dateLabel = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * card: buildCoachCard() 결과, tipIndex: 라운드 리마인더 순번, hint: 하단 안내 문구
 */
export function renderCoachCard(root, card, { tipIndex = 0, hint = '' } = {}) {
  root.replaceChildren();
  const box = el('div', 'coach-card');
  if (!card) {
    box.append(el('div', 'cc-empty', '트레이너를 한 번 실행하면 여기에 코치 카드가 표시됩니다.'));
    root.append(box);
    return;
  }

  const head = el('div', 'cc-head');
  head.append(el('b', '', 'VALO COACH'), el('span', 'cc-sens', `${card.sens} · eDPI ${card.edpi} · ${card.cm360}cm`));
  box.append(head);

  if (card.rec) {
    box.append(el('div', 'cc-rec', `추천 감도 ${card.rec.sens} (감도 찾기 ${dateLabel(card.rec.date)})`));
  }

  box.append(el('div', 'cc-sec', '집중 포인트'));
  if (card.focus.length) {
    const list = el('ol', 'cc-focus');
    for (const f of card.focus) {
      const li = el('li', f.level);
      li.append(el('b', '', f.cue), el('small', '', `${f.title} · ${f.from}`));
      list.append(li);
    }
    box.append(list);
  } else {
    box.append(el('div', 'cc-empty', '훈련하거나 실전 기록을 입력하면 고칠 점이 여기에 떠요.'));
  }

  if (card.tips.length) {
    box.append(el('div', 'cc-sec', '라운드 리마인더'));
    box.append(el('div', 'cc-tip', card.tips[((tipIndex % card.tips.length) + card.tips.length) % card.tips.length]));
  }

  const foot = el('div', 'cc-foot');
  foot.append(el('span', card.warmup ? 'ok' : 'todo', card.warmup ? `오늘 워밍업 ${card.warmup}회 ✓` : '오늘 워밍업 전 · 랭크 전에 5분'));
  if (hint) foot.append(el('span', '', hint));
  box.append(foot);
  root.append(box);
}
