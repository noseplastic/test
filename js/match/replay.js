// 발로란트 리플레이(.vrf) → 에임 분석.
//
// .vrf 해석은 ValorantReplayParser(MIT, https://github.com/michel-giehl/ValorantReplayParser)의
// `CliReader export <replay.vrf> -o <폴더>` 가 만든 events.ndjson / movement.ndjson 을 읽는다.
// 리플레이에는 모든 플레이어의 위치·시야 방향, 모든 발사(위치·조준 방향), 명중 부위가 들어 있어
// 영상 인식 없이 "적이 어디 있었고 내 크로스헤어가 어디 있었는지"를 계산할 수 있다.
//
// 좌표: 언리얼 기준 cm, Z 위쪽, yaw 는 Z 축 회전(deg). 각도 부호 규칙은 실제 파일마다
// 머리 명중 샷으로 자동 보정한다 (calibrate).

import { VALORANT, WEAPONS } from '../config.js';
import { isAccurate, maxSpeedFor, StopTracker } from '../movement.js';
import { summarize, summarizeStops, buildAdvice, median, mean } from '../analysis.js';
import { matchAdvice, flickClass, trackingBias } from './engine.js';
import { isVisible } from './visibility.js';

// 연막 반지름 (cm). 요원마다 조금씩 다르지만 대략값 — 실제 리플레이로 확인 필요
export const SMOKE_RADIUS = 450;
const SMOKE_PATH = /Smoke/i;

const RAD = Math.PI / 180;
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const pitchDeg = (p) => (p > 180 ? p - 360 : p);

// 요원 코드명 → 이름 (리플레이의 캐릭터 경로 /Game/Characters/<코드명>/...)
export const AGENTS = {
  Aggrobot: 'Gekko', BountyHunter: 'Fade', Breach: 'Breach', Cable: 'Deadlock', Cashew: 'Tejo', Clay: 'Raze',
  Deadeye: 'Chamber', Grenadier: 'KAY/O', Guide: 'Skye', Gumshoe: 'Cypher', Hunter: 'Sova', Killjoy: 'Killjoy',
  Mage: 'Harbor', Nox: 'Vyse', Pandemic: 'Viper', Phoenix: 'Phoenix', Rift: 'Astra', Sarge: 'Brimstone',
  Sequoia: 'Iso', Smonk: 'Clove', Sprinter: 'Neon', Stealth: 'Yoru', Terra: 'Waylay', Thorne: 'Sage',
  Vampire: 'Reyna', Wraith: 'Omen', Wushu: 'Jett',
};

// 맵 코드명 → 이름 (리플레이의 /Game/Maps/<코드명>/)
export const MAPS = {
  Ascent: 'Ascent', Bonsai: 'Split', Triad: 'Haven', Duality: 'Bind', Port: 'Icebox', Foxtrot: 'Breeze',
  Canyon: 'Fracture', Pitt: 'Pearl', Jam: 'Lotus', Juliett: 'Sunset', Infinity: 'Abyss',
};

export function parseNdjson(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 잘린 줄 무시 */ }
  }
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const vec = (v) => (v && num(v.x) !== null ? { x: v.x, y: v.y, z: v.z } : null);

function regionOf(payload) {
  const r = String(payload.RegionalDamage ?? payload.regional_damage ?? '').toLowerCase();
  if (r.includes('head')) return 'head';
  if (r.includes('leg')) return 'leg';
  if (r.includes('normal')) return 'body';
  const bone = String(payload.DamagedBone || '').toLowerCase();
  if (bone.includes('head') || bone.includes('neck')) return 'head';
  if (bone.includes('leg') || bone.includes('calf') || bone.includes('thigh') || bone.includes('foot')) return 'leg';
  return bone ? 'body' : null;
}

function weaponKey(eq) {
  const name = String(eq?.name || eq?.Name || '').toLowerCase();
  return Object.keys(WEAPONS).find((k) => name.includes(k)) || null;
}

// ─── 큰 NDJSON 스트리밍 읽기 ───
// 한 경기 movement.ndjson 은 수백 MB 가 될 수 있어 줄 단위로 읽으면서 필요한 필드만 남긴다.
const KEEP_GROUP = /BombPlayerState|OwnerExclusivePlayerInfo|MulticastNotifyDamage/;

