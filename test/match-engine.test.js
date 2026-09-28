import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSession, worldToPixel, pixelToWorld, focalPx, deriveShots, alignKillsToShots, ViewTimeline, buildTracks,
} from '../js/match/engine.js';
import { analyzeFlick } from '../js/analysis.js';
import { CUES } from '../js/coach.js';
import { VALORANT } from '../js/config.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);
const META = { sens: 0.4, dpi: 800, width: 1920, height: 1080, weapon: 'vandal' };
const COUNTS_PER_DEG = 1 / (VALORANT.YAW_DEG_PER_COUNT * META.sens);

// 부드러운 이동 (min-jerk)
const ease = (a, b, t0, t1) => (t) => {
  if (t <= t0) return a;
  if (t >= t1) return b;
  const s = (t - t0) / (t1 - t0);
  return a + (b - a) * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5);
};
const chain = (...parts) => (t) => {
  for (const [until, fn] of parts) if (t <= until) return fn(t);
  return parts[parts.length - 1][1](t);
};

/**
 * 가짜 세션: yawFn/pitchFn(t s) = 내 시점, targets = [{ from, to, yaw(t), pitch(t), rDeg }]
 */
function makeSession({ yawFn, pitchFn = () => 0, duration, targets = [], keys = [], buttons = [], shots, events = [], resets }) {
  const mouse = [];
  let accX = 0, accY = 0;
  for (let ms = 1; ms <= duration * 1000; ms++) {
    const t = ms / 1000;
    const wantX = Math.round(yawFn(t) * COUNTS_PER_DEG);
    const wantY = Math.round(-pitchFn(t) * COUNTS_PER_DEG);
    if (wantX !== accX || wantY !== accY) {
      mouse.push([ms, wantX - accX, wantY - accY]);
      accX = wantX; accY = wantY;
    }
  }
  const frames = [];
  for (let ms = 0; ms <= duration * 1000; ms += 1000 / 60) {
    const t = ms / 1000;
    // 실제 화면은 반올림된 마우스 누적값으로 그려진다
    const view = { yaw: Math.round(yawFn(t) * COUNTS_PER_DEG) / COUNTS_PER_DEG, pitch: Math.round(pitchFn(t) * COUNTS_PER_DEG) / COUNTS_PER_DEG };
    const heads = [];
    for (const tg of targets) {
      if (t < tg.from || t > tg.to) continue;
      const px = worldToPixel({ yaw: tg.yaw(t), pitch: tg.pitch ? tg.pitch(t) : 0 }, view, META);
      if (!px || px.x < 0 || px.x > META.width || px.y < 0 || px.y > META.height) continue;
      heads.push({ x: px.x, y: px.y, r: focalPx(META.width) * Math.tan((tg.rDeg * Math.PI) / 180) });
    }
    frames.push({ t: ms, heads });
  }
  return { meta: META, mouse, keys, buttons, shots, frames, events, resets };
}

test('pixel ↔ world round trip at an angled view', () => {
  const view = { yaw: 37, pitch: -12 };
  const dir = { yaw: 51.5, pitch: -3.25 };
  const px = worldToPixel(dir, view, META);
  const back = pixelToWorld(px.x, px.y, view, META);
  close(back.yaw, dir.yaw, 1e-6);
  close(back.pitch, dir.pitch, 1e-6);
  // 화면 가장자리 = 수평 FOV 절반
  close(pixelToWorld(META.width, META.height / 2, { yaw: 0, pitch: 0 }, META).yaw, 51.5, 1e-9);
});

test('flick with overshoot: placement, reaction, overshoot and head hit', () => {
  const yawFn = chain([1.2, () => 0], [1.35, ease(0, 22, 1.2, 1.35)], [9, ease(22, 20, 1.35, 1.45)]);
  const s = makeSession({
    yawFn, duration: 1.6, shots: [1500], events: [{ t: 1520, type: 'kill' }],
    targets: [{ from: 1.0, to: 1.51, yaw: () => 20, rDeg: 0.5 }],
  });
  const { engagements, stats } = analyzeSession(s);
  assert.equal(engagements.length, 1);
  const e = engagements[0];
  close(e.placement.ex, 20, 0.05, 'placement');
  close((e.firstShotT - e.appearT) * 1000, 500, 17, 'reaction');
  assert.equal(e.result, 'kill');
  assert.equal(e.shots[0].part, 'head');
  const fl = analyzeFlick(e.path, e.radiusDeg);
  assert.equal(fl.overshoot, true);
  assert.equal(stats.kills, 1);
});

