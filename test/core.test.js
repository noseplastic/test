import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cm360, edpi, convertSens, sensFromCm360, recommendSensitivity } from '../js/sens.js';
import { stepVelocity, maxSpeedFor, isAccurate, spreadFor, counterStrafeDistance } from '../js/movement.js';
import { analyzeFlick, summarize, buildAdvice, median } from '../js/analysis.js';
import { StrafeAI, ScriptedMover, buildPeekScript, makeRng } from '../js/bots.js';
import { WEAPONS, VALORANT } from '../js/config.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);

test('cm/360 matches the Valorant formula (0.3 @ 800 DPI = 54.43cm)', () => {
  close(cm360(0.3, 800), 54.43, 0.01);
  assert.equal(edpi(0.35, 800), 280);
  close(sensFromCm360(cm360(0.42, 1600), 1600), 0.42, 1e-9);
});

test('CS2 → Valorant conversion divides by 3.1818', () => {
  close(convertSens(1.0, 'cs2'), 0.3143, 0.0001);
  close(convertSens(5.0, 'overwatch'), 0.4714, 0.0001);
});

test('run speeds follow weapon multipliers', () => {
  close(maxSpeedFor(WEAPONS.vandal, false), 5.4, 1e-9);
  close(maxSpeedFor(WEAPONS.ghost, false), 5.7375, 1e-9);
  close(maxSpeedFor(WEAPONS.vandal, true), 5.4 * VALORANT.WALK_MULT, 1e-9);
});

function simulate(v0, wish, max, seconds, dt = 1 / 240) {
  let v = v0;
  const out = [];
  for (let t = 0; t < seconds; t += dt) {
    v = stepVelocity(v, wish, max, dt);
    out.push({ t: t + dt, v });
  }
  return out;
}

test('acceleration reaches full speed in ACCEL_TIME', () => {
  const max = 5.4;
  const trace = simulate({ x: 0, z: 0 }, { x: max, z: 0 }, max, 0.4);
  const reached = trace.find((s) => s.v.x >= max - 1e-9);
  close(reached.t, VALORANT.ACCEL_TIME, 0.01);
});

test('counter-strafe reaches accuracy faster than releasing the key', () => {
  const max = maxSpeedFor(WEAPONS.vandal, false);
  const accurate = (v) => isAccurate(Math.abs(v.x), WEAPONS.vandal);
  const counter = simulate({ x: max, z: 0 }, { x: -max, z: 0 }, max, 0.3).find((s) => accurate(s.v));
  const release = simulate({ x: max, z: 0 }, { x: 0, z: 0 }, max, 0.3).find((s) => accurate(s.v));
  close(counter.t, 0.055, 0.01, 'counter-strafe');
  close(release.t, 0.098, 0.01, 'release');
  assert.ok(counter.t < release.t);
});

test('spread grows when moving and when spraying', () => {
  const w = WEAPONS.vandal;
  assert.equal(spreadFor(w, 0, 0), w.spread);
  assert.equal(spreadFor(w, 1.0, 0), w.spread); // 30% 이하
  assert.ok(spreadFor(w, 5.4, 0) > w.spread + 4);
  assert.ok(spreadFor(w, 0, 5) > spreadFor(w, 0, 1));
});

test('ScriptedMover stops exactly at the target with a counter-strafe', () => {
  const max = 5.4;
  const mover = new ScriptedMover([{ type: 'move', x: 3, stop: true }, { type: 'hold', t: 1 }]);
  let x = 0, vx = 0;
  const dt = 1 / 240;
  for (let i = 0; i < 240 && mover.index === 0; i++) {
    const dir = mover.update(dt, x, vx, max);
    vx = stepVelocity({ x: vx, z: 0 }, { x: dir * max, z: 0 }, max, dt).x;
    x += vx * dt;
  }
  assert.equal(mover.current.type, 'hold');
  close(x, 3, 0.1, 'stop position');
  assert.ok(Math.abs(vx) <= 0.06);
  assert.ok(counterStrafeDistance(max, max) < 0.3);
});

test('ScriptedMover run-through step keeps running past the target', () => {
  const max = 5.4;
  const mover = new ScriptedMover([{ type: 'move', x: 2, stop: false }]);
  let x = -2, vx = 0;
  const dt = 1 / 120;
  let steps = 0;
  while (!mover.done && steps++ < 600) {
    const dir = mover.update(dt, x, vx, max);
    vx = stepVelocity({ x: vx, z: 0 }, { x: dir * max, z: 0 }, max, dt).x;
    x += vx * dt;
  }
  assert.ok(mover.done);
  assert.ok(x >= 2 && vx > 4, `x=${x} vx=${vx}`);
});

test('peek scripts: every type ends in hold or a run-through', () => {
  const rng = makeRng(42);
  for (const type of ['wide', 'tight', 'shoulder', 'cross']) {
    const steps = buildPeekScript(rng, { type, coverX: -3, edgeX: -1.8, side: 1, farX: 4 });
    const last = steps[steps.length - 1];
    if (type === 'cross') assert.equal(last.stop, false);
    else assert.equal(last.type, 'hold');
    for (const s of steps) if (s.type === 'move' && s.stop && type !== 'shoulder') assert.ok(s.x > -1.8);
  }
});

