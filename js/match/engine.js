// 실전 경기 에임 분석 엔진. DOM/three.js 의존성 없음.
//
// 입력 기록(마우스·키·클릭) + 녹화 영상에서 찾은 적 머리 위치(프레임별) + 킬/데스 이벤트를 받아
// 교전을 재구성하고, analysis.js 의 summarize/buildAdvice 로 분석한다.
//
// Session 형식 (시간은 모두 기록 시작부터 ms):
// {
//   meta: { sens, vertMult = 1, hfov = 103, width, height, weapon = 'vandal', frameLagMs = 0,
//           instantAbilityKeys = [] },
//   mouse: [[t, dx, dy]],          // 원시 입력 카운트 (dx + 오른쪽, dy + 아래)
//   keys: [[t, code, down]],       // KeyboardEvent.code (KeyW, ShiftLeft, Space, Digit1, KeyE ...)
//   buttons: [[t, button, down]],  // 0 = 좌클릭
//   shots: [t] | undefined,        // 실제 발사 시각을 알면 사용 (HUD 탄약 숫자, 트레이너). 없으면 클릭으로 추정
//   frames: [{ t, heads: [{ x, y, r }], mouseIdx? }], // 적 머리 중심·반지름 (px). 적이 없는 프레임도 넣는다
//                                  // mouseIdx: 이 프레임까지 반영된 마우스 이벤트 수 (트레이너처럼 정확히 알 때)
//   events: [{ t, type: 'kill' | 'death' }],
//   resets: [t],                   // 입력 없이 시점이 바뀐 순간 (라운드 시작, 부활, 순간이동)
//   sensChanges: [[t, sens]],      // (선택) 기록 중 감도가 바뀐 경우
// }
//
// 각도 규칙: yaw + 오른쪽, pitch + 위. 오차 ex/ey = 타겟 방향 - 크로스헤어 방향 (ey + 이면 타겟이 위).

import { VALORANT, WEAPONS, HITBOX } from '../config.js';
import { stepVelocity, maxSpeedFor, isAccurate, spreadFor, StopTracker } from '../movement.js';
import { summarize, summarizeStops, buildAdvice, analyzeFlick, median, mean } from '../analysis.js';
import { edpi } from '../sens.js';

const RAD = Math.PI / 180;
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// 정렬된 배열에서 x 이하인 마지막 인덱스 (-1 이면 없음)
function lastIndexAtOrBefore(arr, x, key = (v) => v) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ─── 화면 픽셀 ↔ 각도 ───

// 수평 FOV 기준 초점 거리 (px). 발로란트는 수평 FOV 고정이라 가로 해상도로 정해진다.
export function focalPx(width, hfov = VALORANT.HFOV_DEG) {
  return (width / 2) / Math.tan((hfov / 2) * RAD);
}

// 화면 픽셀 → 월드 방향 (yaw, pitch deg). view: 그 프레임의 시점
export function pixelToWorld(x, y, view, meta) {
  const f = focalPx(meta.width, meta.hfov);
  const r = (x - meta.width / 2) / f;
  const u = (meta.height / 2 - y) / f;
  const p = view.pitch * RAD, yw = view.yaw * RAD;
  const vx = r;
  const vy = u * Math.cos(p) + Math.sin(p);
  const vz = -u * Math.sin(p) + Math.cos(p);
  const wx = vx * Math.cos(yw) + vz * Math.sin(yw);
  const wz = -vx * Math.sin(yw) + vz * Math.cos(yw);
  return { yaw: Math.atan2(wx, wz) / RAD, pitch: Math.atan2(vy, Math.hypot(wx, wz)) / RAD };
}

// 월드 방향 → 화면 픽셀 (테스트·검증용). 화면 뒤쪽이면 null
export function worldToPixel(dir, view, meta) {
  const dy = dir.pitch * RAD, dyaw = dir.yaw * RAD;
  let wx = Math.cos(dy) * Math.sin(dyaw), wy = Math.sin(dy), wz = Math.cos(dy) * Math.cos(dyaw);
  const yw = view.yaw * RAD, p = view.pitch * RAD;
  // yaw 되돌리기
  const vx = wx * Math.cos(yw) - wz * Math.sin(yw);
  const vz0 = wx * Math.sin(yw) + wz * Math.cos(yw);
  // pitch 되돌리기
  const cz = vz0 * Math.cos(p) + wy * Math.sin(p);
  const cy = -vz0 * Math.sin(p) + wy * Math.cos(p);
  if (cz <= 1e-6) return null;
  const f = focalPx(meta.width, meta.hfov);
  return { x: meta.width / 2 + (vx / cz) * f, y: meta.height / 2 - (cy / cz) * f };
}

