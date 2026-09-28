import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayModel, analyzeReplay, parseNdjson, inferEnemies, viewConvention, PlayerTrack } from '../js/match/replay.js';
import { flickClass } from '../js/match/engine.js';
import { fakeReplay, EYE } from './fixtures/fake-replay.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);
test('replay model links players, characters and agents', () => {
  const r = fakeReplay();
  const model = buildReplayModel(parseNdjson(r.events), parseNdjson(r.movement));
  assert.equal(model.players.size, 4);
  assert.equal(model.players.get(100).agent, 'Jett');
  assert.equal(model.shots.length, 3);
  assert.equal(model.damage.filter((d) => d.region === 'head').length, 3);
  assert.equal(model.damage[0].victimPs, 200);
  // 팀원 300 은 아무와도 교전하지 않았지만 적 추정에서 제외되어야 함
  assert.deepEqual(inferEnemies(model, 100).sort(), [200, 400]);
});

test('replay fights: kill with overshoot, placement at reaction start, head hits from damage', () => {
  const r = fakeReplay();
  const model = buildReplayModel(parseNdjson(r.events), parseNdjson(r.movement));
  const res = analyzeReplay(model, 100);
  const d = res.diagnostics;
  assert.equal(d.calibration.conv.ys, 1);
  assert.equal(d.calibration.conv.ps, 1);
  close(d.calibration.headZ, EYE, 4, 'head height');
  close(d.eyeZ, EYE, 0.01, 'eye height');
  close(d.moveIntervalMs, 16, 1);
  const kills = res.engagements.filter((e) => e.result === 'kill');
  assert.equal(kills.length, 3);
  for (const e of kills) {
    close(Math.abs(e.placement.ex), 30, 3, 'placement at reaction start');
    assert.equal(e.shots[0].part, 'head');
    assert.equal(flickClass(e), 'over');
    close(Math.hypot(e.shots[0].ex, e.shots[0].ey), 0, 0.3, 'shot error on head');
  }
  assert.equal(res.stats.headshotRate, 1);
  assert.equal(res.stats.overshootRate, 1);
});

test('death while facing away is reported with the aim error to the killer', () => {
  const r = fakeReplay();
  const model = buildReplayModel(parseNdjson(r.events), parseNdjson(r.movement));
  const res = analyzeReplay(model, 100);
  const death = res.engagements.find((e) => e.result === 'death');
  assert.ok(death.noShot);
  // 킬러는 왼쪽(+y, yaw 90°), 나는 -90° 를 보고 있음 → 180° 차이
  close(Math.abs(death.deathErr.ex), 180, 1);
  assert.equal(res.stats.noShotDeaths, 1);
});

test('view convention detects a flipped pitch sign in movement data', () => {
  const samples = [];
  const shots = [];
  for (let i = 0; i < 20; i++) {
    samples.push({ t: i, x: 0, y: 0, z: 0, yaw: i * 7, pitch: -(i - 10) });
    shots.push({ t: i, yaw: i * 7, pitch: i - 10 });
  }
  const track = Object.assign(Object.create(PlayerTrack.prototype), { samples });
  const vc = viewConvention(track, shots);
  assert.equal(vc.pitchSign, -1);
  assert.equal(vc.yawSign, 1);
});

test('streaming reader keeps only the needed events across chunk boundaries', async () => {
  const { readCompact } = await import('../js/match/replay.js');
  const r = fakeReplay();
  const noise = JSON.stringify({ type: 'rpc_received', time_ms: 1, class_path: 'x' });
  const text = `${noise}\n${r.events}\n${noise}\n`;
  // 7글자씩 잘라서 줄이 조각 사이에 걸치게
  async function* chunks() { for (let i = 0; i < text.length; i += 7) yield text.slice(i, i + 7); }
  const out = await readCompact(chunks());
  assert.equal(out.length, parseNdjson(r.events).length);
  assert.ok(out.every((o) => o.type !== 'rpc_received'));
});