export function compactReplayLine(o) {
  switch (o?.type) {
    case 'remote_character_movement':
      return {
        type: o.type, time_ms: o.time_ms, shooter_character_net_guid: o.shooter_character_net_guid,
        position: o.position, yaw: o.yaw, pitch: o.pitch, velocity: o.velocity, error_sentinel: o.error_sentinel,
      };
    case 'valorant_shot_received': {
      const s = o.shot || {};
      return {
        type: o.type, time_ms: o.time_ms,
        shot: {
          firing_player_state: s.firing_player_state, location: s.location, rotation: s.rotation,
          ammo_remaining: s.ammo_remaining, equippable: s.equippable ? { name: s.equippable.name, category: s.equippable.category } : null,
        },
      };
    }
    case 'actor_spawned': {
      const path = `${o.archetype_path || ''} ${o.actor_path || ''} ${o.replication_class_path || ''}`;
      const mm = path.match(/\/Game\/Maps\/([A-Za-z0-9]+)\//);
      if (mm) return { type: 'map_hint', map: mm[1] };
      return path.includes('/Game/Characters/')
        ? { type: o.type, time_ms: o.time_ms, actor_net_guid: o.actor_net_guid, archetype_path: path, location: o.location }
        : null;
    }
    case 'actor_closed':
      return { type: o.type, time_ms: o.time_ms, actor_net_guid: o.actor_net_guid };
    case 'export_group_received': {
      const path = o.export_group_path || o.class_path || '';
      return KEEP_GROUP.test(path)
        ? { type: o.type, time_ms: o.time_ms, actor_net_guid: o.actor_net_guid, export_group_path: path, payload: o.payload }
        : null;
    }
    default:
      return null;
  }
}

// 문자열 조각(async iterable) → 줄
export async function* textLines(chunks) {
  let rest = '';
  for await (const chunk of chunks) {
    rest += chunk;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      yield rest.slice(0, i);
      rest = rest.slice(i + 1);
    }
  }
  if (rest) yield rest;
}

// 문자열 조각 → 필요한 이벤트만 (onProgress(줄 수))
export async function readCompact(chunks, onProgress) {
  const out = [];
  let n = 0;
  for await (const line of textLines(chunks)) {
    n++;
    if (onProgress && n % 50000 === 0) onProgress(n);
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const c = compactReplayLine(o);
    if (c) out.push(c);
  }
  return out;
}

