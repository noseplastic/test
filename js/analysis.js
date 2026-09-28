// 교전 기록을 분석해서 통계와 조언(한국어)을 만든다. DOM/three.js 의존성 없음.
//
// Engagement 형식:
// {
//   mode, appearT, firstShotT, endT, result: 'kill' | 'death' | 'escape' | 'timeout',
//   placement: { ex, ey } | null   // 적이 보인 순간 크로스헤어→머리 각도 오차 (deg)
//   path: [{ t, ex, ey }]          // 보인 순간 ~ 첫 발까지 오차 샘플
//   radiusDeg,                     // 머리 히트박스의 각도 반지름
//   shots: [{ t, part: 'head'|'body'|'leg'|null, moving, speed, ex, ey, targetVel, spray }]
//   bait: boolean                  // 숄더 피크 미끼 (반응속도 계산에서 제외)
// }
// ex: 좌우 오차, ey: 상하 오차 (+ 이면 타겟이 크로스헤어보다 위)
// targetVel: 타겟의 좌우 각속도 (deg/s, ex 와 같은 부호 규칙)

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

/**
 * 플릭 궤적 분석: 오버슈팅 / 언더슈팅 / 보정 횟수
 * path: [{ t, ex, ey }] 타겟 - 크로스헤어 오차
 */
export function analyzeFlick(path, radiusDeg) {
  if (!path || path.length < 4) return { skip: true };
  const d0 = Math.hypot(path[0].ex, path[0].ey);
  // 이미 거의 머리에 있었다면 플릭이 아님
  if (d0 < Math.max(radiusDeg * 2.5, 1.0)) return { skip: true };
  const ux = path[0].ex / d0;
  const uy = path[0].ey / d0;

  // 진행 방향으로 남은 거리 (음수면 타겟을 지나침)
  const along = path.map((p) => p.ex * ux + p.ey * uy);

  // 크로스헤어 각속도 (3샘플 이동평균)
  const raw = [0];
  for (let i = 1; i < path.length; i++) {
    const dt = Math.max(1e-4, path[i].t - path[i - 1].t);
    raw.push(Math.hypot(path[i].ex - path[i - 1].ex, path[i].ey - path[i - 1].ey) / dt);
  }
  const speed = raw.map((_, i) => {
    const a = raw[Math.max(0, i - 1)], b = raw[i], c = raw[Math.min(raw.length - 1, i + 1)];
    return (a + b + c) / 3;
  });

  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < speed.length; i++) {
    if (speed[i] > peak) { peak = speed[i]; peakIdx = i; }
  }
  if (peak < 20) return { skip: true };

  // 1차 이동이 끝나는 지점: 최고 속도 이후 처음으로 20% 이하로 떨어진 순간
  let endIdx = path.length - 1;
  for (let i = peakIdx; i < speed.length; i++) {
    if (speed[i] < peak * 0.2) { endIdx = i; break; }
  }

  let minAlong = Infinity;
  for (const a of along) minAlong = Math.min(minAlong, a);
  const overshoot = minAlong < -radiusDeg;
  const primaryEnd = along[endIdx];
  const undershoot = !overshoot && primaryEnd > radiusDeg;

  // 1차 이동 후 추가로 발생한 속도 봉우리 수 = 미세 보정 횟수
  let corrections = 0;
  let rising = false;
  const corrThreshold = Math.max(15, peak * 0.12);
  for (let i = endIdx + 1; i < speed.length; i++) {
    if (!rising && speed[i] > corrThreshold) { rising = true; corrections++; }
    else if (rising && speed[i] < corrThreshold * 0.5) rising = false;
  }

  return {
    skip: false,
    overshoot,
    undershoot,
    overshootDeg: overshoot ? -minAlong : 0,
    undershootDeg: undershoot ? primaryEnd : 0,
    flickDeg: d0,
    peakSpeed: peak,
    corrections,
  };
}

// 플레이어 멈춤 기록 [{ ms, counter }] 요약
export function summarizeStops(events) {
  const e = events || [];
  return {
    stopSamples: e.length,
    stopMs: median(e.map((x) => x.ms)),
    counterRate: e.length ? e.filter((x) => x.counter).length / e.length : NaN,
  };
}

