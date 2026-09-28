import { counterStrafeDistance } from './movement.js';

// 시드 고정 난수 (재현 가능한 테스트용)
export function makeRng(seed = Date.now()) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const rand = (rng, a, b) => a + (b - a) * rng();

// 카운터 스트레이프로 멈추기: 거의 멈출 때까지 반대 키, 그 다음 키를 뗀다
// (반대 키를 계속 누르고 있으면 반대 방향으로 다시 가속하므로)
export function brake(vx) {
  return Math.abs(vx) > 0.5 ? -Math.sign(vx) : 0;
}

// 좌우 스트레이프(ADAD) 봇. 반환값은 x축 입력 방향 (-1, 0, 1).
export const STRAFE_PROFILES = {
  easy: { name: '느린 무빙', minHold: 0.45, maxHold: 1.1 },
  normal: { name: '일반 ADAD', minHold: 0.22, maxHold: 0.7 },
  hard: { name: '빠른 지글', minHold: 0.12, maxHold: 0.4 },
};

// 방향을 바꿀 때마다 카운터 스트레이프로 멈춰 설 확률
export const STRAFE_STOPS = {
  none: { name: '멈춤 없음', chance: 0 },
  rare: { name: '가끔 멈춤', chance: 0.15 },
  normal: { name: '보통', chance: 0.3 },
  often: { name: '자주 멈춤', chance: 0.5 },
};

// 이만큼 연속으로 스트레이프하면 한 번은 반드시 멈춘다 (멈춤 없음 제외)
const MAX_STRAFES_WITHOUT_STOP = 5;

export class StrafeAI {
  constructor(rng, { minX, maxX, profile = STRAFE_PROFILES.normal, stopChance = STRAFE_STOPS.normal.chance }) {
    this.rng = rng;
    this.minX = minX;
    this.maxX = maxX;
    this.profile = profile;
    this.stopChance = stopChance;
    this.dir = rng() < 0.5 ? -1 : 1;
    this.stopping = false;
    this.strafesSinceStop = 0;
    this.timer = rand(rng, profile.minHold, profile.maxHold);
  }

  update(dt, x, vx) {
    this.timer -= dt;
    if (this.timer <= 0) {
      const p = this.profile;
      const forced = this.stopChance > 0 && this.strafesSinceStop >= MAX_STRAFES_WITHOUT_STOP;
      if (!this.stopping && (forced || this.rng() < this.stopChance)) {
        // 카운터 스트레이프로 멈춰 서서 쏘는 타이밍. 짧게 멈췄다 다시 움직이는 페이크도 섞는다.
        this.stopping = true;
        this.strafesSinceStop = 0;
        this.timer = rand(this.rng, 0.2, 0.75);
      } else {
        this.stopping = false;
        this.strafesSinceStop++;
        this.dir = this.rng() < 0.7 ? -this.dir : this.dir;
        this.timer = rand(this.rng, p.minHold, p.maxHold);
      }
    }
    if (x <= this.minX) { this.dir = 1; this.stopping = false; }
    if (x >= this.maxX) { this.dir = -1; this.stopping = false; }

    if (this.stopping) {
      return brake(vx);
    }
    return this.dir;
  }

  get isStopped() {
    return this.stopping;
  }
}

/**
 * 스크립트 기반 x축 이동 (피킹 봇).
 * steps: [{ type: 'wait', t } | { type: 'move', x, stop } | { type: 'hold', t }]
 * move.stop = true 이면 목표 지점에 카운터 스트레이프로 정확히 멈춘다.
 */
export class ScriptedMover {
  constructor(steps) {
    this.steps = steps;
    this.index = 0;
    this.elapsed = 0;
    this.braking = false;
    this.runDir = null;
  }

  get current() {
    return this.steps[this.index] || null;
  }

  get done() {
    return this.index >= this.steps.length;
  }

  next() {
    this.index++;
    this.elapsed = 0;
    this.braking = false;
    this.runDir = null;
  }

  // 반환값: x축 입력 방향 (-1, 0, 1)
  update(dt, x, vx, maxSpeed) {
    const step = this.current;
    if (!step) return brake(vx);
    this.elapsed += dt;

    if (step.type === 'wait' || step.type === 'hold') {
      if (this.elapsed >= step.t) this.next();
      return brake(vx);
    }

    // move
    const dir = Math.sign(step.x - x);
    if (!step.stop) {
      // 멈추지 않고 달려서 통과
      if (this.runDir == null) this.runDir = dir || 1;
      const runDir = this.runDir;
      if ((step.x - x) * runDir <= 0) this.next();
      return runDir;
    }

    if (this.braking) {
      if (Math.abs(vx) <= 0.05) {
        this.next();
        return 0;
      }
      return brake(vx);
    }
    const remaining = Math.abs(step.x - x);
    const speed = Math.abs(vx);
    const movingToward = Math.sign(vx) === dir;
    if (remaining <= 0.02 || (movingToward && remaining <= counterStrafeDistance(speed, maxSpeed))) {
      this.braking = true;
      return brake(vx);
    }
    return dir;
  }
}

export const PEEK_TYPES = {
  wide: '와이드 스윙',
  tight: '타이트 피크',
  shoulder: '숄더 피크 → 피크',
  cross: '달려서 가로지르기',
};

/**
 * 피킹 스크립트 생성.
 * coverX: 엄폐 뒤 시작 x, edgeX: 보이기 시작하는 x, side: 나오는 방향(+1/-1)
 * farX: 가로지르기 시 도착 x
 */
export function buildPeekScript(rng, { type, coverX, edgeX, side, farX }) {
  const out = (d) => edgeX + side * d;
  const steps = [{ type: 'wait', t: rand(rng, 0.8, 3.2) }];
  if (type === 'wide') {
    steps.push({ type: 'move', x: out(rand(rng, 1.6, 2.8)), stop: true });
    steps.push({ type: 'hold', t: 30 });
  } else if (type === 'tight') {
    steps.push({ type: 'move', x: out(rand(rng, 0.35, 0.7)), stop: true });
    steps.push({ type: 'hold', t: 30 });
  } else if (type === 'shoulder') {
    const baits = rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < baits; i++) {
      steps.push({ type: 'move', x: out(rand(rng, 0.05, 0.3)), stop: true });
      steps.push({ type: 'move', x: coverX, stop: true });
      steps.push({ type: 'wait', t: rand(rng, 0.3, 1.0) });
    }
    steps.push({ type: 'move', x: out(rand(rng, 0.8, 2.2)), stop: true });
    steps.push({ type: 'hold', t: 30 });
  } else if (type === 'cross') {
    steps.push({ type: 'move', x: farX, stop: false });
  }
  return steps;
}