// ─── 시점 (마우스 적분) ───
export class ViewTimeline {
  constructor(session) {
    const m = session.meta;
    const vert = m.vertMult ?? 1;
    // 감도가 중간에 바뀐 경우 (트레이너 감도 찾기): sensChanges [[t, sens]]
    const changes = [...(session.sensChanges || [])].sort((a, b) => a[0] - b[0]);
    let ci = 0;
    let k = VALORANT.YAW_DEG_PER_COUNT * m.sens;
    this.t = [0];
    this.yaw = [0];
    this.pitch = [0];
    let yaw = 0, pitch = 0;
    for (const [tMs, dx, dy] of session.mouse || []) {
      while (ci < changes.length && changes[ci][0] <= tMs) k = VALORANT.YAW_DEG_PER_COUNT * changes[ci++][1];
      yaw += dx * k;
      pitch = Math.max(-89, Math.min(89, pitch - dy * k * vert));
      this.t.push(tMs / 1000);
      this.yaw.push(yaw);
      this.pitch.push(pitch);
    }
    this.resets = (session.resets || []).map((x) => x / 1000).sort((a, b) => a - b);
  }

  at(t) {
    const i = Math.max(0, lastIndexAtOrBefore(this.t, t));
    return { yaw: this.yaw[i], pitch: this.pitch[i] };
  }

  // 마우스 이벤트 n개가 반영된 시점
  afterEvents(n) {
    const i = Math.max(0, Math.min(this.t.length - 1, n));
    return { yaw: this.yaw[i], pitch: this.pitch[i] };
  }

  // 시점이 입력 없이 바뀐 구간 번호
  segment(t) {
    return lastIndexAtOrBefore(this.resets, t) + 1;
  }

  // 크로스헤어 각속도 (deg/s)
  speed(t, win = 0.012) {
    const a = this.at(t - win), b = this.at(t + win);
    return Math.hypot(b.yaw - a.yaw, b.pitch - a.pitch) / (2 * win);
  }
}

// ─── 이동 (키 입력 + 가감속 모델) ───
const MOVE_KEYS = { KeyW: [0, 1], KeyS: [0, -1], KeyD: [1, 0], KeyA: [-1, 0] };
const AIR_TIME = 0.55; // 점프 체공 시간 (s)

export function simulateMovement(session, view, dt = 0.002) {
  const weapon = WEAPONS[session.meta.weapon] || WEAPONS.vandal;
  const keys = [...(session.keys || [])].sort((a, b) => a[0] - b[0]);
  const end = Math.max(
    0,
    ...keys.map((k) => k[0] / 1000),
    ...(session.mouse || []).slice(-1).map((m) => m[0] / 1000),
    ...(session.frames || []).slice(-1).map((f) => f.t / 1000),
  ) + 0.5;
  const down = new Set();
  const jumps = [];
  const speed = [];
  const stops = [];
  const tracker = new StopTracker();
  const runSpeed = maxSpeedFor(weapon, false);
  const threshold = runSpeed * VALORANT.ACCURATE_SPEED_RATIO;
  let v = { x: 0, z: 0 };
  let ki = 0;
  let seg = 0;
  for (let t = 0; t <= end; t += dt) {
    while (ki < keys.length && keys[ki][0] / 1000 <= t) {
      const [kt, code, isDown] = keys[ki++];
      if (isDown) {
        if (code === 'Space' && !down.has('Space')) jumps.push(kt / 1000);
        down.add(code);
      } else down.delete(code);
    }
    const s = view.segment(t);
    if (s !== seg) { seg = s; v = { x: 0, z: 0 }; tracker.cancel(); }
    let ix = 0, iz = 0;
    for (const [code, [dx, dz]] of Object.entries(MOVE_KEYS)) if (down.has(code)) { ix += dx; iz += dz; }
    const walking = down.has('ShiftLeft') || down.has('ShiftRight');
    const max = maxSpeedFor(weapon, walking);
    const yw = view.at(t).yaw * RAD;
    let wx = Math.cos(yw) * ix + Math.sin(yw) * iz;
    let wz = -Math.sin(yw) * ix + Math.cos(yw) * iz;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx = (wx / wl) * max; wz = (wz / wl) * max; }
    const opposing = wx * v.x + wz * v.z < 0;
    v = stepVelocity(v, { x: wx, z: wz }, max, dt);
    const sp = Math.hypot(v.x, v.z);
    speed.push(sp);
    const stop = tracker.update(t, sp, runSpeed, threshold, opposing);
    if (stop) stops.push(stop);
  }
  return {
    dt,
    weapon,
    stops,
    speedAt: (t) => speed[Math.max(0, Math.min(speed.length - 1, Math.round(t / dt)))] ?? 0,
    airborne: (t) => jumps.some((j) => t >= j && t <= j + AIR_TIME),
  };
}

