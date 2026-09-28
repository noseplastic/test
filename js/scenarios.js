import { DIFFICULTY, VALORANT } from './config.js';
import { StrafeAI, STRAFE_PROFILES, STRAFE_STOPS, ScriptedMover, buildPeekScript, PEEK_TYPES, makeRng, rand } from './bots.js';
import { summarize, buildAdvice, analyzeFlick, mean } from './analysis.js';
import { recommendSensitivity, edpi } from './sens.js';
import { DEG } from './game.js';

const shuffle = (rng, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

class Scenario {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.settings = { ...game.settings };
    this.rng = makeRng(Date.now());
    this.engagements = [];
    this.current = null;
    this.over = false;
    this.wastedShots = 0;
  }

  get reactionMs() {
    return (DIFFICULTY[this.settings.difficulty] || DIFFICULTY.normal).reactionMs;
  }

  begin(extra = {}) {
    this.current = {
      mode: this.key, appearT: NaN, firstShotT: NaN, endT: NaN, result: null,
      placement: null, path: [], radiusDeg: NaN, shots: [], bait: false, ...extra,
    };
    return this.current;
  }

  markAppear(bot) {
    const e = this.current;
    if (!e || Number.isFinite(e.appearT)) return;
    const err = this.game.aimError(bot.headPoint());
    e.appearT = this.game.now();
    e.placement = { ex: err.ex, ey: err.ey };
    e.radiusDeg = this.game.headRadiusDeg(bot);
    e.path.push({ t: e.appearT, ex: err.ex, ey: err.ey });
  }

  // 보인 뒤 첫 발까지 크로스헤어 궤적 기록
  trackPath(bot) {
    const e = this.current;
    if (!e || !Number.isFinite(e.appearT) || Number.isFinite(e.firstShotT) || e.path.length > 900) return;
    const err = this.game.aimError(bot.headPoint());
    e.path.push({ t: this.game.time, ex: err.ex, ey: err.ey });
  }

  recordShot(shot, bot) {
    const e = this.current;
    if (!e || !Number.isFinite(e.appearT)) {
      this.wastedShots++;
      return false;
    }
    const err = this.game.aimError(bot.headPoint());
    e.shots.push({
      t: shot.t, part: shot.bot === bot ? shot.part : null, moving: shot.moving, speed: shot.speed,
      ex: err.ex, ey: err.ey, targetVel: bot.angRate, spray: shot.spray,
      targetStopped: bot.speed <= bot.maxSpeed * VALORANT.ACCURATE_SPEED_RATIO,
    });
    if (!Number.isFinite(e.firstShotT)) {
      e.firstShotT = shot.t;
      e.path.push({ t: shot.t, ex: err.ex, ey: err.ey });
    }
    return true;
  }

  end(result) {
    const e = this.current;
    if (!e) return null;
    e.endT = this.game.now();
    e.result = result;
    this.engagements.push(e);
    this.current = null;
    return e;
  }

  feedback(text, kind = 'info') {
    this.game.hooks.onFeedback?.(text, kind);
  }

  counts() {
    const shots = this.engagements.flatMap((e) => e.shots);
    const hits = shots.filter((s) => s.part);
    return {
      kills: this.engagements.filter((e) => e.result === 'kill').length,
      deaths: this.engagements.filter((e) => e.result === 'death').length,
      acc: shots.length ? Math.round((hits.length / shots.length) * 100) : 0,
      hs: hits.length ? Math.round((hits.filter((s) => s.part === 'head').length / hits.length) * 100) : 0,
    };
  }

  baseResult(extra = {}) {
    const stats = summarize(this.engagements);
    stats.wastedShots = this.wastedShots;
    const s = this.settings;
    const ctx = { mode: this.key, edpi: edpi(s.sens, s.dpi), duel: this.key === 'strafe' && !!s.strafeDuel };
    const advice = buildAdvice(stats, ctx);
    return {
      mode: this.key,
      modeName: this.name,
      date: Date.now(),
      settings: {
        sens: s.sens, dpi: s.dpi, weapon: s.weapon, difficulty: s.difficulty, distance: s.distance,
        duel: this.key === 'strafe' && !!s.strafeDuel,
      },
      stats,
      advice,
      ...extra,
    };
  }

  // 공통 배경: 넓은 아레나 외벽
  buildArena(size = 60, backZ = -70) {
    const g = this.game;
    g.addBox(-size, size, 0, 8, backZ - 1, backZ);
    g.addBox(-size - 1, -size, 0, 8, backZ, 20);
    g.addBox(size, size + 1, 0, 8, backZ, 20);
    g.addBox(-size, size, 0, 8, 20, 21);
  }
}