// 브라우저 File → 문자열 조각
export async function* fileChunks(file) {
  const reader = file.stream().getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield dec.decode(value, { stream: true });
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

/**
 * NDJSON 이벤트 → 경기 모델
 * players: psGuid → { ps, subject, agent, characters:Set }
 */
export function buildReplayModel(events, movement) {
  const players = new Map();
  const charToPs = new Map();
  const charAgent = new Map();
  const moves = new Map();
  const shots = [];
  const damage = [];
  const smokes = new Map();
  const closed = new Map();
  let ownerHint = null;
  const mapHints = new Map();
  const player = (ps) => {
    if (!players.has(ps)) players.set(ps, { ps, subject: null, agent: null, characters: new Set() });
    return players.get(ps);
  };
  const linkChar = (ps, ch) => {
    if (!ps || !ch) return;
    player(ps).characters.add(ch);
    charToPs.set(ch, ps);
    if (charAgent.has(ch) && !player(ps).agent) player(ps).agent = charAgent.get(ch);
  };

  for (const e of events) {
    const t = (e.time_ms ?? 0) / 1000;
    if (e.type === 'map_hint') {
      mapHints.set(e.map, (mapHints.get(e.map) || 0) + 1);
      continue;
    }
    if (e.type === 'actor_spawned') {
      const path = `${e.archetype_path || ''} ${e.actor_path || ''} ${e.replication_class_path || ''}`;
      const m = path.match(/\/Game\/Characters\/([A-Za-z]+)\//);
      // 연막 (투사체가 아니라 터진 뒤 남는 연막 구역)
      if (SMOKE_PATH.test(path) && !/Projectile/i.test(path) && vec(e.location)) {
        smokes.set(e.actor_net_guid, { guid: e.actor_net_guid, t0: t, t1: t + 20, ...vec(e.location), r: SMOKE_RADIUS, path });
      } else if (m && /_PC(\.|_C)/.test(path)) charAgent.set(e.actor_net_guid, AGENTS[m[1]] || m[1]);
      else if (m && !charAgent.has(e.actor_net_guid) && !/Ability|Projectile|GameObject|Zone|Equippable/i.test(path)) charAgent.set(e.actor_net_guid, AGENTS[m[1]] || m[1]);
    } else if (e.type === 'actor_closed') {
      closed.set(e.actor_net_guid, t);
    } else if (e.type === 'export_group_received' && e.payload) {
      const p = e.payload;
      const path = e.export_group_path || e.class_path || '';
      if (path.includes('BombPlayerState')) {
        const pl = player(e.actor_net_guid);
        if (p.Subject) pl.subject = p.Subject;
        linkChar(e.actor_net_guid, p.PossessedCharacter || p.SpawnedCharacter);
      } else if (path.includes('OwnerExclusivePlayerInfo')) {
        if (p.Owner) ownerHint = p.Owner;
      } else if (path.includes('MulticastNotifyDamage')) {
        damage.push({
          t,
          attackerPs: p.DamagerPlayerState || p.KillCreditPlayerState || null,
          victimChar: p.Character || e.actor_net_guid || null,
          region: regionOf(p),
          dealt: num(p.DamageDealt) ?? num(p.DamageTaken) ?? 0,
          killed: !!p.DamageKilledTarget || p.AliveAfterDamage === false,
        });
      }
    } else if (e.type === 'valorant_shot_received' && e.shot) {
      const s = e.shot;
      const loc = vec(s.location);
      if (!loc || !s.rotation || !s.firing_player_state) continue;
      shots.push({
        t,
        ps: s.firing_player_state,
        loc,
        yaw: s.rotation.yaw,
        pitch: pitchDeg(s.rotation.pitch),
        ammo: num(s.ammo_remaining),
        weapon: weaponKey(s.equippable),
        category: s.equippable?.category || null,
      });
    }
  }

  for (const m of movement) {
    if (m.type !== 'remote_character_movement' || m.error_sentinel) continue;
    const ch = m.shooter_character_net_guid;
    const p = vec(m.position);
    if (!ch || !p) continue;
    if (!moves.has(ch)) moves.set(ch, []);
    moves.get(ch).push({ t: m.time_ms / 1000, ...p, yaw: m.yaw, pitch: pitchDeg(m.pitch), vel: vec(m.velocity), state: m.movement_state });
  }
  for (const arr of moves.values()) arr.sort((a, b) => a.t - b.t);
  for (const [ch, ps] of charToPs) if (charAgent.has(ch)) player(ps).agent ||= charAgent.get(ch);
  shots.sort((a, b) => a.t - b.t);
  damage.sort((a, b) => a.t - b.t);
  for (const d of damage) d.victimPs = charToPs.get(d.victimChar) ?? null;

  for (const sm of smokes.values()) if (closed.has(sm.guid) && closed.get(sm.guid) > sm.t0) sm.t1 = closed.get(sm.guid);

  const mapCode = [...mapHints].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    players, charToPs, moves, shots, damage, smokes: [...smokes.values()], ownerHint,
    mapCode, mapName: mapCode ? MAPS[mapCode] || mapCode : null,
  };
}

// ─── 한 플레이어의 위치·시야 (라운드마다 캐릭터가 바뀌므로 모두 합친다) ───
export class PlayerTrack {
  constructor(model, ps) {
    const pl = model.players.get(ps);
    this.samples = [...(pl?.characters || [])].flatMap((ch) => model.moves.get(ch) || []).sort((a, b) => a.t - b.t);
  }

  get length() {
    return this.samples.length;
  }

  // 선형 보간. 샘플 사이가 maxGap 초보다 멀면 null
  at(t, maxGap = 0.5) {
    const s = this.samples;
    let lo = 0, hi = s.length - 1, i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (i < 0 || i >= s.length - 1) {
      const e = i < 0 ? s[0] : s[s.length - 1];
      return e && Math.abs(e.t - t) <= maxGap ? e : null;
    }
    const a = s[i], b = s[i + 1];
    if (b.t - a.t > maxGap) return Math.abs(a.t - t) <= maxGap / 2 ? a : null;
    const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const lerp = (x, y) => x + (y - x) * k;
    return {
      t, x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z),
      yaw: a.yaw + wrapDeg(b.yaw - a.yaw) * k, pitch: lerp(a.pitch, b.pitch),
      speed: speedOf(a, b),
    };
  }

  // 평균 샘플 간격 (s)
  sampleInterval() {
    const d = [];
    for (let i = 1; i < this.samples.length; i++) {
      const g = this.samples[i].t - this.samples[i - 1].t;
      if (g > 0 && g < 0.5) d.push(g);
    }
    return median(d);
  }
}

