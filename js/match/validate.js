// 트레이너 세션으로 실전 분석 엔진의 정확도를 검증한다.
// 트레이너는 적 위치·명중·속도를 정확히 알기 때문에 그 결과를 "정답"으로 쓰고,
// 같은 세션을 녹화 영상처럼 만든 뒤(60fps, 인식 오차) 엔진이 얼마나 비슷하게 맞히는지 본다.
import { analyzeSession, compareStats, trackingBias, flickClass } from './engine.js';
import { median } from '../analysis.js';
import { makeRng } from '../bots.js';

export const NOISE_LEVELS = {
  perfect: { name: '완벽한 인식', jitterPx: 0, missRate: 0, falseRate: 0 },
  normal: { name: '인식 오차 보통', jitterPx: 2, missRate: 0.1, falseRate: 0.01 },
  heavy: { name: '인식 오차 심함', jitterPx: 5, missRate: 0.25, falseRate: 0.03 },
};

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
}

/**
 * 녹화 영상에서 적을 찾은 것처럼 프레임을 바꾼다.
 * - fps 로 다시 샘플링 (녹화 프레임레이트)
 * - 머리 위치 흔들림 (jitterPx, 가우시안 σ), 놓침 (missRate), 헛인식 (falseRate)
 * - lagMs: 화면이 입력보다 늦게 찍히는 지연 (엔진이 스스로 추정해야 함)
 * - clicksOnly: 실제 발사 시각 대신 클릭으로 추정
 */
export function degradeSession(session, { fps = 60, jitterPx = 0, missRate = 0, falseRate = 0, seed = 1, clicksOnly = true, lagMs = 30 } = {}) {
  const rng = makeRng(seed);
  const period = 1000 / fps;
  const frames = [];
  let next = -Infinity;
  for (const fr of session.frames) {
    if (fr.t + 1e-6 < next) continue;
    next = (Number.isFinite(next) ? next : fr.t) + period;
    const heads = [];
    for (const h of fr.heads) {
      if (rng() < missRate) continue;
      heads.push({ x: h.x + gauss(rng) * jitterPx, y: h.y + gauss(rng) * jitterPx, r: Math.max(1, h.r * (1 + gauss(rng) * 0.1 * (jitterPx > 0))) });
    }
    if (rng() < falseRate) {
      heads.push({ x: rng() * session.meta.width, y: rng() * session.meta.height, r: 3 + rng() * 6 });
    }
    // 녹화 영상에는 "몇 번째 마우스 입력까지 반영됐는지"가 없고, 화면이 입력보다 lagMs 늦게 찍힌다
    frames.push({ t: fr.t + lagMs, heads });
  }
  return { ...session, frames, shots: clicksOnly ? undefined : session.shots };
}

// 정답 쪽 지표를 엔진과 같은 정의로 맞춘다 (트래킹 뒤처짐은 명중 여부와 무관하게 계산)
function truthStats(result) {
  return result.engagements ? { ...result.stats, ...trackingBias(result.engagements) } : result.stats;
}

// 교전 짝짓기: 등장 시각이 가장 가까운 것끼리 (tol 초 이내)
export function matchEngagements(truth, est, tol = 0.25) {
  const pairs = [];
  const used = new Set();
  for (const a of truth) {
    if (!Number.isFinite(a.appearT)) continue;
    let best = null, bestD = tol;
    est.forEach((b, i) => {
      const d = Math.abs(b.appearT - a.appearT);
      if (!used.has(i) && d <= bestD) { bestD = d; best = i; }
    });
    if (best !== null) { used.add(best); pairs.push([a, est[best]]); }
  }
  return pairs;
}

// 교전 단위로 얼마나 같은지
export function perEngagement(truth, est) {
  const tr = truth.filter((e) => Number.isFinite(e.appearT));
  const pairs = matchEngagements(tr, est);
  const react = [], place = [], flick = [];
  for (const [a, b] of pairs) {
    if (Number.isFinite(a.firstShotT) && Number.isFinite(b.firstShotT)) {
      react.push(Math.abs((b.firstShotT - b.appearT) - (a.firstShotT - a.appearT)) * 1000);
    }
    if (a.placement && b.placement) {
      place.push(Math.hypot(Math.abs(b.placement.ex) - Math.abs(a.placement.ex), b.placement.ey - a.placement.ey));
    }
    const fa = flickClass(a), fb = flickClass(b);
    if (fa && fb) flick.push(fa === fb);
  }
  return {
    truthCount: tr.length,
    estCount: est.length,
    matched: pairs.length,
    reactionErrMs: median(react),
    placementErrDeg: median(place),
    flickAgree: flick.length ? flick.filter(Boolean).length / flick.length : NaN,
    flickPairs: flick.length,
  };
}

// 플릭 모드는 타겟이 화면 밖에서 생기기도 해서 "등장" 정의가 달라 반응·배치는 비교하지 않는다
const SKIP_ROWS = { flick: ['reactionMs', 'placementPitch', 'placementYaw'], finder: ['reactionMs', 'placementPitch', 'placementYaw'] };

// 트레이너 결과 1개 → 인식 오차 단계별 비교
export function validateResult(result, levels = Object.keys(NOISE_LEVELS)) {
  if (!result?.session) return null;
  const truth = truthStats(result);
  const skip = new Set(SKIP_ROWS[result.mode] || []);
  const runs = levels.map((key) => {
    const est = analyzeSession(degradeSession(result.session, { ...NOISE_LEVELS[key], seed: 7 }));
    return {
      key,
      name: NOISE_LEVELS[key].name,
      rows: compareStats(truth, est.stats).filter((r) => !skip.has(r.key)),
      per: result.engagements ? perEngagement(result.engagements, est.engagements) : null,
      est,
    };
  });
  return { truth, runs };
}
