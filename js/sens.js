import { VALORANT, GAME_YAW } from './config.js';

const INCH_CM = 2.54;

export function degPerCount(sens) {
  return VALORANT.YAW_DEG_PER_COUNT * sens;
}

export function edpi(sens, dpi) {
  return sens * dpi;
}

// 360도 회전에 필요한 마우스 이동 거리 (cm)
export function cm360(sens, dpi) {
  return (360 * INCH_CM) / (VALORANT.YAW_DEG_PER_COUNT * sens * dpi);
}

export function sensFromCm360(cm, dpi) {
  return (360 * INCH_CM) / (VALORANT.YAW_DEG_PER_COUNT * cm * dpi);
}

// 다른 게임 감도를 발로란트 감도로 (DPI가 같다고 가정)
export function convertSens(sens, fromGame, toGame = 'valorant') {
  const from = GAME_YAW[fromGame];
  const to = GAME_YAW[toGame];
  if (!from || !to) throw new Error(`unknown game: ${fromGame} / ${toGame}`);
  return (sens * from.yaw) / to.yaw;
}

// eDPI 구간별 설명. 발로란트 프로 eDPI는 대부분 200~400 (평균 280 전후).
export function describeEdpi(value) {
  if (value < 150) {
    return { level: 'warn', label: '매우 낮음', text: '팔 전체를 크게 써야 하는 감도입니다. 넓은 마우스패드가 필요하고 근접 교전·뒤돌기에서 느릴 수 있어요.' };
  }
  if (value < 200) {
    return { level: 'good', label: '낮음', text: '정밀 조준에 유리한 저감도입니다. 원거리 헤드라인 유지에 강하지만 넓은 각도 전환은 팔 움직임이 필요해요.' };
  }
  if (value <= 400) {
    return { level: 'good', label: '프로 표준 구간', text: '대부분의 발로란트 프로가 쓰는 구간(eDPI 200~400)입니다.' };
  }
  if (value <= 550) {
    return { level: 'warn', label: '높음', text: '빠른 플릭에는 유리하지만 미세 조정과 원거리 헤드라인 유지가 어려울 수 있어요.' };
  }
  return { level: 'bad', label: '매우 높음', text: '발로란트 기준 매우 높은 감도입니다. 손목 떨림이 그대로 크로스헤어에 전달되어 오버슈팅이 잦을 확률이 높아요.' };
}

export function roundSens(sens) {
  return Math.round(sens * 1000) / 1000;
}

// 최소제곱 2차 회귀: y = a x² + b x + c
function quadFit(xs, ys) {
  const n = xs.length;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // [s4 s3 s2][a]   [t2]
  // [s3 s2 s1][b] = [t1]
  // [s2 s1 s0][c]   [t0]
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  const a = det([[t2, s3, s2], [t1, s2, s1], [t0, s1, s0]]) / D;
  const b = det([[s4, t2, s2], [s3, t1, s1], [s2, t0, s0]]) / D;
  const c = det([[s4, s3, t2], [s3, s2, t1], [s2, s1, t0]]) / D;
  return { a, b, c };
}

// 감도 블록 한 개의 점수 (낮을수록 좋음).
// 타겟당 평균 시간에 빗나감·오버/언더슈팅 페널티를 곱한다.
export function blockScore(block) {
  const acc = block.shots > 0 ? block.hits / block.shots : 0;
  const flickErr = (block.overshootRate || 0) + (block.undershootRate || 0);
  return block.avgTime * (1 + 0.8 * (1 - acc) + 0.3 * flickErr);
}

/**
 * 감도 찾기 테스트 결과로 추천 감도를 계산한다.
 * blocks: [{ multiplier, avgTime, hits, shots, overshootRate, undershootRate }]
 */
export function recommendSensitivity(baseSens, dpi, blocks) {
  const valid = blocks.filter((b) => b.shots > 0 && Number.isFinite(b.avgTime));
  if (valid.length === 0) return null;

  const scored = valid.map((b) => ({ ...b, score: blockScore(b) }));
  scored.sort((a, b) => a.multiplier - b.multiplier);
  const best = scored.reduce((m, b) => (b.score < m.score ? b : m), scored[0]);
  let multiplier = best.multiplier;
  const reasons = [];

  // 로그 스케일에서 2차 곡선을 맞춰 최저점을 찾는다 (노이즈 완화)
  if (scored.length >= 4) {
    const xs = scored.map((b) => Math.log(b.multiplier));
    const fit = quadFit(xs, scored.map((b) => b.score));
    if (fit && fit.a > 0) {
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const vx = Math.min(maxX, Math.max(minX, -fit.b / (2 * fit.a)));
      multiplier = Math.exp(vx);
      reasons.push(`점수 곡선의 최저점이 현재 감도의 ×${multiplier.toFixed(2)} 부근입니다.`);
    } else {
      reasons.push(`가장 점수가 좋았던 구간은 현재 감도의 ×${best.multiplier.toFixed(2)} 입니다.`);
    }
  } else {
    reasons.push(`가장 점수가 좋았던 구간은 현재 감도의 ×${best.multiplier.toFixed(2)} 입니다.`);
  }

  // 전체 오버/언더슈팅 경향으로 미세 보정
  const total = valid.reduce((s, b) => s + (b.targets || 1), 0);
  const over = valid.reduce((s, b) => s + (b.overshootRate || 0) * (b.targets || 1), 0) / total;
  const under = valid.reduce((s, b) => s + (b.undershootRate || 0) * (b.targets || 1), 0) / total;
  if (over - under > 0.2) {
    multiplier *= 0.95;
    reasons.push(`오버슈팅(${Math.round(over * 100)}%)이 언더슈팅(${Math.round(under * 100)}%)보다 많아 5% 낮췄습니다.`);
  } else if (under - over > 0.2) {
    multiplier *= 1.05;
    reasons.push(`언더슈팅(${Math.round(under * 100)}%)이 오버슈팅(${Math.round(over * 100)}%)보다 많아 5% 높였습니다.`);
  }

  const sens = roundSens(baseSens * multiplier);
  return {
    sens,
    multiplier,
    edpi: edpi(sens, dpi),
    cm360: cm360(sens, dpi),
    overshootRate: over,
    undershootRate: under,
    blocks: scored,
    reasons,
  };
}