function speedOf(a, b) {
  if (a.vel) return Math.hypot(a.vel.x, a.vel.y) / 100;
  const dt = b.t - a.t;
  return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / 100 / dt : 0;
}

// 방향 (yaw, pitch) → 단위 벡터. conv: 부호 규칙 { ys: yaw 부호, ps: pitch 부호 }
function dirOf(from, to, conv) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return {
    yaw: conv.ys * Math.atan2(dy, dx) / RAD,
    pitch: conv.ps * Math.atan2(dz, Math.hypot(dx, dy)) / RAD,
  };
}

/**
 * 좌표 규칙 보정: 머리에 맞은 샷은 조준 방향 ≈ 발사 위치→적 머리 방향이어야 한다.
 * yaw/pitch 부호 4가지와 머리 높이(발사 위치 기준 적 위치에 더할 높이)를 바꿔가며 오차가 가장 작은 조합을 고른다.
 */
export function calibrate(model, pairs) {
  const convs = [{ ys: 1, ps: 1 }, { ys: -1, ps: 1 }, { ys: 1, ps: -1 }, { ys: -1, ps: -1 }];
  let best = null;
  for (const conv of convs) {
    for (let head = 0; head <= 200; head += 4) {
      const errs = pairs.map(({ shot, target }) => {
        const d = dirOf(shot.loc, { ...target, z: target.z + head }, conv);
        return Math.hypot(wrapDeg(d.yaw - shot.yaw), d.pitch - shot.pitch);
      });
      const err = median(errs);
      if (!best || err < best.err) best = { conv, headZ: head, err, samples: pairs.length };
    }
  }
  return best;
}

/**
 * 내 교전 재구성.
 * me: 내 PlayerState guid. opts.enemies: 적 PS 목록 (없으면 명중·사망 기록으로 팀 추정)
 */
