// 인게임 오버레이에 띄울 "코치 카드"와 실전(트래커) 기록 분석. DOM 의존성 없음.
import { edpi, cm360 } from './sens.js';

// 조언 key → 게임 중에 한눈에 읽을 짧은 리마인더
export const CUES = {
  reaction: '적 나올 자리에 미리 조준 → 반응만 하기',
  'placement-low': '크로스헤어 = 머리 높이, 바닥 보지 않기',
  'placement-high': '크로스헤어를 머리선에 딱 맞추기',
  preaim: '피킹 전에 모서리에 프리에임',
  'moving-shot': '쏘기 전에 멈추기 (속도 30% 이하)',
  'counter-strafe': 'D 떼면서 A 톡 → 카운터 스트레이프',
  overshoot: '플릭은 머리에서 "멈춘다"',
  undershoot: '플릭 거리를 과감하게',
  corrections: '한 번에 멈추는 플릭, 나눠 끌지 않기',
  'tracking-lag': '적 이동 방향 살짝 앞에 크로스헤어',
  'tracking-lead': '예측 줄이고 머리를 따라가기',
  'stop-timing': '적이 멈출 때 나도 멈추고 쏘기',
  duel: '멈춘 적 → 카운터 스트레이프 → 1~2발 탭',
  headshot: '몸샷 여러 발보다 헤드 1발',
  spray: '중·원거리는 1~2발 탭 / 버스트',
  'peek-loss': '짧게 나가서 멈추고 1발',
  bait: '숄더 피크엔 쏘지 말고 반응만',
  'edpi-high': '감도 찾기로 감도 재점검',
  'edpi-low': '감도 찾기로 감도 재점검',
  'leg-shots': '다리샷 = 낮은 조준 / 이동 사격 체크',
  'first-death': '드라이 피크 금지 · 스킬 먼저 쓰고 피크',
  trade: '팀원과 트레이드 가능한 거리 유지',
  finish: '데미지 준 적은 리셋 후 다시 교전',
  'aim-moving-shot': '플릭 끝에서 멈추고 쏘기',
  tremor: '각 잡을 땐 손 힘 빼기',
  'pitch-drift': '달릴 때도 머리 높이 유지',
};

// 약점과 상관없이 돌아가며 보여줄 기본 리마인더
export const GENERAL_TIPS = [
  '라운드 시작마다 크로스헤어 높이 체크',
  '각은 한 번에 하나씩 잘라서 확인',
  '같은 각도로 연속 재피크 하지 않기',
  '킬 후엔 자리 옮기거나 트레이드 대기',
  '스프레이보다 버스트 후 리셋',
  '뛸 필요 없을 땐 걸어서 정보 숨기기',
  '어깨 힘 빼고 호흡 — 긴장하면 오버슈팅',
];

const LEVEL_RANK = { bad: 0, warn: 1, good: 2 };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * 트래커(tracker.gg 등)에서 보는 실전 기록 → 조언 목록.
 * m: { hs, body, leg, kast }(%) · { kd, adr } · { fk, fd }(최근 경기 합계). 비어 있는 값은 건너뛴다.
 */
