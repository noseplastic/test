import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TriangleBVH, segmentHitsSphere, onScreen, loadMap, checkMapFit } from '../js/match/visibility.js';
import { buildReplayModel, analyzeReplay } from '../js/match/replay.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);

// x = 1000 평면의 벽: y ∈ [y0, y1], z ∈ [0, 500]
const wall = (x, y0, y1, z0 = 0, z1 = 500) => [
  x, y0, z0, x, y1, z0, x, y1, z1,
  x, y0, z0, x, y1, z1, x, y0, z1,
];
// 바닥: z = 0, 넓게
const floor = (s = 5000) => [-s, -s, 0, s, -s, 0, s, s, 0, -s, -s, 0, s, s, 0, -s, s, 0];

test('BVH blocks segments through a wall and not around it', () => {
  const tris = [];
  // 많은 삼각형으로 BVH 분할을 실제로 타게
  for (let i = 0; i < 50; i++) tris.push(...wall(1000, -3000 + i * 58, -3000 + (i + 1) * 58));
  tris.push(...floor());
  const bvh = new TriangleBVH(tris);
  const eye = { x: 0, y: 0, z: 164 };
  assert.equal(bvh.blocked(eye, { x: 2000, y: -1000, z: 164 }), true);
  assert.equal(bvh.blocked(eye, { x: 2000, y: 500, z: 164 }), false);
  assert.equal(bvh.blocked(eye, { x: 500, y: -1000, z: 164 }), false, 'target in front of the wall');
  assert.equal(checkMapFit(bvh, [{ x: 10, y: 10, z: 100 }, { x: 100, y: 50, z: 100 }]), 1);
});

test('smoke sphere and screen bounds', () => {
  assert.equal(segmentHitsSphere({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 10, z: 0 }, 20), true);
  assert.equal(segmentHitsSphere({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 30, z: 0 }, 20), false);
  assert.equal(onScreen(51, 0), true);
  assert.equal(onScreen(52, 0), false);
  assert.equal(onScreen(0, 35), true);
  assert.equal(onScreen(0, 36), false);
  assert.equal(onScreen(120, 0), false);
  assert.throws(() => loadMap({ triangles: [1, 2] }));
});

test('replay with a map: appear time from the wall, reaction time and placement at that moment', () => {
  const EYE = 64;
  const RAD = Math.PI / 180;
  const events = [
    { type: 'actor_spawned', time_ms: 0, actor_net_guid: 1001, archetype_path: '/Game/Characters/Wushu/Wushu_PC.Wushu_PC_C' },
    { type: 'actor_spawned', time_ms: 0, actor_net_guid: 2001, archetype_path: '/Game/Characters/Clay/Clay_PC.Clay_PC_C' },
    { type: 'export_group_received', time_ms: 0, actor_net_guid: 100, export_group_path: 'BombPlayerState', payload: { PossessedCharacter: 1001 } },
    { type: 'export_group_received', time_ms: 0, actor_net_guid: 200, export_group_path: 'BombPlayerState', payload: { PossessedCharacter: 2001 } },
  ];
  const me = { x: 0, y: 0, z: 100 };
  const enemyAt = (t) => ({ x: 2000, y: -600 + 300 * t, z: 100 }); // 3 m/s 로 벽 뒤에서 나옴
  const aim = (t) => Math.atan2(enemyAt(t).y, enemyAt(t).x) / RAD;
  const yawAt = (t) => (t < 1.6 ? 0 : t < 1.7 ? aim(1.7) * ((t - 1.6) / 0.1) : aim(t));
  const movement = [];
  for (let ms = 0; ms <= 3000; ms += 1000 / 64) {
    const t = ms / 1000;
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 1001, position: me, yaw: (yawAt(t) + 360) % 360, pitch: 0 });
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 2001, position: enemyAt(t), yaw: 180, pitch: 0 });
  }
  events.push({ type: 'valorant_shot_received', time_ms: 1800, shot: { firing_player_state: 100, location: { ...me, z: me.z + EYE }, rotation: { pitch: 0, yaw: (yawAt(1.8) + 360) % 360, roll: 0 } } });
  events.push({ type: 'export_group_received', time_ms: 1830, actor_net_guid: 2001, export_group_path: 'MulticastNotifyDamage_Point', payload: { DamagerPlayerState: 100, Character: 2001, RegionalDamage: 'regional_damage_headshot', DamageKilledTarget: true } });

  const model = buildReplayModel(events, movement);
  const map = loadMap({ name: 'test', triangles: [...wall(1000, -3000, -100), ...floor()] });
  const res = analyzeReplay(model, 100, { map });
  const e = res.engagements[0];
  // 시선이 벽(x=1000)을 y_e/2 에서 지남 → y_e > -200 이면 보임 → t > 1.333s
  assert.equal(e.appearKnown, true);
  close(e.appearT, 1.333, 0.02, 'appear');
  close((e.firstShotT - e.appearT) * 1000, 467, 20, 'reaction');
  close(Math.abs(e.placement.ex), Math.abs(Math.atan2(-200, 2000) / RAD), 0.3, 'placement at appear');
  assert.equal(res.stats.reactionSamples, 1);

  // 맵 없이는 보인 순간을 모른다
  const noMap = analyzeReplay(model, 100);
  assert.equal(noMap.engagements[0].appearKnown, false);
  assert.ok(Number.isNaN(noMap.stats.reactionMs));

  // 연막이 시선을 막고 있으면 연막이 걷힌 뒤 보인 것으로
  model.smokes = [{ t0: 0, t1: 1.5, x: 500, y: 0, z: 164, r: 300 }];
  const smoked = analyzeReplay(model, 100, { map });
  close(smoked.engagements[0].appearT, 1.5, 0.02, 'appear after smoke');
});