export function analyzeReplay(model, me, opts = {}) {
  const myTrack = new PlayerTrack(model, me);
  const tracks = new Map();
  const trackOf = (ps) => {
    if (!tracks.has(ps)) tracks.set(ps, new PlayerTrack(model, ps));
    return tracks.get(ps);
  };
  const enemies = new Set(opts.enemies || inferEnemies(model, me));

  const myShots = model.shots.filter((s) => s.ps === me);
  // 내 샷 → 명중 기록 (0.2초 이내 내가 준 데미지, 한 번만 연결)
  const usedHits = new Set();
  const hitOf = (shot) => model.damage.find((d) => d.attackerPs === me && d.t >= shot.t - 0.02 && d.t <= shot.t + 0.2 && !usedHits.has(d));

  // 보정용: 머리에 맞은 샷과 그 적의 위치
  const calPairs = [];
  for (const s of myShots) {
    const d = hitOf(s);
    if (!d || d.region !== 'head' || !d.victimPs) continue;
    const tp = trackOf(d.victimPs).at(s.t);
    if (tp) calPairs.push({ shot: s, target: tp });
  }
  const cal = calPairs.length >= 3 ? calibrate(model, calPairs) : null;
  const conv = cal?.conv || { ys: 1, ps: 1 };
  const headZ = cal?.headZ ?? 64;
  // 발사 위치(카메라)와 내 캐릭터 위치의 높이 차 = 눈 높이
  const eyeZ = median(myShots.map((s) => { const p = myTrack.at(s.t, 0.2); return p ? s.loc.z - p.z : NaN; }));
  const eyeOf = (p) => ({ x: p.x, y: p.y, z: p.z + (Number.isFinite(eyeZ) ? eyeZ : headZ) });
  const headOf = (p) => ({ x: p.x, y: p.y, z: p.z + headZ });

  // 시야 = 내 이동 샘플의 yaw/pitch. 발사 기록의 조준 방향과 규칙이 다를 수 있어 맞춘다
  const vc = viewConvention(myTrack, myShots);
  const viewAt = (t) => {
    const p = myTrack.at(t);
    return p ? { yaw: vc.yawSign * p.yaw + vc.yawOffset, pitch: vc.pitchSign * p.pitch, pos: p } : null;
  };
  const errTo = (ps, t, view = viewAt(t)) => {
    const tp = trackOf(ps).at(t);
    if (!view || !tp) return null;
    const d = dirOf(eyeOf(view.pos), headOf(tp), conv);
    return { ex: wrapDeg(d.yaw - view.yaw), ey: d.pitch - view.pitch, dist: Math.hypot(tp.x - view.pos.x, tp.y - view.pos.y) / 100, tp };
  };
  const headRadius = (dist) => Math.atan(0.125 / Math.max(0.5, dist)) / RAD;

  // 적 target 이 time t 에 내 화면에 보였는지 (벽·연막·시야각)
  const visibleAt = (target, t) => {
    const v = viewAt(t);
    const tp = trackOf(target).at(t);
    if (!v || !tp) return false;
    const eye = eyeOf(v.pos);
    return isVisible({
      bvh: opts.map.bvh, smokes: model.smokes || [], eye, head: headOf(tp), t,
      errOf: (p) => { const d = dirOf(eye, p, conv); return { ex: wrapDeg(d.yaw - v.yaw), ey: d.pitch - v.pitch }; },
    });
  };
  const findAppear = (target, endRef) => {
    let seen = false, t = endRef;
    for (; t >= endRef - 5; t -= 0.01) {
      if (visibleAt(target, t)) seen = true;
      else if (seen) break;
      else if (endRef - t > 0.3) return NaN; // 쏜 순간 근처에 안 보였음 (벽 너머 사격 등)
    }
    return seen ? t + 0.01 : NaN;
  };

  // 샷을 교전(같은 적, 1.5초 이내 연속)으로 묶는다
  const engagements = [];
  let cur = null;
  for (const s of myShots) {
    // 조준 방향에 가장 가까운 적
    let target = null, bestErr = Infinity, bestE = null;
    const errFromShot = (ps) => {
      const tp = trackOf(ps).at(s.t);
      if (!tp) return null;
      const d = dirOf(s.loc, headOf(tp), conv);
      return { ex: wrapDeg(d.yaw - s.yaw), ey: d.pitch - s.pitch, dist: Math.hypot(tp.x - s.loc.x, tp.y - s.loc.y) / 100, tp };
    };
    for (const ps of enemies) {
      const e = errFromShot(ps);
      if (!e) continue;
      const err = Math.hypot(e.ex, e.ey);
      if (err < bestErr) { bestErr = err; target = ps; bestE = e; }
    }
    const hit = hitOf(s);
    if (hit) {
      usedHits.add(hit);
      // 실제로 맞힌 적이 있으면 그 적이 목표
      if (hit.victimPs && enemies.has(hit.victimPs) && hit.victimPs !== target) {
        target = hit.victimPs;
        bestE = errFromShot(target);
      }
    }
    if (!target || (bestErr > 30 && !hit)) continue;
    if (!cur || cur.target !== target || s.t - cur.lastT > 1.5) {
      cur = { target, shots: [], lastT: s.t, firstT: s.t };
      engagements.push(cur);
    }
    cur.shots.push({ s, e: bestE, hit });
    cur.lastT = s.t;
  }

  // 내가 쏘지 못하고 죽은 경우도 교전으로
  const myDeaths = model.damage.filter((d) => d.victimPs === me && d.killed);
  for (const d of myDeaths) {
    const own = engagements.find((g) => g.target === d.attackerPs && d.t >= g.firstT - 0.5 && d.t <= g.lastT + 1.5);
    if (own) own.death = d;
    else if (d.attackerPs) engagements.push({ target: d.attackerPs, shots: [], firstT: d.t, lastT: d.t, death: d, noShot: true });
  }
  engagements.sort((a, b) => a.firstT - b.firstT);

  const out = [];
  for (const g of engagements) {
    const endRef = g.shots.length ? g.firstT : g.death.t;
    // 맵이 있으면 적이 화면에 보이기 시작한 순간 (첫 발부터 거슬러 올라가며 계속 보이던 구간의 시작)
    const appearT = opts.map ? findAppear(g.target, endRef) : NaN;
    // 조준 경로: 보인 순간(모르면 첫 발 1초 전)부터 첫 발(또는 사망)까지
    const pathStart = Number.isFinite(appearT) ? Math.min(appearT, endRef - 0.05) : endRef - 1.0;
    const path = [];
    for (let t = pathStart; t <= endRef + 1e-9; t += 0.01) {
      const e = errTo(g.target, t);
      if (e) path.push({ t, ex: e.ex, ey: e.ey });
    }
    if (!path.length) continue;
    // 반응 시작: 첫 발 전 1초 안에서 크로스헤어가 가장 빠르게 움직인 순간(주 플릭)을 찾고,
    // 거기서 거슬러 올라가 움직임이 시작된 순간
    const speed = path.map((p, i) => (i ? Math.hypot(p.ex - path[i - 1].ex, p.ey - path[i - 1].ey) / Math.max(1e-3, p.t - path[i - 1].t) : 0));
    let peak = 0;
    for (let i = 1; i < speed.length; i++) if (speed[i] > speed[peak]) peak = i;
    let onset = 0;
    if (speed[peak] > 30) {
      const quiet = Math.max(15, speed[peak] * 0.1);
      onset = peak;
      while (onset > 0 && !(speed[onset] < quiet && speed[onset - 1] < quiet)) onset--;
    }
    // 보인 순간을 알면 그때의 크로스헤어 오차, 모르면 반응을 시작한 순간의 오차
    const known = Number.isFinite(appearT);
    const start = known ? path[0] : path[onset];
    const dist = errTo(g.target, endRef)?.dist ?? 20;
    const rDeg = headRadius(dist);
    const kill = model.damage.find((d) => d.attackerPs === me && d.victimPs === g.target && d.killed && d.t >= g.firstT - 0.05 && d.t <= g.lastT + 0.3);

    let spray = 0, prevT = -Infinity;
    const engShots = g.shots.map(({ s, e, hit }) => {
      spray = s.t - prevT < 0.3 ? spray + 1 : 0;
      prevT = s.t;
      const me0 = myTrack.at(s.t, 0.3);
      const speed = me0?.speed ?? 0;
      const w = WEAPONS[s.weapon] || WEAPONS.vandal;
      const t0 = trackOf(g.target).at(s.t - 0.05), t1 = trackOf(g.target).at(s.t + 0.05);
      let targetVel = NaN, targetSpeed = NaN;
      if (t0 && t1 && me0) {
        const a = dirOf(eyeOf(me0), headOf(t0), conv), b = dirOf(eyeOf(me0), headOf(t1), conv);
        targetVel = wrapDeg(b.yaw - a.yaw) / 0.1;
        targetSpeed = Math.hypot(t1.x - t0.x, t1.y - t0.y) / 100 / 0.1;
      }
      const v0 = viewAt(s.t - 0.03), e0 = v0 ? errTo(g.target, s.t - 0.03, v0) : null;
      return {
        t: s.t,
        part: hit && hit.victimPs === g.target ? hit.region : null,
        moving: !isAccurate(speed, w),
        speed,
        ex: e?.ex ?? NaN,
        ey: e?.ey ?? NaN,
        targetVel,
        spray,
        targetStopped: Number.isFinite(targetSpeed) ? targetSpeed <= maxSpeedFor(w, false) * VALORANT.ACCURATE_SPEED_RATIO : undefined,
        relSpeed: e && e0 ? Math.hypot(e.ex - e0.ex, e.ey - e0.ey) / 0.03 : NaN,
        weapon: s.weapon,
      };
    });

    out.push({
      mode: 'replay',
      target: g.target,
      appearT: known ? path[0].t : path[onset].t,
      onsetT: path[onset].t,
      appearKnown: known,
      firstShotT: g.shots.length ? g.firstT : NaN,
      endT: kill ? kill.t : g.death ? g.death.t : g.lastT,
      result: kill ? 'kill' : g.death ? 'death' : 'escape',
      // 알 수 없는 "적이 보인 순간" 대신 반응을 시작한 순간의 크로스헤어 오차
      placement: { ex: start.ex, ey: start.ey },
      path: known ? path : path.slice(onset),
      radiusDeg: rDeg,
      shots: engShots,
      bait: false,
      noShot: !!g.noShot,
      deathErr: g.death ? errTo(g.target, g.death.t) : null,
    });
  }

  // 멈춤 (카운터 스트레이프 여부는 감속 속도로 추정: 80ms 이하면 반대 키를 쓴 것으로 봄)
  const stops = [];
  const tracker = new StopTracker();
  const w = WEAPONS[myShots.find((s) => s.weapon)?.weapon] || WEAPONS.vandal;
  const run = maxSpeedFor(w, false);
  for (let i = 1; i < myTrack.samples.length; i++) {
    const a = myTrack.samples[i - 1], b = myTrack.samples[i];
    if (b.t - a.t > 0.3) { tracker.cancel(); continue; }
    const ev = tracker.update(b.t, speedOf(a, b), run, run * VALORANT.ACCURATE_SPEED_RATIO, false);
    if (ev) stops.push({ ms: ev.ms, counter: ev.ms <= 80 });
  }

  const stats = { ...summarize(out.filter((e) => !e.noShot)), ...summarizeStops(stops) };
  stats.deaths = out.filter((e) => e.result === 'death').length;
  // 반응 속도는 적이 보인 순간을 몰라서 계산하지 않는다. 대신 반응 시작 → 첫 발
  // 반응 속도(보인 순간 → 첫 발)는 맵이 있어 보인 순간을 알 때만
  const react = out.filter((e) => e.appearKnown && Number.isFinite(e.firstShotT)).map((e) => (e.firstShotT - e.appearT) * 1000);
  stats.reactionMs = median(react);
  stats.reactionSamples = react.length;
  stats.appearKnownRate = out.length ? out.filter((e) => e.appearKnown).length / out.length : NaN;
  stats.aimTimeMs = median(out.filter((e) => Number.isFinite(e.firstShotT)).map((e) => (e.firstShotT - e.onsetT) * 1000));
  Object.assign(stats, trackingBias(out));
  const shotsAll = out.flatMap((e) => e.shots);
  stats.aimMovingShotRate = shotsAll.length ? shotsAll.filter((s) => s.relSpeed > 15).length / shotsAll.length : NaN;
  const deathErrs = out.filter((e) => e.deathErr).map((e) => Math.hypot(e.deathErr.ex, e.deathErr.ey));
  stats.deathAimErrDeg = median(deathErrs);
  stats.deathFarOffRate = deathErrs.length ? deathErrs.filter((x) => x > 20).length / deathErrs.length : NaN;
  stats.deathSamples = deathErrs.length;
  stats.noShotDeaths = out.filter((e) => e.noShot).length;

  const advice = [...buildAdvice(stats, { mode: 'replay' }), ...matchAdvice(stats), ...replayAdvice(stats)];
  return {
    stats,
    advice,
    engagements: out,
    diagnostics: {
      myMoveSamples: myTrack.length,
      moveIntervalMs: Math.round((myTrack.sampleInterval() || NaN) * 1000),
      myShots: myShots.length,
      enemies: [...enemies],
      calibration: cal,
      viewConvention: vc,
      eyeZ,
      flickSamples: out.filter((e) => flickClass(e)).length,
      map: opts.map?.name || null,
      appearKnown: out.filter((e) => e.appearKnown).length,
      smokes: (model.smokes || []).length,
    },
  };
}