// ─── 1. 좌우 스트레이프 봇 ───
export class StrafeScenario extends Scenario {
  key = 'strafe';
  name = '스트레이프 봇 (ADAD)';

  setup() {
    const g = this.game;
    this.buildArena();
    // 거리감용 기둥
    for (let z = -8; z >= -40; z -= 8) {
      g.addBox(-9, -8.4, 0, 4, z - 0.3, z + 0.3);
      g.addBox(8.4, 9, 0, 4, z - 0.3, z + 0.3);
    }
    g.setPlayer(0, 0, 0, 0);
    g.player.bounds = { x1: -4, x2: 4, z1: -1, z2: 2 };
    this.bot = g.spawnBot();
    this.profile = STRAFE_PROFILES[this.settings.strafeProfile] || STRAFE_PROFILES.normal;
    this.stops = STRAFE_STOPS[this.settings.strafeStops] || STRAFE_STOPS.normal;
    this.duel = !!this.settings.strafeDuel;
    this.name = this.duel ? '스트레이프 듀얼 (1:1)' : '스트레이프 봇 (ADAD)';
    this.duration = this.settings.duration;
    this.respawnT = 0;
    this.spawn();
  }

  distance() {
    const d = this.settings.distance;
    return d === 'random' ? rand(this.rng, 10, 30) : Number(d);
  }

  spawn() {
    const x = rand(this.rng, -3, 3);
    this.bot.place(x, -this.distance());
    this.ai = new StrafeAI(this.rng, { minX: -6, maxX: 6, profile: this.profile, stopChance: this.stops.chance });
    // 이미 스트레이프 중인 상태로 등장 (등장하자마자 멈춰서 쏘지 않도록)
    this.bot.vel = { x: this.ai.dir * this.bot.maxSpeed, z: 0 };
    this.stoppedSinceT = NaN;
    this.begin();
    this.bot.sync();
    this.markAppear(this.bot);
  }

  update(dt) {
    const g = this.game;
    if (g.time >= this.duration) {
      if (this.current) this.end('timeout');
      this.over = true;
      return;
    }
    const b = this.bot;
    if (b.alive) {
      const dir = this.ai.update(dt, b.pos.x, b.vel.x);
      b.move(dt, { x: dir * b.maxSpeed, z: 0 });
      g.trackBot(b, dt);
      this.trackPath(b);
      if (this.duel) this.duelFire(b);
    } else if ((this.respawnT -= dt) <= 0) {
      this.spawn();
    }
  }

  // 듀얼: 봇이 카운터 스트레이프로 멈춰 정확해진 뒤 반응 속도가 지나면 나를 쏜다
  duelFire(b) {
    const g = this.game;
    const accurate = b.speed <= b.maxSpeed * VALORANT.ACCURATE_SPEED_RATIO;
    if (!accurate) {
      this.stoppedSinceT = NaN;
      return;
    }
    if (!Number.isFinite(this.stoppedSinceT)) this.stoppedSinceT = g.time;
    if (g.time - this.stoppedSinceT < this.reactionMs / 1000 || !g.botCanSeePlayer(b)) return;
    g.playerDie();
    this.end('death');
    this.feedback('사망 · 봇이 멈춘 순간 먼저 쏨', 'bad');
    b.alive = false;
    b.setVisible(false);
    this.respawnT = 0.8;
  }