// ─── 발사 시각 ───
const ABILITY_KEYS = ['KeyQ', 'KeyE', 'KeyC', 'KeyX'];
const WEAPON_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

// 클릭 + 연사 속도로 발사 시각 추정. 스킬을 꺼낸 상태(Q/E/C/X)의 클릭은 제외한다.
export function deriveShots(session) {
  if (Array.isArray(session.shots)) return session.shots.map((t) => t / 1000).sort((a, b) => a - b);
  const weapon = WEAPONS[session.meta.weapon] || WEAPONS.vandal;
  const period = 1 / weapon.fireRate;
  const instant = new Set(session.meta.instantAbilityKeys || []);
  const evs = [
    ...(session.keys || []).filter((k) => k[2]).map((k) => ({ t: k[0] / 1000, key: k[1] })),
    ...(session.buttons || []).filter((b) => b[1] === 0).map((b) => ({ t: b[0] / 1000, btn: b[2] })),
  ].sort((a, b) => a.t - b.t);
  const shots = [];
  let armed = false;
  let heldFrom = NaN;
  let nextReady = -Infinity;
  const flush = (until) => {
    if (!Number.isFinite(heldFrom)) return;
    let t = Math.max(heldFrom, nextReady);
    while (t <= until + 1e-9) {
      shots.push(t);
      nextReady = t + period;
      t = nextReady;
    }
  };
  for (const e of evs) {
    if (e.key) {
      if (ABILITY_KEYS.includes(e.key) && !instant.has(e.key)) armed = true;
      else if (WEAPON_KEYS.includes(e.key)) armed = false;
      continue;
    }
    if (e.btn) {
      if (armed) { armed = false; continue; } // 스킬 사용
      heldFrom = e.t;
    } else {
      flush(e.t);
      heldFrom = NaN;
    }
  }
  return shots;
}