// 이동 기록의 시야 각도 규칙을 발사 기록(조준 방향)에 맞춘다: yaw 부호·오프셋, pitch 부호
export function viewConvention(track, shots) {
  const pairs = [];
  for (const s of shots) {
    const p = track.at(s.t, 0.1);
    if (p) pairs.push([p, s]);
  }
  if (pairs.length < 5) return { yawSign: 1, yawOffset: 0, pitchSign: 1, err: NaN, samples: pairs.length };
  let best = null;
  for (const yawSign of [1, -1]) {
    const yawOffset = median(pairs.map(([p, s]) => wrapDeg(s.yaw - yawSign * p.yaw)));
    for (const pitchSign of [1, -1]) {
      const err = median(pairs.map(([p, s]) => Math.hypot(wrapDeg(yawSign * p.yaw + yawOffset - s.yaw), pitchSign * p.pitch - s.pitch)));
      if (!best || err < best.err) best = { yawSign, yawOffset: Math.abs(yawOffset) < 0.5 ? 0 : yawOffset, pitchSign, err, samples: pairs.length };
    }
  }
  return best;
}

// 서로 데미지를 준 사이 = 다른 팀. 나와 연결되지 않은 플레이어는 연결된 사람을 통해 추정
export function inferEnemies(model, me) {
  const edges = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a).add(b);
    edges.get(b).add(a);
  };
  for (const d of model.damage) add(d.attackerPs, d.victimPs);
  const side = new Map([[me, 0]]);
  const queue = [me];
  while (queue.length) {
    const a = queue.shift();
    for (const b of edges.get(a) || []) {
      if (!side.has(b)) { side.set(b, 1 - side.get(a)); queue.push(b); }
    }
  }
  const enemies = [...side].filter(([, s]) => s === 1).map(([ps]) => ps);
  if (enemies.length) return enemies;
  return [...model.players.keys()].filter((ps) => ps !== me);
}

