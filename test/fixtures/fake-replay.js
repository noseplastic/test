// 테스트용 가짜 리플레이 (ValorantReplayParser export 형식)
const RAD = Math.PI / 180;
const ease = (a, b, t0, t1) => (t) => {
  if (t <= t0) return a;
  if (t >= t1) return b;
  const s = (t - t0) / (t1 - t0);
  return a + (b - a) * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5);
};
export const EYE = 64; // 캐릭터 위치(캡슐 중심) → 눈/머리 높이 (cm)
const ue = (deg) => ((deg % 360) + 360) % 360; // 언리얼 압축 각도는 0~360

/**
 * 가짜 리플레이 (ValorantReplayParser export 형식)
 * 나(PS 100)와 적(PS 200, 400), 팀원(PS 300). 적 200 을 플릭으로 헤드 3번 킬, 적 400 에게 등 돌린 채 사망.
 */
export function fakeReplay() {
  const events = [];
  const movement = [];
  const chars = { 100: 1001, 200: 2001, 300: 3001, 400: 4001 };
  const agents = { 100: 'Wushu', 200: 'Clay', 300: 'Thorne', 400: 'Vampire' };
  for (const [ps, ch] of Object.entries(chars)) {
    events.push({ type: 'actor_spawned', time_ms: 0, actor_net_guid: ch, archetype_path: `/Game/Characters/${agents[ps]}/${agents[ps]}_PC.${agents[ps]}_PC_C` });
    events.push({ type: 'export_group_received', time_ms: 0, actor_net_guid: Number(ps), export_group_path: '/Game/GameModes/Bomb/BombPlayerState.BombPlayerState_C', payload: { PossessedCharacter: ch, Subject: `puuid-${ps}` } });
  }
  const me = { x: 0, y: 0, z: 100 };
  const enemyAt = (t) => ({ x: 2000, y: 400 * Math.sin(t * 0.7), z: 100 }); // 20m 앞, 천천히 좌우
  const killer = { x: 0, y: 1500, z: 100 };
  const aimTo = (from, to) => ({
    yaw: Math.atan2(to.y - from.y, to.x - from.x) / RAD,
    pitch: Math.atan2(to.z - from.z, Math.hypot(to.x - from.x, to.y - from.y)) / RAD,
  });
  const eyeOf = (p) => ({ ...p, z: p.z + EYE });
  const targetYaw = (t) => aimTo(eyeOf(me), eyeOf(enemyAt(t))).yaw;
  // 교전 3번: 각각 -30° 에서 반응 → 오버슈팅 3° → 되돌아와 발사
  const fights = [2, 6, 10];
  const yawAt = (t) => {
    for (const f of fights) {
      if (t >= f - 0.5 && t < f + 1.5) {
        const aim = targetYaw(t);
        if (t < f) return aim - 30;
        if (t < f + 0.15) return ease(aim - 30, aim + 3, f, f + 0.15)(t);
        return ease(aim + 3, aim, f + 0.15, f + 0.3)(t);
      }
    }
    return t >= 13 ? -90 : targetYaw(t) - 30;
  };
  for (let ms = 0; ms <= 14000; ms += 1000 / 64) {
    const t = ms / 1000;
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 1001, position: me, yaw: ue(yawAt(t)), pitch: 0, velocity: { x: 0, y: 0, z: 0 } });
    const e = enemyAt(t);
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 2001, position: e, yaw: 180, pitch: 0, velocity: { x: 0, y: 280 * Math.cos(t * 0.7), z: 0 } });
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 3001, position: { x: -200, y: 100, z: 100 }, yaw: 0, pitch: 0 });
    movement.push({ type: 'remote_character_movement', time_ms: ms, shooter_character_net_guid: 4001, position: killer, yaw: 270, pitch: 0 });
  }
  for (const f of fights) {
    const t = f + 0.4;
    events.push({ type: 'valorant_shot_received', time_ms: t * 1000, shot: { firing_player_state: 100, location: eyeOf(me), rotation: { pitch: 0, yaw: ue(yawAt(t)), roll: 0 }, equippable: { name: 'Vandal', category: 'rifle' } } });
    // 실제 해석기는 데미지를 RPC 로 내보낸다 (actor = 피해자 캐릭터)
    events.push({ type: 'rpc_received', time_ms: t * 1000 + 30, actor_net_guid: 2001, function_export_path: '/Script/ShooterGame.DamageableComponent:MulticastNotifyDamage_Point', payload: { DamagerPlayerState: 100, RegionalDamage: 'regional_damage_headshot', DamagedBone: 'Head', DamageDealt: 160, DamageKilledTarget: true } });
  }
  // 사망은 킬 RPC 만 (데미지 기록 없이)
  events.push({ type: 'rpc_received', time_ms: 13500, actor_net_guid: 4001, function_export_path: '/Script/ShooterGame.ShooterCharacter:MulticastNotifyKilledEnemy', payload: { KillerCharacter: 4001, KilledCharacter: 1001 } });
  // 적 400 이 나에게 준 데미지 (팀 추정용)
  events.push({ type: 'rpc_received', time_ms: 13400, actor_net_guid: 1001, function_export_path: '/Script/ShooterGame.DamageableComponent:MulticastNotifyDamage_Point', payload: { DamagerPlayerState: 400, RegionalDamage: 'regional_damage_normal', DamageDealt: 40 } });
  const toText = (arr) => arr.map((o) => JSON.stringify(o)).join('\n');
  return { events: toText(events), movement: toText(movement) };
}