  onShot(shot) {
    if (!this.bot.alive) return;
    this.recordShot(shot, this.bot);
    if (shot.bot !== this.bot) return;
    const killed = this.game.applyDamage(this.bot, shot.part);
    if (killed) {
      const e = this.end('kill');
      const ttk = Math.round((e.endT - e.appearT) * 1000);
      const when = e.shots[e.shots.length - 1]?.targetStopped ? ' · 멈춘 순간' : '';
      this.feedback(`${shot.part === 'head' ? '헤드샷' : '킬'} · ${ttk}ms${when}${shot.moving ? ' · 이동 중 사격' : ''}`, shot.part === 'head' ? 'good' : 'info');
      this.respawnT = 0.35;
    }
  }

  hud() {
    const c = this.counts();
    return {
      title: this.name,
      main: `${Math.max(0, Math.ceil(this.duration - this.game.time))}s`,
      info: this.duel
        ? `승 ${c.kills} · 패 ${c.deaths} · 헤드 ${c.hs}%`
        : `킬 ${c.kills} · 정확도 ${c.acc}% · 헤드 ${c.hs}%`,
    };
  }

  result() {
    return this.baseResult({ extra: { profile: this.profile.name, stops: this.stops.name } });
  }
}

// ─── 2. 내가 코너 피킹 ───
// 앞의 벽(x ≤ 0) 뒤에 서 있다가 D로 오른쪽으로 피킹. 적은 자주 서는 자리 중 하나에서 앵글을 잡고 있다.
const PEEK_SPOTS = [
  { x: 2.6, z: -7, name: '가까운 오른쪽' },
  { x: 0.9, z: -13, name: '중앙' },
  { x: -2.2, z: -20, name: '먼 왼쪽' },
  { x: 6.2, z: -11, name: '와이드 오른쪽' },
  { x: 4.2, z: -21, name: '먼 오른쪽' },
];

export class PeekScenario extends Scenario {
  key = 'peek';
  name = '코너 피킹 (내가 피킹)';

  setup() {
    const g = this.game;
    this.buildArena(30, -30);
    // 내 앞의 엄폐벽: 모서리 x = 0, z = -1
    g.addBox(-12, 0, 0, 3.2, -1.6, -1.0);
    // 왼쪽 복도 벽
    g.addBox(-3.2, -2.6, 0, 3.2, -1.0, 3);
    // 적 구역 오브젝트 (프리에임 기준점)
    g.addBox(3.3, 4.3, 0, 1.0, -7.6, -6.6, { kind: 'crate' });
    g.addBox(1.6, 2.6, 0, 1.2, -13.5, -12.5, { kind: 'crate' });
    g.addBox(-4.2, -3.0, 0, 1.0, -21, -19.8, { kind: 'crate' });
    g.addBox(6.9, 7.9, 0, 1.4, -12, -10.6, { kind: 'crate' });
    g.addBox(5.0, 6.0, 0, 1.0, -22, -21, { kind: 'crate' });
    g.addBox(-12, 12, 0, 5, -27, -26);

    this.start = { x: -1.0, z: 0.2 };
    g.setPlayer(this.start.x, this.start.z, 0, 0);
    g.player.bounds = { x1: -2.2, x2: 4, z1: -0.7, z2: 2 };
    this.bot = g.spawnBot();
    this.totalRounds = this.settings.rounds;
    this.round = 0;
    this.newRound();
  }

  newRound() {
    this.round++;
    const g = this.game;
    g.setPlayer(this.start.x, this.start.z);
    const spot = PEEK_SPOTS[Math.floor(this.rng() * PEEK_SPOTS.length)];
    this.spot = spot;
    this.bot.place(spot.x + rand(this.rng, -0.3, 0.3), spot.z + rand(this.rng, -0.3, 0.3));
    this.bot.sync();
    this.state = 'ready';
    this.timer = 0.8;
    this.seenByBotT = NaN;
    this.begin({ spot: spot.name });
  }