test('StrafeAI stays inside its lane', () => {
  const rng = makeRng(7);
  const ai = new StrafeAI(rng, { minX: -6, maxX: 6 });
  let x = 0, vx = 0;
  const dt = 1 / 120;
  let minX = 0, maxX = 0, changes = 0, last = 0;
  for (let i = 0; i < 120 * 60; i++) {
    const dir = ai.update(dt, x, vx);
    if (dir !== last && dir !== 0) changes++;
    last = dir || last;
    vx = stepVelocity({ x: vx, z: 0 }, { x: dir * 5.4, z: 0 }, 5.4, dt).x;
    x += vx * dt;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  assert.ok(minX > -7 && maxX < 7, `${minX}..${maxX}`);
  assert.ok(changes > 60, `direction changes ${changes}`);
});

// 합성 플릭 궤적: 20° 거리를 이동해 end 지점에서 멈춤
function flickPath(endAlong, { correct = true } = {}) {
  const path = [];
  const start = 20;
  const dt = 1 / 144;
  let t = 0;
  // 0.15초 동안 부드럽게 이동
  for (let i = 0; i <= 22; i++) {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / 22);
    path.push({ t, ex: start + (endAlong - start) * k, ey: 0 });
    t += dt;
  }
  for (let i = 0; i < 15; i++) { path.push({ t, ex: endAlong, ey: 0 }); t += dt; }
  if (correct) {
    for (let i = 0; i <= 10; i++) {
      const k = 0.5 - 0.5 * Math.cos((Math.PI * i) / 10);
      path.push({ t, ex: endAlong * (1 - k), ey: 0 });
      t += dt;
    }
  }
  return path;
}

test('analyzeFlick detects overshoot, undershoot and clean flicks', () => {
  const r = 0.7;
  const over = analyzeFlick(flickPath(-3), r);
  assert.equal(over.overshoot, true);
  close(over.overshootDeg, 3, 0.01);
  const under = analyzeFlick(flickPath(4), r);
  assert.equal(under.undershoot, true);
  assert.equal(under.overshoot, false);
  assert.ok(under.corrections >= 1);
  const clean = analyzeFlick(flickPath(0.2, { correct: false }), r);
  assert.equal(clean.overshoot, false);
  assert.equal(clean.undershoot, false);
  assert.equal(analyzeFlick([{ t: 0, ex: 0.1, ey: 0 }, { t: 0.1, ex: 0, ey: 0 }], r).skip, true);
});

test('summarize + advice flag moving shots, low crosshair and lagging', () => {
  const engagements = [];
  for (let i = 0; i < 10; i++) {
    engagements.push({
      mode: 'peek', appearT: i, firstShotT: i + 0.35, endT: i + 0.5, result: i < 5 ? 'kill' : 'death',
      placement: { ex: 12, ey: 3 }, path: [], radiusDeg: 0.7,
      shots: [
        { t: i + 0.35, part: null, moving: true, speed: 4, ex: 1.2, ey: 0.5, targetVel: 10, spray: 0 },
        { t: i + 0.45, part: 'body', moving: false, speed: 0, ex: 0.1, ey: 0.4, targetVel: 10, spray: 1 },
      ],
    });
  }
  const s = summarize(engagements);
  assert.equal(s.kills, 5);
  assert.equal(s.deaths, 5);
  close(s.reactionMs, 350, 1e-6);
  assert.equal(s.movingShotRate, 0.5);
  assert.equal(s.placementLowRate, 1);
  assert.equal(s.lagRate, 1);
  const titles = buildAdvice(s, { mode: 'peek', edpi: 280 }).map((a) => a.title).join('\n');
  assert.match(titles, /이동 중 사격/);
  assert.match(titles, /크로스헤어가 낮음/);
  assert.match(titles, /좌우 프리에임/);
  assert.match(titles, /교전 패배율/);
});

test('median handles even/odd/empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('recommendSensitivity picks the best block and nudges for overshoot', () => {
  const mk = (m, time, over = 0.2, under = 0.2) => ({
    multiplier: m, avgTime: time, hits: 12, shots: 14, targets: 12, overshootRate: over, undershootRate: under,
  });
  const rec = recommendSensitivity(0.4, 800, [mk(0.8, 0.9), mk(0.9, 0.7), mk(1.0, 0.65), mk(1.1, 0.72), mk(1.25, 0.95)]);
  assert.ok(rec.multiplier > 0.9 && rec.multiplier < 1.1, `multiplier ${rec.multiplier}`);
  close(rec.cm360, cm360(rec.sens, 800), 1e-9);

  const overshooter = recommendSensitivity(0.4, 800, [mk(0.8, 0.7, 0.6, 0.1), mk(1.0, 0.7, 0.6, 0.1), mk(1.25, 0.7, 0.6, 0.1)]);
  assert.ok(overshooter.sens < 0.4 * 0.81);
  assert.equal(recommendSensitivity(0.4, 800, []), null);
});