export function summarize(engagements) {
  const shots = engagements.flatMap((e) => e.shots || []);
  const hits = shots.filter((s) => s.part);
  const heads = hits.filter((s) => s.part === 'head');
  const kills = engagements.filter((e) => e.result === 'kill');
  const deaths = engagements.filter((e) => e.result === 'death');

  const reactions = engagements
    .filter((e) => !e.bait && Number.isFinite(e.firstShotT) && Number.isFinite(e.appearT))
    .map((e) => (e.firstShotT - e.appearT) * 1000);
  const ttk = kills
    .filter((e) => Number.isFinite(e.appearT))
    .map((e) => (e.endT - e.appearT) * 1000);

  const placements = engagements.filter((e) => e.placement && !e.bait);
  const flicks = engagements
    .filter((e) => !e.bait)
    .map((e) => analyzeFlick(e.path, e.radiusDeg || 0.8))
    .filter((f) => !f.skip);

  // 움직이는 타겟을 빗나간 샷: 뒤처짐(lag) vs 앞서감(lead)
  let lag = 0, lead = 0;
  for (const s of shots) {
    if (s.part === 'head') continue;
    if (!Number.isFinite(s.targetVel) || Math.abs(s.targetVel) < 3) continue;
    if (!Number.isFinite(s.ex) || Math.abs(s.ex) < 0.1) continue;
    if (Math.sign(s.ex) === Math.sign(s.targetVel)) lag++;
    else lead++;
  }

  const bodyOrLeg = hits.filter((s) => s.part !== 'head');
  const atStopped = shots.filter((s) => s.targetStopped === true);
  const atMoving = shots.filter((s) => s.targetStopped === false);
  const hitRate = (arr) => (arr.length ? arr.filter((s) => s.part).length / arr.length : NaN);
  const lowShots = shots.filter((s) => s.part !== 'head' && Number.isFinite(s.ey) && s.ey > 0.15);

  return {
    engagements: engagements.length,
    kills: kills.length,
    deaths: deaths.length,
    escapes: engagements.filter((e) => e.result === 'escape').length,
    shots: shots.length,
    hits: hits.length,
    accuracy: shots.length ? hits.length / shots.length : NaN,
    headshotRate: hits.length ? heads.length / hits.length : NaN,
    reactionMs: median(reactions),
    reactionSamples: reactions.length,
    ttkMs: median(ttk),
    movingShotRate: shots.length ? shots.filter((s) => s.moving).length / shots.length : NaN,
    sprayShotRate: shots.length ? shots.filter((s) => s.spray >= 3).length / shots.length : NaN,
    placementPitch: median(placements.map((e) => Math.abs(e.placement.ey))),
    placementYaw: median(placements.map((e) => Math.abs(e.placement.ex))),
    placementLowRate: placements.length
      ? placements.filter((e) => e.placement.ey > 1.0).length / placements.length : NaN,
    placementHighRate: placements.length
      ? placements.filter((e) => e.placement.ey < -1.0).length / placements.length : NaN,
    placementSamples: placements.length,
    flickSamples: flicks.length,
    overshootRate: flicks.length ? flicks.filter((f) => f.overshoot).length / flicks.length : NaN,
    undershootRate: flicks.length ? flicks.filter((f) => f.undershoot).length / flicks.length : NaN,
    avgCorrections: mean(flicks.map((f) => f.corrections)),
    lagRate: lag + lead >= 5 ? lag / (lag + lead) : NaN,
    leadRate: lag + lead >= 5 ? lead / (lag + lead) : NaN,
    lowAimRate: shots.length ? lowShots.length / shots.length : NaN,
    bodyHitRate: hits.length ? bodyOrLeg.length / hits.length : NaN,
    stoppedShots: atStopped.length,
    movingTargetShots: atMoving.length,
    accStopped: hitRate(atStopped),
    accMoving: hitRate(atMoving),
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const ok = (x) => Number.isFinite(x);

/**
 * 통계 → 조언 목록. level: 'good' | 'warn' | 'bad'
 * ctx: { mode, edpi }
 */
export function buildAdvice(stats, ctx = {}) {
  const out = [];
  const add = (level, title, text) => out.push({ level, title, text });

  if (stats.shots === 0) {
    add('warn', '사격 기록 없음', '한 발도 쏘지 않았어요. 좌클릭으로 사격합니다.');
    return out;
  }

  // 반응 속도
  if (ok(stats.reactionMs) && stats.reactionSamples >= 3 && ctx.mode !== 'flick') {
    const r = stats.reactionMs;
    if (r < 220) add('good', `반응 속도 ${Math.round(r)}ms`, '매우 빠른 반응입니다. 이제 첫 발 정확도(헤드)를 유지하는 데 집중하세요.');
    else if (r < 300) add('good', `반응 속도 ${Math.round(r)}ms`, '평균 이상의 반응 속도입니다.');
    else add('warn', `반응 속도 ${Math.round(r)}ms`,
      '적이 보이고 첫 발까지 오래 걸립니다. 크로스헤어를 적이 나올 자리에 미리 두면 "조준 이동" 없이 반응만으로 쏠 수 있어 체감 반응 속도가 크게 줄어요.');
  }

  // 크로스헤어 배치 (높이)
  if (ok(stats.placementPitch) && stats.placementSamples >= 3) {
    if (stats.placementLowRate > 0.35) {
      add('bad', `크로스헤어가 낮음 (${pct(stats.placementLowRate)})`,
        `적이 나타날 때 크로스헤어가 머리보다 평균 ${stats.placementPitch.toFixed(1)}° 아래에 있었어요. 평지에서는 크로스헤어를 수평선(머리 높이)에 두고, 이동할 때도 바닥을 보지 마세요.`);
    } else if (stats.placementHighRate > 0.35) {
      add('warn', `크로스헤어가 높음 (${pct(stats.placementHighRate)})`,
        '머리보다 위에 두고 있는 경우가 많아요. 아래로 내리는 플릭은 오버슈팅이 잘 나니 머리 높이에 딱 맞추세요.');
    } else if (stats.placementPitch < 1.0) {
      add('good', '헤드 높이 유지 좋음', `적이 나타날 때 상하 오차 중앙값 ${stats.placementPitch.toFixed(2)}°. 크로스헤어 높이는 잘 유지하고 있어요.`);
    }
  }
  if (ok(stats.placementYaw) && stats.placementSamples >= 3 && (ctx.mode === 'hold' || ctx.mode === 'peek')) {
    if (stats.placementYaw > 8) {
      add('warn', `좌우 프리에임 오차 ${stats.placementYaw.toFixed(1)}°`,
        ctx.mode === 'hold'
          ? '앵글을 잡을 때 크로스헤어를 벽 모서리(적이 처음 보일 위치) 바로 옆에 붙이세요. 모서리에서 멀수록 적이 먼저 쏠 시간이 생깁니다.'
          : '피킹 전에 적이 있을 만한 자리로 크로스헤어를 먼저 옮기고(프리에임) 나가세요. 나가면서 조준을 옮기면 늦습니다.');
    } else {
      add('good', `프리에임 좋음 (좌우 ${stats.placementYaw.toFixed(1)}°)`, '적이 나타나는 위치를 잘 예측하고 있어요.');
    }
  }

  // 무빙 샷 / 카운터 스트레이프
  if (ok(stats.movingShotRate)) {
    if (stats.movingShotRate > 0.2) {
      add('bad', `이동 중 사격 ${pct(stats.movingShotRate)}`,
        '속도가 최고 속도의 30%를 넘은 상태에서 쏜 총알은 크게 튑니다. 반대 방향 키를 짧게 눌러(카운터 스트레이프) 멈춘 뒤 쏘세요. HUD의 속도 표시가 초록색일 때가 정확한 상태입니다.');
    } else if (stats.movingShotRate > 0.05) {
      add('warn', `이동 중 사격 ${pct(stats.movingShotRate)}`, '가끔 멈추기 전에 쏘고 있어요. 이동 키를 떼는 것과 클릭 타이밍을 분리해서 연습하세요.');
    } else if (ctx.mode === 'peek' || ctx.mode === 'strafe') {
      add('good', '멈춰서 쏘기 좋음', '거의 모든 사격이 정확도 구간(정지 상태)에서 나갔어요.');
    }
  }

  // 멈추는 방식 (가감속)
  if (ok(stats.stopMs) && stats.stopSamples >= 5) {
    if (stats.counterRate < 0.5 && stats.stopMs > 80) {
      add('warn', `멈춤 ${Math.round(stats.stopMs)}ms · 카운터 스트레이프 ${pct(stats.counterRate)}`,
        '대부분 이동 키를 떼기만 해서 멈추고 있어요. 발로란트는 키를 떼면 약 110ms 뒤에야 정확해지지만, 반대 키를 짧게 누르면 약 55ms 만에 정확해집니다. D를 떼는 순간 A를 톡 누르세요.');
    } else if (stats.stopMs <= 75) {
      add('good', `멈춤 ${Math.round(stats.stopMs)}ms`, `풀 속도에서 정확 구간까지 빠르게 멈추고 있어요 (카운터 스트레이프 ${pct(stats.counterRate)}).`);
    } else {
      add('warn', `멈춤 ${Math.round(stats.stopMs)}ms`, '반대 키는 누르지만 너무 늦게/짧게 누르고 있어요. 이동 키를 떼는 것과 반대 키를 누르는 것을 거의 동시에 하세요. HUD 그래프에서 초록선이 가로선 아래로 빨리 내려갈수록 좋습니다.');
    }
  }

  // 오버 / 언더슈팅 → 감도 관련
  if (ok(stats.overshootRate) && stats.flickSamples >= 5) {
    if (stats.overshootRate > 0.35 && stats.overshootRate > stats.undershootRate) {
      add('warn', `오버슈팅 ${pct(stats.overshootRate)}`,
        '타겟을 지나쳤다가 되돌아오는 경우가 많아요. 감도가 높거나 플릭 끝에서 손목을 세우지 못하는 것입니다.' +
        (ctx.edpi > 350 ? ` 현재 eDPI ${Math.round(ctx.edpi)}는 높은 편이니 5~10% 낮춰보세요.` : ' 플릭을 "빠르게 가서 멈춘다"보다 "타겟에서 멈춘다"에 집중하세요.'));
    } else if (stats.undershootRate > 0.45 && stats.undershootRate > stats.overshootRate) {
      add('warn', `언더슈팅 ${pct(stats.undershootRate)}`,
        '첫 움직임이 타겟에 못 미쳐 두 번에 나눠 조준하고 있어요. 감도가 낮거나 팔 움직임이 부족한 것입니다.' +
        (ctx.edpi < 220 ? ` 현재 eDPI ${Math.round(ctx.edpi)}는 낮은 편이니 5~10% 올려보세요.` : ' 플릭 거리를 과감하게 가져가세요.'));
    } else {
      add('good', '플릭 거리 감각 좋음', `오버슈팅 ${pct(stats.overshootRate)} / 언더슈팅 ${pct(stats.undershootRate)}. 감도와 플릭 거리가 잘 맞아요.`);
    }
    if (ok(stats.avgCorrections) && stats.avgCorrections > 1.5) {
      add('warn', `미세 보정 평균 ${stats.avgCorrections.toFixed(1)}회`, '플릭 후 여러 번 나눠서 조정하고 있어요. 한 번에 멈추는 정확도를 높이면 TTK가 줄어듭니다.');
    }
  }

  // 트래킹: 뒤처짐 / 앞서감
  if (ok(stats.lagRate)) {
    if (stats.lagRate > 0.65) {
      add('warn', `트래킹 뒤처짐 ${pct(stats.lagRate)}`, '빗나간 샷 대부분이 적이 움직이는 방향의 뒤쪽이에요. 적의 이동 방향으로 크로스헤어를 살짝 먼저 두고, 적이 방향을 바꿔 멈추는 순간(카운터 스트레이프)을 노려 쏘세요.');
    } else if (stats.leadRate > 0.65) {
      add('warn', `트래킹 앞서감 ${pct(stats.leadRate)}`, '적이 가는 방향보다 앞을 쏘고 있어요. ADAD는 방향 전환이 잦아서 예측을 너무 크게 하면 빗나갑니다. 적의 머리를 따라가는 데 집중하세요.');
    }
  }

  // 상대가 멈춘 순간을 노리는지 (스트레이프)
  if (ctx.mode === 'strafe' && stats.stoppedShots >= 5 && stats.movingTargetShots >= 5) {
    const gap = stats.accStopped - stats.accMoving;
    const share = stats.stoppedShots / (stats.stoppedShots + stats.movingTargetShots);
    if (gap > 0.15 && share < 0.5) {
      add('warn', `멈춘 봇 명중 ${pct(stats.accStopped)} vs 움직이는 봇 ${pct(stats.accMoving)}`,
        `상대가 카운터 스트레이프로 멈추는 순간 명중률이 훨씬 높은데, 샷의 ${pct(1 - share)}를 움직이는 중에 쐈어요. 상대가 멈추는 순간은 상대도 정확해지는 순간이니, 그 타이밍에 나도 멈춰서 먼저 쏘는 연습을 하세요.`);
    } else if (gap > 0.15) {
      add('good', '멈추는 타이밍 공략 좋음', `멈춘 봇 명중률 ${pct(stats.accStopped)}. 상대의 카운터 스트레이프 타이밍을 잘 노리고 있어요.`);
    }
  }
  if (ctx.mode === 'strafe' && ctx.duel && stats.kills + stats.deaths >= 5) {
    const lose = stats.deaths / (stats.kills + stats.deaths);
    if (lose > 0.35) {
      add('bad', `듀얼 패배율 ${pct(lose)}`,
        '봇이 멈춘 뒤 반응 속도 안에 먼저 맞히지 못했어요. 봇의 머리를 따라가다가(트래킹) 봇이 멈추는 순간 나도 반대 키로 카운터 스트레이프 → 바로 1~2발 탭. 계속 움직이면서 쏘면 탄이 튀어 이길 수 없어요.');
    } else {
      add('good', `듀얼 승률 ${pct(1 - lose)}`, '멈춰 쏘는 상대보다 먼저 맞히고 있어요. 적 반응 속도를 한 단계 올려보세요.');
    }
  }

  // 헤드 비율 / 낮은 조준
  if (ok(stats.headshotRate) && stats.hits >= 5) {
    if (stats.headshotRate < 0.35) {
      add('bad', `헤드샷 비율 ${pct(stats.headshotRate)}`, '맞힌 샷 대부분이 몸/다리입니다. 발로란트는 Vandal 헤드 1발 킬이라 몸샷 여러 발보다 헤드 1발이 빠릅니다. 크로스헤어 높이부터 교정하세요.');
    } else if (stats.headshotRate >= 0.6) {
      add('good', `헤드샷 비율 ${pct(stats.headshotRate)}`, '헤드 조준이 좋습니다.');
    }
  }

  // 연사
  if (ok(stats.sprayShotRate) && stats.sprayShotRate > 0.3) {
    add('warn', `연사 비율 ${pct(stats.sprayShotRate)}`, '4발째 이후 연사가 많아요. 중·원거리에서는 1~2발 탭/버스트 후 다시 조준하는 편이 정확합니다.');
  }

  // 피킹/앵글 결과
  if ((ctx.mode === 'peek' || ctx.mode === 'hold') && stats.engagements >= 5) {
    const dr = stats.deaths / stats.engagements;
    if (dr > 0.4) {
      add('bad', `교전 패배율 ${pct(dr)}`, ctx.mode === 'peek'
        ? '적이 먼저 쏘는 경우가 많아요. 피킹은 "프리에임 → 짧게 나가서 → 카운터 스트레이프 → 1발"의 리듬입니다. 너무 넓게 나가면 한꺼번에 여러 각도에 노출돼요.'
        : '적이 먼저 쏘는 경우가 많아요. 크로스헤어를 모서리에 붙이고, 적이 멈추는 순간이 아니라 보이는 순간 쏘세요.');
    }
  }

  // 감도 자체
  if (ok(ctx.edpi)) {
    if (ctx.edpi > 550) add('warn', `eDPI ${Math.round(ctx.edpi)}`, '발로란트 기준 매우 높은 감도입니다. 감도 찾기 모드로 낮은 구간을 테스트해보세요.');
    else if (ctx.edpi < 150) add('warn', `eDPI ${Math.round(ctx.edpi)}`, '매우 낮은 감도입니다. 근접 교전·뒤돌기가 느리다면 감도 찾기 모드로 높은 구간을 테스트해보세요.');
  }

  return out;
}