  update(dt) {
    const g = this.game;
    const b = this.bot;
    if (b.alive) g.trackBot(b, dt);

    if (this.state === 'ready') {
      g.player.canMove = false;
      if ((this.timer -= dt) <= 0) {
        this.state = 'live';
        this.timer = 10;
        g.player.canMove = true;
        this.feedback('피킹!', 'info');
      }
      return;
    }
    if (this.state === 'after') {
      if ((this.timer -= dt) <= 0) {
        if (this.round >= this.totalRounds) this.over = true;
        else this.newRound();
      }
      return;
    }

    // live
    if (g.canSeeBot(b)) this.markAppear(b);
    this.trackPath(b);

    // 적 반응: 나를 계속 보고 있는 시간이 반응속도를 넘으면 사격
    if (b.alive && g.botCanSeePlayer(b)) {
      if (!Number.isFinite(this.seenByBotT)) this.seenByBotT = g.time;
      const react = this.reactionMs / 1000 + rand(this.rng, -0.03, 0.03);
      if (g.time - this.seenByBotT >= react) {
        g.playerDie();
        this.end('death');
        this.feedback(`사망 · 적 반응 ${Math.round(react * 1000)}ms`, 'bad');
        this.finishRound();
        return;
      }
    } else {
      this.seenByBotT = NaN;
    }

    if ((this.timer -= dt) <= 0) {
      this.end('timeout');
      this.feedback('시간 초과', 'warn');
      this.finishRound();
    }
  }

  finishRound() {
    this.state = 'after';
    this.timer = 0.9;
    this.game.player.canMove = false;
    this.game.player.vel = { x: 0, z: 0 };
  }

  onShot(shot) {
    if (this.state !== 'live') return;
    this.recordShot(shot, this.bot);
    if (shot.bot !== this.bot || !this.bot.alive) return;
    if (this.game.applyDamage(this.bot, shot.part)) {
      const e = this.end('kill');
      const t = Math.round((e.endT - e.appearT) * 1000);
      this.feedback(`${shot.part === 'head' ? '헤드샷' : '킬'} · 보인 뒤 ${t}ms${shot.moving ? ' · 이동 중 사격!' : ''}`, shot.moving ? 'warn' : 'good');
      this.finishRound();
    }
  }

  hud() {
    const c = this.counts();
    return {
      title: this.name,
      main: `${Math.min(this.round, this.totalRounds)} / ${this.totalRounds}`,
      info: `승 ${c.kills} · 패 ${c.deaths} · 헤드 ${c.hs}%`,
    };
  }

  result() {
    return this.baseResult();
  }
}

// ─── 3. 적 피킹 대응 (앵글 홀드) ───
// 정면 D m 거리에 3m 폭 입구. 적이 좌/우 벽 뒤에서 다양한 방식으로 피킹한다.
export class HoldScenario extends Scenario {
  key = 'hold';
  name = '앵글 홀드 (적이 피킹)';

  setup() {
    const g = this.game;
    const d = this.settings.distance === 'random' ? 14 : Math.max(8, Math.min(25, Number(this.settings.distance)));
    this.D = d;
    this.buildArena(30, -d - 12);
    const half = 1.5;
    const zf = -d + 0.3, zb = -d - 0.3;
    g.addBox(-14, -half, 0, 3.5, zb, zf);
    g.addBox(half, 14, 0, 3.5, zb, zf);
    // 적 뒤쪽 벽
    g.addBox(-14, 14, 0, 4, -d - 5, -d - 4.4);
    // 내 쪽 복도 벽
    g.addBox(-4.5, -4, 0, 3, zf, 2);
    g.addBox(4, 4.5, 0, 3, zf, 2);

    this.laneZ = -d - 1.6;
    // 적 어깨가 보이기 시작할 때의 몸 중심 |x| (플레이어 원점 기준 근사)
    this.edge = half * (-this.laneZ) / (-zb) + 0.25;
    g.setPlayer(0, 0, 0, 0);
    g.player.bounds = { x1: -1.2, x2: 1.2, z1: -0.6, z2: 0.6 };
    this.bot = g.spawnBot();
    this.types = Object.keys(PEEK_TYPES);
    this.weights = { wide: 0.35, tight: 0.25, shoulder: 0.25, cross: 0.15 };
    this.totalRounds = this.settings.rounds;
    this.round = 0;
    this.newRound();
  }