test('shot while still holding D is a moving shot, after counter-strafe it is not', () => {
  const base = {
    yawFn: ease(0, 10, 1.2, 1.35), duration: 1.6, shots: [1500],
    targets: [{ from: 1.0, to: 1.6, yaw: () => 10, rDeg: 0.5 }],
  };
  const held = analyzeSession(makeSession({ ...base, keys: [[500, 'KeyD', 1]] }));
  assert.equal(held.engagements[0].shots[0].moving, true);
  const stopped = analyzeSession(makeSession({ ...base, keys: [[500, 'KeyD', 1], [1300, 'KeyD', 0], [1300, 'KeyA', 1], [1350, 'KeyA', 0]] }));
  assert.equal(stopped.engagements[0].shots[0].moving, false);
  assert.equal(stopped.stats.stopSamples, 1);
  close(stopped.stats.stopMs, 55, 10, 'counter-strafe stop time');
});

test('tracking behind a strafing target is reported as lag', () => {
  const target = (t) => 10 + 40 * (t - 1.0);
  const yawFn = (t) => (t < 1.1 ? 0 : target(t) - 1.5);
  const shots = [];
  for (let t = 1500; t <= 2900; t += 200) shots.push(t);
  const s = makeSession({ yawFn: chain([1.1, () => 0], [9, yawFn]), duration: 3.0, shots, targets: [{ from: 1.0, to: 3.0, yaw: target, rDeg: 0.5 }] });
  const { stats } = analyzeSession(s);
  assert.ok(stats.lagRate > 0.9, `lagRate ${stats.lagRate}`);
  assert.equal(stats.hits, 0);
});

test('view resets split tracks', () => {
  const s = makeSession({
    yawFn: () => 0, duration: 2, resets: [1000],
    targets: [{ from: 0.5, to: 1.5, yaw: () => 5, rDeg: 0.5 }],
  });
  const view = new ViewTimeline(s);
  assert.equal(buildTracks(s, view).length, 2);
});

test('shots from clicks follow the fire rate and skip ability clicks', () => {
  const s = {
    meta: META,
    keys: [[900, 'KeyE', 1]],
    buttons: [[0, 0, 1], [300, 0, 0], [1000, 0, 1], [1010, 0, 0], [1500, 0, 1], [1510, 0, 0]],
  };
  const shots = deriveShots(s);
  assert.deepEqual(shots.map((t) => Math.round(t * 1000)), [0, 103, 205, 1500]);
});

test('match kill times are aligned to shots', () => {
  const kills = [12.4, 40.1, 75.8, 101.2];
  const shots = kills.flatMap((k) => [k - 0.25, k - 0.02]).concat([20, 55.5]);
  const shifted = kills.map((k) => k + 2.3);
  const res = alignKillsToShots(shots, shifted);
  close(res.offset, -2.3, 0.03);
  assert.equal(res.matched, 4);
});

test('all engine advice keys have overlay cues', () => {
  for (const key of ['aim-moving-shot', 'tremor', 'pitch-drift']) assert.ok(CUES[key], key);
});

test('capture delay is estimated from how enemy positions wobble with mouse movement', async () => {
  const { estimateFrameLag } = await import('../js/match/engine.js');
  // 여러 번 플릭하고 따라가는 세션 (적 2명)
  const yawFn = (t) => 15 * Math.sin(t * 2.1) + 8 * Math.sin(t * 5.3);
  const pitchFn = (t) => 2 * Math.sin(t * 3.7);
  const s = makeSession({
    yawFn, pitchFn, duration: 6,
    targets: [
      { from: 0, to: 6, yaw: (t) => 5 + 10 * Math.sin(t), rDeg: 0.4 },
      { from: 1, to: 5, yaw: (t) => -12 + 3 * t, pitch: () => 1, rDeg: 0.3 },
    ],
  });
  const lagMs = 40;
  const shifted = { ...s, frames: s.frames.map((f) => ({ ...f, t: f.t + lagMs })) };
  const est = estimateFrameLag(shifted, new ViewTimeline(shifted));
  close(est.lagMs, lagMs, 4, 'lag');
  const r = analyzeSession(shifted);
  close(r.stats.frameLagMs, lagMs, 4);
  close(r.tracks[0].start, 0, 0.02, 'track time is corrected by the lag');
});