export function analyzeMatchStats(m = {}) {
  const out = [];
  const add = (level, title, text, key) => out.push({ level, title, text, key });
  const { hs, body, leg, kd, adr, kast, fk, fd } = m;

  if (isNum(hs)) {
    if (hs < 15) {
      add('bad', `헤드샷 ${hs}%`, '맞힌 샷 대부분이 몸/다리입니다. 크로스헤어가 머리보다 낮은 채로 다니고 있을 가능성이 커요. 이동할 때도 크로스헤어를 머리 높이(벽 모서리 기준)에 붙이세요. 훈련 탭의 앵글 홀드/코너 피킹이 크로스헤어 높이를 측정합니다.', 'placement-low');
    } else if (hs < 22) {
      add('warn', `헤드샷 ${hs}%`, '평균 근처입니다. 교전 시작 전 크로스헤어 높이만 지켜도 헤드 비율이 크게 오릅니다. 첫 발 이후 연사로 몸을 긁는 습관이 있다면 1~2발 탭 후 리셋하세요.', 'headshot');
    } else {
      add('good', `헤드샷 ${hs}%`, hs >= 28 ? '상위권 헤드 비율입니다. 크로스헤어 배치가 좋아요.' : '평균 이상의 헤드 비율입니다.', 'headshot');
    }
  }

  if (isNum(leg) && leg >= 8) {
    add('warn', `다리샷 ${leg}%`, '다리 명중이 많아요. 크로스헤어가 낮거나, 이동 중에 쏴서 탄이 퍼지는 경우입니다. 쏘기 전에 카운터 스트레이프로 멈추세요.', 'leg-shots');
  }

  if (isNum(fk) && isNum(fd) && fk + fd >= 5) {
    if (fd > fk * 1.5) {
      add('bad', `첫 킬 ${fk} / 첫 데스 ${fd}`, '라운드 첫 교전에서 지는 경우가 많아요. 정보 없이 넓게 나가는 드라이 피크를 줄이고, 스킬을 쓰거나 팀원과 같이 피크하세요. 앵글 홀드 모드로 먼저 쏘는 연습을 하세요.', 'first-death');
    } else if (fk >= fd * 1.3) {
      add('good', `첫 킬 ${fk} / 첫 데스 ${fd}`, '첫 교전 승률이 좋습니다.', 'first-death');
    }
  }

  if (isNum(kd) && isNum(adr)) {
    if (adr >= 140 && kd < 1.0) {
      add('warn', `ADR ${adr} · K/D ${kd}`, '데미지는 충분히 넣는데 킬로 마무리가 안 돼요. 몸샷 교전이 길어지고 있다는 뜻입니다. 맞힌 적에게 같은 각도로 바로 재피크하지 말고, 헤드 한 발로 끝내는 연습(플릭·스트레이프 듀얼)을 하세요.', 'finish');
    } else if (kd >= 1.2) {
      add('good', `K/D ${kd}`, '교전 결과가 좋습니다.', 'finish');
    }
  }
  if (isNum(adr) && adr < 110) {
    add('warn', `ADR ${adr}`, '라운드당 넣는 데미지가 적어요. 교전 참여 자체가 적거나 첫 발이 자주 빗나가는 경우입니다. 헤드샷 비율과 첫 킬/데스를 같이 확인해보세요.', 'headshot');
  }
  if (isNum(kast) && kast < 65) {
    add('warn', `KAST ${kast}%`, '킬·어시·생존·트레이드 어느 것도 못 한 라운드가 많아요. 혼자 떨어져 죽지 말고 팀원이 바로 트레이드할 수 있는 거리에서 교전하세요.', 'trade');
  }
  if (isNum(body) && isNum(hs) && isNum(leg) && Math.abs(hs + body + leg - 100) > 3) {
    add('warn', '입력 확인', `헤드 + 몸 + 다리 비율의 합이 ${hs + body + leg}% 입니다. 트래커의 명중 부위 비율을 다시 확인하세요.`);
  }
  return out;
}

/**
 * 여러 출처(훈련 결과, 실전 기록)의 조언 중 고칠 것(bad → warn)을 골라 중복 없이 정리.
 * sources: [{ from, date, advice: [{ level, title, key }] }]
 */
export function pickFocus(sources, limit = 3) {
  const items = [];
  for (const src of sources || []) {
    for (const a of src.advice || []) {
      if (a.level === 'good' || !a.key || !CUES[a.key]) continue;
      items.push({ level: a.level, title: a.title, key: a.key, cue: CUES[a.key], from: src.from, date: src.date || 0 });
    }
  }
  items.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.date - a.date);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.cue)) continue;
    seen.add(it.cue);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

// 오늘(로컬 날짜) 훈련 횟수
export function todayTraining(history, now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = (history || []).filter((h) => h.date >= start && h.date <= now);
  return { count: today.length, modes: [...new Set(today.map((h) => h.modeName))] };
}

/**
 * 오버레이 카드 데이터.
 * sessions: 최근 훈련 결과 [{ modeName, date, advice }], match: { date, advice } | null
 */
export function buildCoachCard({ settings, history = [], sessions = [], match = null, now = Date.now() }) {
  const sens = settings.sens;
  const dpi = settings.dpi;
  const sources = sessions.map((s) => ({ from: s.modeName, date: s.date, advice: s.advice }));
  if (match) sources.push({ from: '실전 기록', date: match.date, advice: match.advice });
  const focus = pickFocus(sources, 3);

  const tips = [...focus.map((f) => f.cue)];
  for (const t of GENERAL_TIPS) if (!tips.includes(t)) tips.push(t);

  // 가장 최근 감도 찾기 결과가 현재 감도와 다르면 표시
  let rec = null;
  const last = history.find((h) => isNum(h.rec));
  if (last && Math.abs(last.rec - sens) / sens > 0.005) {
    rec = { sens: last.rec, from: last.sens, date: last.date };
  }

  const today = todayTraining(history, now);
  return {
    sens,
    dpi,
    edpi: Math.round(edpi(sens, dpi)),
    cm360: Math.round(cm360(sens, dpi) * 10) / 10,
    rec,
    focus,
    tips,
    warmup: today.count,
    warmupModes: today.modes,
    updated: now,
  };
}