  pickType() {
    let r = this.rng();
    for (const t of this.types) {
      r -= this.weights[t];
      if (r <= 0) return t;
    }
    return 'wide';
  }

  newRound() {
    this.round++;
    const side = this.rng() < 0.5 ? 1 : -1; // +1: 왼쪽 벽 뒤에서 오른쪽으로 나옴
    const type = this.pickType();
    const coverX = -side * 3.2;
    const edgeX = -side * this.edge;
    const farX = side * 4.5;
    this.side = side;
    this.type = type;
    this.bot.place(coverX, this.laneZ);
    this.bot.sync();
    this.mover = new ScriptedMover(buildPeekScript(this.rng, { type, coverX, edgeX, side, farX }));
    this.state = 'live';
    this.stoppedSeenT = NaN;
    this.realPeek = type !== 'shoulder';
    this.begin({ peekType: type });
  }

  update(dt) {
    const g = this.game;
    const b = this.bot;

    if (this.state === 'after') {
      if ((this.timer -= dt) <= 0) {
        if (this.round >= this.totalRounds) this.over = true;
        else this.newRound();
      }
      return;
    }

    if (b.alive) {
      const dir = this.mover.update(dt, b.pos.x, b.vel.x, b.maxSpeed);
      b.move(dt, { x: dir * b.maxSpeed, z: 0 });
      g.trackBot(b, dt);
      // 숄더 피크의 마지막 "진짜 피크" 이동이 시작되면 이후 등장부터 기록
      if (!this.realPeek && this.mover.index >= this.mover.steps.length - 2) this.realPeek = true;
    }

    const visible = g.canSeeBot(b);
    if (visible && this.realPeek) this.markAppear(b);
    this.trackPath(b);

    // 적 사격: 멈춘 상태(hold)에서 나를 반응속도 이상 봤으면 사격
    const holding = this.mover.current && this.mover.current.type === 'hold';
    if (b.alive && holding && b.speed < b.maxSpeed * VALORANT.ACCURATE_SPEED_RATIO && g.botCanSeePlayer(b)) {
      if (!Number.isFinite(this.stoppedSeenT)) {
        // 피킹하는 쪽은 이미 조준하고 나오므로 등장 순간부터 반응 시간이 흐른다
        this.stoppedSeenT = Number.isFinite(this.current?.appearT) ? this.current.appearT : g.time;
      }
      const react = this.reactionMs / 1000;
      if (g.time - this.stoppedSeenT >= react) {
        g.playerDie();
        this.end('death');
        this.feedback(`사망 · ${PEEK_TYPES[this.type]}`, 'bad');
        this.finishRound(1.0);
        return;
      }
    }

    // 가로지르기 완료 → 놓침
    if (this.mover.done && b.alive) {
      this.end(Number.isFinite(this.current?.appearT) ? 'escape' : 'timeout');
      this.feedback(`놓침 · ${PEEK_TYPES[this.type]}`, 'warn');
      this.finishRound(0.8);
    }
  }

  finishRound(t) {
    this.state = 'after';
    this.timer = t;
  }

  onShot(shot) {
    if (this.state !== 'live') return;
    this.recordShot(shot, this.bot);
    if (shot.bot !== this.bot || !this.bot.alive) return;
    if (this.game.applyDamage(this.bot, shot.part)) {
      const e = this.end('kill');
      const react = Math.round((e.firstShotT - e.appearT) * 1000);
      const label = Number.isFinite(react) ? ` · 반응 ${react}ms` : '';
      this.feedback(`${shot.part === 'head' ? '헤드샷' : '킬'}${label} · ${PEEK_TYPES[this.type]}`, 'good');
      this.finishRound(0.9);
    }
  }

