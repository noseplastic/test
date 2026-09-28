import { VALORANT } from './config.js';

// 발로란트식 가감속. v, wish 는 {x, z} 월드 좌표 속도 벡터(m/s).
// wish 는 입력 방향 * 목표 속도 (입력이 없으면 0 벡터).
// - 입력 없음: STOP_TIME 비율로 감속
// - 입력 방향과 반대로 움직이는 중(카운터 스트레이프): 감속 + 가속이 합쳐져 빠르게 멈춘다
// - 입력 방향으로: ACCEL_TIME 비율로 가속
export function stepVelocity(v, wish, maxSpeed, dt) {
  const accel = maxSpeed / VALORANT.ACCEL_TIME;
  const decel = maxSpeed / VALORANT.STOP_TIME;
  const wishSpeed = Math.hypot(wish.x, wish.z);

  if (wishSpeed < 1e-6) {
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1e-6) return { x: 0, z: 0 };
    const k = Math.max(0, speed - decel * dt) / speed;
    return { x: v.x * k, z: v.z * k };
  }

  const ux = wish.x / wishSpeed;
  const uz = wish.z / wishSpeed;
  // 입력 방향 성분(par)과 수직 성분(perp)으로 분리
  let par = v.x * ux + v.z * uz;
  let px = v.x - par * ux;
  let pz = v.z - par * uz;

  // 수직 성분은 키를 뗀 것처럼 감속
  const perp = Math.hypot(px, pz);
  if (perp > 1e-6) {
    const k = Math.max(0, perp - decel * dt) / perp;
    px *= k;
    pz *= k;
  }

  if (par < 0) {
    // 반대로 미끄러지는 중: 감속 + 가속
    let remaining = dt;
    const brake = decel + accel;
    const tStop = -par / brake;
    if (tStop >= remaining) {
      par += brake * remaining;
      remaining = 0;
    } else {
      par = 0;
      remaining -= tStop;
    }
    par = Math.min(wishSpeed, par + accel * remaining);
  } else if (par < wishSpeed) {
    par = Math.min(wishSpeed, par + accel * dt);
  } else {
    // 달리다 걷기로 전환 등 목표보다 빠른 경우
    par = Math.max(wishSpeed, par - decel * dt);
  }

  return { x: px + par * ux, z: pz + par * uz };
}

export function maxSpeedFor(weapon, walking) {
  const run = VALORANT.BASE_RUN_SPEED * weapon.moveMult;
  return walking ? run * VALORANT.WALK_MULT : run;
}

// 현재 속도에서 첫 발 정확도가 적용되는지 (최고 달리기 속도의 30% 이하)
export function isAccurate(speed, weapon) {
  return speed <= maxSpeedFor(weapon, false) * VALORANT.ACCURATE_SPEED_RATIO + 1e-9;
}

// 속도·연사 상태에 따른 탄 퍼짐 (deg)
export function spreadFor(weapon, speed, sprayIndex) {
  const runSpeed = maxSpeedFor(weapon, false);
  const threshold = runSpeed * VALORANT.ACCURATE_SPEED_RATIO;
  let spread = weapon.spread;
  if (speed > threshold) {
    spread += weapon.movePenalty * Math.min(1, (speed - threshold) / (runSpeed - threshold));
  }
  spread += Math.min(weapon.sprayMax, weapon.sprayGrow * Math.max(0, sprayIndex));
  return spread;
}

/**
 * 플레이어가 풀 속도에서 정확도 구간까지 멈추는 데 걸린 시간 측정.
 * 매 프레임 update() 를 부르면 멈춤이 끝난 프레임에 { ms, counter } 를 돌려준다.
 * counter: 감속 중 이동 방향과 반대 키를 눌렀는지 (카운터 스트레이프)
 */
export class StopTracker {
  constructor() {
    this.lastFullT = NaN;
    this.counter = false;
    this.prevT = NaN;
    this.prevSpeed = NaN;
  }

  // 벽에 부딪혀 멈춘 경우 등은 측정하지 않는다
  cancel() {
    this.lastFullT = NaN;
  }

  update(t, speed, runSpeed, threshold, opposing) {
    const prevT = this.prevT, prevSpeed = this.prevSpeed;
    this.prevT = t;
    this.prevSpeed = speed;
    if (speed >= runSpeed * 0.98) {
      this.lastFullT = t;
      this.counter = false;
      return null;
    }
    if (!Number.isFinite(this.lastFullT)) return null;
    if (opposing) this.counter = true;
    if (speed <= threshold) {
      // 프레임 사이에서 정확히 기준선을 지난 시점을 보간
      let tCross = t;
      if (Number.isFinite(prevSpeed) && prevSpeed > threshold && prevSpeed > speed) {
        tCross = prevT + ((prevSpeed - threshold) / (prevSpeed - speed)) * (t - prevT);
      }
      const ev = { ms: (tCross - this.lastFullT) * 1000, counter: this.counter };
      this.lastFullT = NaN;
      return ev;
    }
    return null;
  }
}

// 카운터 스트레이프로 멈추는 동안 이동하는 거리 (봇이 정확히 멈출 위치 계산용)
export function counterStrafeDistance(speed, maxSpeed) {
  const brake = maxSpeed / VALORANT.STOP_TIME + maxSpeed / VALORANT.ACCEL_TIME;
  return (speed * speed) / (2 * brake);
}