// 리플레이의 PlayerState 중 "나" 후보: 소유자 정보 → 없으면 null (사용자가 고른다)
export function guessMe(model) {
  if (model.ownerHint && model.players.has(model.ownerHint)) return model.ownerHint;
  return null;
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function replayAdvice(stats) {
  const out = [];
  const add = (level, title, text, key) => out.push({ level, title, text, key });
  if (Number.isFinite(stats.deathAimErrDeg) && stats.deathSamples >= 3) {
    if (stats.deathFarOffRate > 0.4) {
      add('bad', `죽을 때 적과 크게 어긋남 ${pct(stats.deathFarOffRate)}`,
        `죽은 순간 나를 죽인 적과 크로스헤어가 20° 넘게 벌어져 있던 경우가 많아요 (중앙값 ${stats.deathAimErrDeg.toFixed(0)}°). 적이 나올 수 있는 각을 확인하지 않고 이동했거나, 한 번에 여러 각에 노출된 상황입니다. 각을 하나씩 자르고, 확인 안 한 각으로 등을 보이지 마세요.`, 'preaim');
    } else {
      add('good', `죽을 때도 적을 보고 있었음 (중앙값 ${stats.deathAimErrDeg.toFixed(0)}°)`, '대부분 적을 보고 교전하다 졌어요. 이 경우는 크로스헤어 높이·첫 발 정확도를 보세요.', 'preaim');
    }
  }
  if (stats.noShotDeaths >= 3 && stats.deaths > 0 && stats.noShotDeaths / stats.deaths > 0.4) {
    add('warn', `한 발도 못 쏘고 사망 ${stats.noShotDeaths}회`,
      '반응하기 전에 죽은 경우가 많아요. 적이 먼저 볼 수 있는 위치로 뛰어들고 있거나, 크로스헤어가 적이 나올 자리에 없었던 것입니다.', 'preaim');
  }
  if (Number.isFinite(stats.aimTimeMs) && stats.engagements >= 5) {
    add(stats.aimTimeMs > 350 ? 'warn' : 'good', `조준 시간 ${Math.round(stats.aimTimeMs)}ms`,
      stats.aimTimeMs > 350
        ? '크로스헤어가 적에게 움직이기 시작해서 첫 발까지 오래 걸려요. 적이 나올 자리에 미리 두면 이 시간이 크게 줄어요.'
        : '반응을 시작한 뒤 첫 발까지 빠릅니다.', 'reaction');
  }
  return out;
}