  hud() {
    const c = this.counts();
    return {
      title: this.name,
      main: `${Math.min(this.round, this.totalRounds)} / ${this.totalRounds}`,
      info: `승 ${c.kills} · 패 ${c.deaths} · 헤드 ${c.hs}%`,
    };
  }

  result() {
    const byType = {};
    for (const t of this.types) {
      const es = this.engagements.filter((e) => e.peekType === t);
      if (es.length) {
        byType[t] = {
          name: PEEK_TYPES[t],
          n: es.length,
          win: es.filter((e) => e.result === 'kill').length,
          reaction: Math.round(mean(es.filter((e) => Number.isFinite(e.firstShotT) && Number.isFinite(e.appearT)).map((e) => (e.firstShotT - e.appearT) * 1000))),
        };
      }
    }
    const res = this.baseResult({ byType });
    if (this.wastedShots >= 3) {
      res.advice.push({ level: 'warn', title: `미끼 사격 ${this.wastedShots}발`, text: '적이 제대로 나오기 전(숄더 피크)이나 보이지 않을 때 쏜 총알이 많아요. 숄더 피크에는 반응만 하고, 몸이 확실히 나올 때 쏘세요.' });
    }
    return res;
  }
}

// ─── 4. 플릭 / 감도 찾기 ───
export class FlickScenario extends Scenario {
  key = 'flick';

  constructor(game, opts = {}) {
    super(game, opts);
    this.finder = !!opts.finder;
    this.name = this.finder ? '감도 찾기 (블라인드 테스트)' : '플릭 (헤드 전용)';
  }

  setup() {
    const g = this.game;
    this.buildArena(40, -40);
    g.setPlayer(0, 0, 0, 0);
    g.player.canMove = false;
    this.bot = g.spawnBot();
    this.bot.setVisible(false);
    this.bot.alive = false;
    if (this.finder) {
      this.multipliers = shuffle(this.rng, [0.8, 0.9, 1.0, 1.1, 1.25]);
      this.perBlock = 12;
      this.warmup = 3;
    } else {
      this.multipliers = [1];
      this.perBlock = this.settings.flickTargets;
      this.warmup = 0;
    }
    this.blockIdx = 0;
    this.blockCount = 0;
    this.blocks = this.multipliers.map((m) => ({ multiplier: m, engagements: [] }));
    g.sensMultiplier = this.multipliers[0];
    this.state = 'wait';
    this.timer = 0.6;
  }

  spawn() {
    const g = this.game;
    const off = rand(this.rng, 12, 65) * (this.rng() < 0.5 ? -1 : 1);
    const yaw = g.player.yaw / DEG + off;
    const dist = rand(this.rng, 8, 22);
    const elev = this.rng() < 0.3 ? rand(this.rng, 0.4, 1.6) : 0;
    const x = -Math.sin(yaw * DEG) * dist;
    const z = -Math.cos(yaw * DEG) * dist;
    this.bot.place(x, z, elev);
    this.bot.sync();
    this.begin({ warm: this.blockCount < this.warmup, block: this.blockIdx });
    this.markAppear(this.bot);
    this.state = 'live';
    this.timer = 5;
  }

  update(dt) {
    const g = this.game;
    if (this.state === 'wait') {
      if ((this.timer -= dt) <= 0) this.spawn();
      return;
    }
    const b = this.bot;
    g.trackBot(b, dt);
    this.trackPath(b);
    if ((this.timer -= dt) <= 0) {
      b.alive = false;
      b.setVisible(false);
      this.finishTarget('timeout');
    }
  }