// ─── 적 추적 (프레임별 머리 위치 → 트랙) ───
export function buildTracks(session, view, opts = {}) {
  const meta = { hfov: VALORANT.HFOV_DEG, ...session.meta };
  const lag = (opts.frameLagMs ?? meta.frameLagMs ?? 0) / 1000;
  const gap = opts.maxGap ?? 0.25;
  const gate = opts.gateDeg ?? 3;
  const minFrames = opts.minFrames ?? 3;
  const f = focalPx(meta.width, meta.hfov);
  const tracks = [];
  let active = [];
  const frames = [...(session.frames || [])].sort((a, b) => a.t - b.t);
  for (const fr of frames) {
    const t = fr.t / 1000;
    const vt = t - lag;
    const v = Number.isInteger(fr.mouseIdx) && opts.frameLagMs === undefined ? view.afterEvents(fr.mouseIdx) : view.at(vt);
    const seg = view.segment(vt);
    active = active.filter((tr) => tr.seg === seg && vt - tr.samples[tr.samples.length - 1].t <= gap);
    // 화면에 찍힌 순간이 아니라 입력 기준 시각(지연 보정)으로 기록
    const obs = (fr.heads || []).map((h) => ({
      t: vt, ...pixelToWorld(h.x, h.y, v, meta), rDeg: Math.atan((h.r || 1) / f) / RAD,
    }));
    // 가까운 쌍부터 연결 (greedy)
    const pairs = [];
    obs.forEach((o, oi) => active.forEach((tr, ti) => {
      const last = tr.samples[tr.samples.length - 1];
      const dt = vt - last.t;
      const py = last.yaw + tr.vy * dt, pp = last.pitch + tr.vp * dt;
      const d = Math.hypot(wrapDeg(o.yaw - py), o.pitch - pp);
      if (d <= gate + 0.5 * Math.hypot(tr.vy, tr.vp) * dt) pairs.push({ d, oi, ti });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const usedO = new Set(), usedT = new Set();
    for (const p of pairs) {
      if (usedO.has(p.oi) || usedT.has(p.ti)) continue;
      usedO.add(p.oi); usedT.add(p.ti);
      const tr = active[p.ti];
      const o = obs[p.oi];
      const last = tr.samples[tr.samples.length - 1];
      const dt = Math.max(1e-3, o.t - last.t);
      tr.vy = tr.vy * 0.5 + (wrapDeg(o.yaw - last.yaw) / dt) * 0.5;
      tr.vp = tr.vp * 0.5 + ((o.pitch - last.pitch) / dt) * 0.5;
      tr.samples.push(o);
    }
    obs.forEach((o, oi) => {
      if (usedO.has(oi)) return;
      const tr = { id: tracks.length, seg, samples: [o], vy: 0, vp: 0 };
      tracks.push(tr);
      active.push(tr);
    });
  }
  return tracks.filter((tr) => tr.samples.length >= minFrames).map((tr) => new Track(tr));
}

export class Track {
  constructor({ id, seg, samples }) {
    this.id = id;
    this.seg = seg;
    this.samples = samples;
    this.start = samples[0].t;
    this.end = samples[samples.length - 1].t;
    this.rDeg = median(samples.map((s) => s.rDeg));
  }

  visible(t, slack = 0.05) {
    return t >= this.start - 1e-9 && t <= this.end + slack;
  }

  // 월드 방향 (프레임 사이 선형 보간, 범위 밖은 끝값)
  dirAt(t) {
    const s = this.samples;
    const i = lastIndexAtOrBefore(s, t, (x) => x.t);
    if (i < 0) return { yaw: s[0].yaw, pitch: s[0].pitch };
    if (i >= s.length - 1) return { yaw: s[s.length - 1].yaw, pitch: s[s.length - 1].pitch };
    const a = s[i], b = s[i + 1];
    const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return { yaw: a.yaw + wrapDeg(b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k };
  }

  // 좌우 각속도 (deg/s, + 오른쪽)
  yawRate(t, win = 0.05) {
    const a = this.dirAt(Math.max(this.start, t - win));
    const b = this.dirAt(Math.min(this.end, t + win));
    const span = Math.min(this.end, t + win) - Math.max(this.start, t - win);
    return span > 1e-3 ? wrapDeg(b.yaw - a.yaw) / span : 0;
  }
}

// ─── 녹화 지연 추정 ───
// 영상 프레임은 입력보다 늦게 화면에 나온다 (렌더링 + 캡처 지연). 지연을 잘못 잡으면 마우스를 움직일 때
// 적의 월드 방향이 같이 흔들린다. 트랙 안에서 적 방향의 "마우스와 같이 움직인 흔들림"이 가장 작은 지연을 찾는다.
export function estimateFrameLag(session, view, { maxMs = 120, stepMs = 2 } = {}) {
  let best = null;
  for (let lag = 0; lag <= maxMs; lag += stepMs) {
    // 넓은 게이트로 연결해야 잘못된 지연에서 트랙이 끊겨 흔들림이 숨는 일이 없다
    const tracks = buildTracks(session, view, { frameLagMs: lag, gateDeg: 30 });
    let cost = 0, n = 0;
    for (const tr of tracks) {
      const sm = tr.samples;
      for (let i = 2; i < sm.length; i++) {
        // 2차 차분 = 가속도. 적은 부드럽게 움직이므로 작아야 한다
        const a = wrapDeg(sm[i].yaw - sm[i - 1].yaw) - wrapDeg(sm[i - 1].yaw - sm[i - 2].yaw);
        const b = (sm[i].pitch - sm[i - 1].pitch) - (sm[i - 1].pitch - sm[i - 2].pitch);
        cost += Math.hypot(a, b);
        n++;
      }
    }
    if (n < 20) continue;
    const score = cost / n;
    if (!best || score < best.score) best = { lagMs: lag, score, samples: n };
  }
  return best;
}

// ─── 샷 명중 부위 추정 (크로스헤어 기준, 탄퍼짐 제외) ───
// 히트박스 비율을 머리 반지름 단위로 환산한다.
const HEAD_R = HITBOX.head.w / 2;
const BODY = {
  halfW: HITBOX.body.w / 2 / HEAD_R,
  top: (HITBOX.head.y - (HITBOX.body.y + HITBOX.body.h / 2)) / HEAD_R,
  bottom: (HITBOX.head.y - (HITBOX.body.y - HITBOX.body.h / 2)) / HEAD_R,
};
const LEG = { halfW: (HITBOX.leg.w + HITBOX.leg.gap / 2) / HEAD_R, bottom: HITBOX.head.y / HEAD_R };

export function estimatePart(ex, ey, rDeg) {
  const x = Math.abs(ex) / rDeg;
  const below = ey / rDeg; // + 이면 크로스헤어가 머리보다 아래
  if (Math.hypot(ex, ey) <= rDeg) return 'head';
  if (x <= BODY.halfW && below >= Math.max(0, BODY.top - 0.5) && below <= BODY.bottom) return 'body';
  if (x <= LEG.halfW && below > BODY.bottom && below <= LEG.bottom) return 'leg';
  return null;
}

// 탄퍼짐을 고려한 부위별 명중 확률. 크로스헤어 오차(ex, ey)에서 반지름 spreadDeg 원 안에 고르게 퍼진다고 본다.
const DISK = (() => {
  const pts = [[0, 0]];
  for (let ring = 1; ring <= 4; ring++) {
    const n = ring * 8;
    const rr = Math.sqrt(ring / 4);
    for (let i = 0; i < n; i++) pts.push([rr * Math.cos((2 * Math.PI * i) / n), rr * Math.sin((2 * Math.PI * i) / n)]);
  }
  return pts;
})();

export function hitChance(ex, ey, rDeg, spreadDeg) {
  const out = { head: 0, body: 0, leg: 0 };
  for (const [dx, dy] of DISK) {
    const part = estimatePart(ex - dx * spreadDeg, ey - dy * spreadDeg, rDeg);
    if (part) out[part]++;
  }
  for (const k of Object.keys(out)) out[k] /= DISK.length;
  out.hit = out.head + out.body + out.leg;
  return out;
}

// ─── 교전 재구성 ───
export function buildEngagements(session, ctx) {
  const { view, move, tracks, shots } = ctx;
  const events = (session.events || []).map((e) => ({ ...e, t: e.t / 1000 })).sort((a, b) => a.t - b.t);
  const errAt = (tr, t) => {
    const d = tr.dirAt(t), v = view.at(t);
    return { ex: wrapDeg(d.yaw - v.yaw), ey: d.pitch - v.pitch };
  };

  // 각 샷 → 그 순간 보이는 적 중 크로스헤어에 가장 가까운 트랙
  const shotOwner = new Map();
  for (const t of shots) {
    let best = null, bestD = Infinity;
    for (const tr of tracks) {
      if (!tr.visible(t, 0.3) || tr.seg !== view.segment(t)) continue;
      const e = errAt(tr, t);
      const d = Math.hypot(e.ex, e.ey);
      if (d < bestD) { bestD = d; best = tr; }
    }
    if (best && bestD < 25) {
      if (!shotOwner.has(best.id)) shotOwner.set(best.id, []);
      shotOwner.get(best.id).push(t);
    }
  }

  // 킬/데스 이벤트 → 트랙
  const result = new Map();
  for (const ev of events) {
    let best = null, bestScore = Infinity;
    for (const tr of tracks) {
      if (result.has(tr.id)) continue;
      if (ev.type === 'kill') {
        // 킬: 마지막으로 보인 직후 + 직전에 쏜 샷이 있어야 함
        const owned = shotOwner.get(tr.id) || [];
        const lastShot = owned.filter((s) => s <= ev.t + 0.05).pop();
        if (lastShot === undefined || ev.t - lastShot > 0.6) continue;
        const score = Math.abs(ev.t - tr.end);
        if (ev.t >= tr.start && ev.t <= tr.end + 0.6 && score < bestScore) { bestScore = score; best = tr; }
      } else if (tr.visible(ev.t, 0.5)) {
        // 데스: 그 순간 보이던 적 중 크로스헤어에 가장 가까운 적으로 가정
        const e = errAt(tr, ev.t);
        const score = Math.hypot(e.ex, e.ey);
        if (score < bestScore) { bestScore = score; best = tr; }
      }
    }
    if (best) result.set(best.id, ev);
  }

  const engagements = [];
  for (const tr of tracks) {
    const owned = shotOwner.get(tr.id) || [];
    const ev = result.get(tr.id);
    if (!owned.length && !ev && tr.end - tr.start < 0.15) continue;
    const appearT = tr.start;
    const firstShotT = owned.length ? owned[0] : NaN;
    const pathEnd = Number.isFinite(firstShotT) ? firstShotT : Math.min(tr.end, appearT + 1.5);
    const path = [];
    for (let t = appearT; t < pathEnd; t += 0.005) path.push({ t, ...errAt(tr, t) });
    path.push({ t: pathEnd, ...errAt(tr, pathEnd) });

    let spray = 0, prev = -Infinity;
    const engShots = owned.map((t) => {
      spray = t - prev < 0.3 ? spray + 1 : 0;
      prev = t;
      const e = errAt(tr, t);
      const speed = move.speedAt(t);
      const targetVel = tr.yawRate(t);
      const before = errAt(tr, t - 0.03);
      const chance = hitChance(e.ex, e.ey, tr.rDeg, spreadFor(move.weapon, speed, spray) + (move.airborne(t) ? 3 : 0));
      return {
        t,
        part: estimatePart(e.ex, e.ey, tr.rDeg),
        chance,
        moving: !isAccurate(speed, move.weapon) || move.airborne(t),
        speed,
        ex: e.ex,
        ey: e.ey,
        targetVel,
        spray,
        targetStopped: Math.abs(targetVel) / tr.rDeg < 13,
        // 크로스헤어가 타겟에 대해 아직 움직이는 중 (deg/s)
        relSpeed: Math.hypot(e.ex - before.ex, e.ey - before.ey) / 0.03,
      };
    });

    engagements.push({
      mode: 'match',
      trackId: tr.id,
      appearT,
      firstShotT,
      endT: ev ? ev.t : tr.end,
      result: ev ? ev.type : 'escape',
      placement: { ex: path[0].ex, ey: path[0].ey },
      path,
      radiusDeg: tr.rDeg,
      shots: engShots,
      bait: false,
    });
  }
  return engagements.sort((a, b) => a.appearT - b.appearT);
}

// ─── 입력만으로 보는 습관 ───

// 각을 잡고 있을 때(이동·사격·큰 마우스 이동 없음) 크로스헤어 미세 떨림 (deg, 250ms 창의 RMS)
export function holdJitter(session, view, move, shots, win = 0.25) {
  const end = view.t[view.t.length - 1];
  const out = [];
  for (let t0 = 0; t0 + win <= end; t0 += win) {
    if (view.segment(t0) !== view.segment(t0 + win)) continue;
    if (shots.some((s) => s > t0 - 0.3 && s < t0 + win + 0.3)) continue;
    if (move.speedAt(t0) > 0.2 || move.speedAt(t0 + win) > 0.2) continue;
    const pts = [];
    for (let t = t0; t <= t0 + win; t += 0.01) pts.push(view.at(t));
    const a = pts[0], b = pts[pts.length - 1];
    const net = Math.hypot(b.yaw - a.yaw, b.pitch - a.pitch);
    if (net > 1.0) continue; // 의도적인 조준 이동
    // 시작→끝 직선에서 벗어난 정도
    let ss = 0, moved = false;
    pts.forEach((p, i) => {
      const k = i / (pts.length - 1);
      const dy = p.yaw - (a.yaw + (b.yaw - a.yaw) * k);
      const dp = p.pitch - (a.pitch + (b.pitch - a.pitch) * k);
      ss += dy * dy + dp * dp;
      if (i > 0 && (p.yaw !== pts[i - 1].yaw || p.pitch !== pts[i - 1].pitch)) moved = true;
    });
    if (!moved) continue; // 마우스를 아예 안 만진 구간은 제외
    out.push(Math.sqrt(ss / pts.length));
  }
  return { jitterDeg: median(out), jitterSamples: out.length };
}

// 달리는 중(교전·사격 없음) 시야가 위아래로 흘러가는 속도 (deg/s, - 이면 아래로)
export function movingPitchDrift(view, move, tracks, shots) {
  const end = view.t[view.t.length - 1];
  const step = 0.05;
  let total = 0, time = 0;
  for (let t = 0; t + step <= end; t += step) {
    if (view.segment(t) !== view.segment(t + step)) continue;
    if (move.speedAt(t) < move.weapon.moveMult * VALORANT.BASE_RUN_SPEED * 0.5) continue;
    if (tracks.some((tr) => tr.visible(t, 0.5) && t >= tr.start - 0.5)) continue;
    if (shots.some((s) => Math.abs(s - t) < 0.5)) continue;
    total += view.at(t + step).pitch - view.at(t).pitch;
    time += step;
  }
  return { pitchDriftDegPerSec: time >= 2 ? total / time : NaN, movingSeconds: time };
}

// ─── 탄퍼짐과 무관한 핵심 지표 (트레이너 정답과 같은 정의로 비교할 수 있다) ───

// 오버/언더슈팅 판정: 'over' | 'under' | 'clean' | null(플릭 아님)
export function flickClass(e) {
  const f = analyzeFlick(e.path, e.radiusDeg || 0.8);
  if (f.skip) return null;
  return f.overshoot ? 'over' : f.undershoot ? 'under' : 'clean';
}

// 움직이는 적을 쏠 때 크로스헤어가 적 이동 방향의 뒤에 있었던 비율 (명중 여부와 무관)
export function trackingBias(engagements) {
  let lag = 0, lead = 0;
  for (const s of engagements.flatMap((e) => e.shots || [])) {
    if (!Number.isFinite(s.targetVel) || Math.abs(s.targetVel) < 3) continue;
    if (!Number.isFinite(s.ex) || Math.abs(s.ex) < 0.1) continue;
    if (Math.sign(s.ex) === Math.sign(s.targetVel)) lag++;
    else lead++;
  }
  return lag + lead >= 5 ? { lagRate: lag / (lag + lead), leadRate: lead / (lag + lead) } : { lagRate: NaN, leadRate: NaN };
}

// 이 속도(deg/s) 이상으로 크로스헤어가 타겟에 대해 움직이는 중에 쏘면 "조준 이동 중 사격"
const AIM_MOVING_DEG_S = 15;

// ─── 전체 분석 ───
export function analyzeSession(session) {
  const meta = { hfov: VALORANT.HFOV_DEG, vertMult: 1, weapon: 'vandal', ...session.meta };
  const s = { ...session, meta };
  const view = new ViewTimeline(s);
  const move = simulateMovement(s, view);
  const shots = deriveShots(s);
  // 프레임별 마우스 반영 수를 모르고 지연도 주어지지 않았으면 추정
  const exact = s.frames?.length && s.frames.every((f) => Number.isInteger(f.mouseIdx));
  let lag = null;
  if (!exact && !Number.isFinite(meta.frameLagMs)) lag = estimateFrameLag(s, view);
  const tracks = buildTracks(s, view, lag ? { frameLagMs: lag.lagMs } : {});
  const engagements = buildEngagements(s, { view, move, tracks, shots });

  const stats = { ...summarize(engagements), ...summarizeStops(move.stops) };
  stats.allShots = shots.length;
  const engShots = engagements.flatMap((e) => e.shots);
  // 명중은 영상으로 확인할 수 없어 탄퍼짐 모델로 기대값을 쓴다 (매치 데이터가 있으면 그 값으로 대체)
  const pHit = engShots.reduce((a, x) => a + x.chance.hit, 0);
  const pHead = engShots.reduce((a, x) => a + x.chance.head, 0);
  stats.accuracy = engShots.length ? pHit / engShots.length : NaN;
  stats.headshotRate = pHit > 0.5 ? pHead / pHit : NaN;
  Object.assign(stats, trackingBias(engagements));
  stats.aimMovingShotRate = engShots.length
    ? engShots.filter((x) => x.relSpeed > AIM_MOVING_DEG_S).length / engShots.length : NaN;
  Object.assign(stats, holdJitter(s, view, move, shots), movingPitchDrift(view, move, tracks, shots));
  stats.tracks = tracks.length;
  stats.frameLagMs = lag ? lag.lagMs : exact ? 0 : meta.frameLagMs;

  const ctx = { mode: 'match', edpi: meta.dpi ? edpi(meta.sens, meta.dpi) : NaN };
  const advice = [...buildAdvice(stats, ctx), ...matchAdvice(stats)];
  return { stats, advice, engagements, tracks, shots };
}

const pct = (x) => `${Math.round(x * 100)}%`;


// 입력 기록에서만 나오는 조언
export function matchAdvice(stats) {
  const out = [];
  const add = (level, title, text, key) => out.push({ level, title, text, key });
  if (Number.isFinite(stats.aimMovingShotRate) && stats.shots >= 8) {
    if (stats.aimMovingShotRate > 0.4) {
      add('warn', `조준 이동 중 사격 ${pct(stats.aimMovingShotRate)}`,
        '크로스헤어가 적에게 아직 끌려가는 도중에 쏜 샷이 많아요. 플릭 끝에서 한 박자 멈춘 뒤(또는 머리에 닿는 순간) 쏘세요. 이동 중 에임을 멈추는 연습은 플릭 모드가 좋습니다.', 'aim-moving-shot');
    } else if (stats.aimMovingShotRate < 0.15) {
      add('good', '크로스헤어를 멈추고 쏨', `조준 이동 중 사격 ${pct(stats.aimMovingShotRate)}. 조준을 멈춘 뒤 쏘고 있어요.`, 'aim-moving-shot');
    }
  }
  if (Number.isFinite(stats.jitterDeg) && stats.jitterSamples >= 20) {
    if (stats.jitterDeg > 0.12) {
      add('warn', `각 잡을 때 떨림 ${stats.jitterDeg.toFixed(2)}°`,
        '가만히 각을 잡고 있을 때 크로스헤어가 자잘하게 흔들려요. 20m 거리 머리 반지름이 약 0.36°라서 원거리 헤드에 영향을 줍니다. 손목·손가락 힘을 빼거나, 감도가 높다면 조금 낮춰보세요.', 'tremor');
    } else {
      add('good', `각 잡기 안정적 (떨림 ${stats.jitterDeg.toFixed(2)}°)`, '각을 잡고 있을 때 크로스헤어가 안정적이에요.', 'tremor');
    }
  }
  if (Number.isFinite(stats.pitchDriftDegPerSec)) {
    if (stats.pitchDriftDegPerSec < -0.4) {
      add('warn', `이동 중 시야가 내려감 (초당 ${Math.abs(stats.pitchDriftDegPerSec).toFixed(1)}°)`,
        '달리는 동안 크로스헤어가 점점 바닥으로 내려가요. 3초만 걸어도 머리 높이에서 1°가 넘게 벗어납니다. 이동할 때 크로스헤어를 벽의 머리 높이 선에 붙이고 다니세요.', 'pitch-drift');
    } else if (stats.pitchDriftDegPerSec > 0.4) {
      add('warn', `이동 중 시야가 올라감 (초당 ${stats.pitchDriftDegPerSec.toFixed(1)}°)`,
        '달리는 동안 크로스헤어가 점점 위로 올라가요. 머리 높이에 고정하세요.', 'pitch-drift');
    }
  }
  return out;
}

// ─── 매치 데이터 시간 맞추기 ───
// 킬 직전에는 반드시 클릭(샷)이 있다는 점을 이용해, 매치 데이터 킬 시각에 더할 오프셋(s)을 찾는다.
export function alignKillsToShots(shots, kills, { range = 15, step = 0.01, window = 0.6 } = {}) {
  if (!kills.length || !shots.length) return null;
  const sorted = [...shots].sort((a, b) => a - b);
  const gapBefore = (t) => {
    const i = lastIndexAtOrBefore(sorted, t);
    return i < 0 ? Infinity : t - sorted[i];
  };
  let best = null;
  for (let off = -range; off <= range + 1e-9; off += step) {
    let matched = 0, cost = 0;
    for (const k of kills) {
      const g = gapBefore(k + off);
      if (g <= window) { matched++; cost += g; }
    }
    const score = matched - cost / (window * kills.length + 1);
    if (!best || score > best.score) best = { offset: Math.round(off * 1000) / 1000, matched, total: kills.length, score };
  }
  return best;
}

// 두 통계(실제 vs 추정) 비교 → 검증 표
export const COMPARE_KEYS = [
  ['reactionMs', '반응 속도 (ms)', 1],
  ['placementPitch', '크로스헤어 상하 오차 (°)', 1],
  ['placementYaw', '크로스헤어 좌우 오차 (°)', 1],
  ['overshootRate', '오버슈팅', 100],
  ['undershootRate', '언더슈팅', 100],
  ['movingShotRate', '이동 중 사격', 100],
  ['lagRate', '트래킹 뒤처짐', 100],
  ['headshotRate', '헤드샷 비율', 100],
  ['accuracy', '정확도', 100],
  ['kills', '킬', 1],
  ['deaths', '데스', 1],
];

export function compareStats(truth, est) {
  return COMPARE_KEYS.map(([key, label, scale]) => {
    const a = truth[key], b = est[key];
    const ok = Number.isFinite(a) && Number.isFinite(b);
    return { key, label, scale, truth: a, est: b, diff: ok ? (b - a) * scale : NaN };
  });
}