  finishTarget(result) {
    const e = this.end(result);
    if (e && !e.warm) this.blocks[this.blockIdx].engagements.push(e);
    this.blockCount++;
    this.state = 'wait';
    this.timer = 0.25;
    if (this.blockCount >= this.perBlock + this.warmup) {
      this.blockIdx++;
      this.blockCount = 0;
      if (this.blockIdx >= this.multipliers.length) {
        this.over = true;
        return;
      }
      this.game.sensMultiplier = this.multipliers[this.blockIdx];
      this.timer = 1.5;
      this.feedback(`감도 변경 · 블록 ${this.blockIdx + 1}/${this.multipliers.length} (처음 ${this.warmup}개는 적응용)`, 'info');
    }
  }

  onShot(shot) {
    if (this.state !== 'live') return;
    this.recordShot(shot, this.bot);
    if (shot.bot !== this.bot) return;
    if (shot.part === 'head') {
      this.bot.alive = false;
      this.bot.setVisible(false);
      this.game.sfx.head();
      const e = this.current;
      const t = Math.round((this.game.now() - e.appearT) * 1000);
      if (!this.finder) this.feedback(`${t}ms`, 'good');
      this.finishTarget('kill');
    } else {
      this.bot.flash();
      this.game.sfx.hit();
    }
  }

  hud() {
    const c = this.counts();
    const total = this.perBlock + this.warmup;
    return {
      title: this.name,
      main: this.finder
        ? `블록 ${Math.min(this.blockIdx + 1, this.multipliers.length)}/${this.multipliers.length} · ${Math.min(this.blockCount + 1, total)}/${total}`
        : `${Math.min(this.blockCount + 1, total)} / ${total}`,
      info: `정확도 ${c.acc}%`,
    };
  }

  blockSummary(block) {
    const es = block.engagements;
    const shots = es.flatMap((e) => e.shots);
    const times = es.map((e) => (e.result === 'kill' ? e.endT - e.appearT : 5));
    const flicks = es.map((e) => analyzeFlick(e.path, e.radiusDeg)).filter((f) => !f.skip);
    return {
      multiplier: block.multiplier,
      targets: es.length,
      avgTime: mean(times),
      hits: shots.filter((s) => s.part === 'head').length,
      shots: shots.length,
      overshootRate: flicks.length ? flicks.filter((f) => f.overshoot).length / flicks.length : 0,
      undershootRate: flicks.length ? flicks.filter((f) => f.undershoot).length / flicks.length : 0,
    };
  }

  result() {
    // 워밍업 타겟은 통계에서 제외
    this.engagements = this.engagements.filter((e) => !e.warm);
    const res = this.baseResult();
    const s = this.settings;
    if (this.finder) {
      const blocks = this.blocks.map((b) => this.blockSummary(b));
      res.recommendation = recommendSensitivity(s.sens, s.dpi, blocks);
    }
    const kills = this.engagements.filter((e) => e.result === 'kill');
    res.stats.avgFlickMs = Math.round(mean(kills.map((e) => (e.endT - e.appearT) * 1000)));
    return res;
  }
}

export const SCENARIOS = {
  strafe: { cls: StrafeScenario, name: '스트레이프 봇 / 듀얼', desc: '봇이 발로란트 속도로 ADAD 하다가 카운터 스트레이프로 멈춤. 듀얼 모드면 멈춘 봇이 반격' },
  peek: { cls: PeekScenario, name: '코너 피킹 (내가 피킹)', desc: '벽 뒤에서 D로 피킹 → 멈춰서 1발. 적은 앵글을 잡고 반응 속도 후 사격' },
  hold: { cls: HoldScenario, name: '앵글 홀드 (적이 피킹)', desc: '와이드 스윙·타이트 피크·숄더 피크·가로지르기에 대응' },
  flick: { cls: FlickScenario, name: '플릭 (헤드 전용)', desc: '무작위 위치의 머리를 빠르게. 오버/언더슈팅 분석' },
  finder: { cls: FlickScenario, opts: { finder: true }, name: '감도 찾기', desc: '감도를 몰래 5단계로 바꿔가며 테스트 → 추천 감도 계산' },
};
