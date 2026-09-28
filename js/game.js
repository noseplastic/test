import * as THREE from 'three';
import { VALORANT, HITBOX, WEAPONS, PLAYER_HP } from './config.js';
import { stepVelocity, maxSpeedFor, isAccurate, spreadFor, StopTracker } from './movement.js';

export const DEG = Math.PI / 180;
export const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

function gridTexture(base, line, accent) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = line;
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  if (accent) {
    g.strokeStyle = accent;
    g.lineWidth = 4;
    g.strokeRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ─── 사운드 (WebAudio, 파일 없이 합성) ───
class Sfx {
  constructor() {
    this.ctx = null;
    this.volume = 0.4;
  }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  tone(freq, dur, type = 'sine', gain = 1, slide = 0) {
    const ctx = this.ensure();
    if (!ctx || this.volume <= 0) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    g.gain.setValueAtTime(this.volume * gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  }
  noise(dur, gain = 0.5) {
    const ctx = this.ensure();
    if (!ctx || this.volume <= 0) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2400;
    src.buffer = buf;
    g.gain.value = this.volume * gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  }
  shot() { this.noise(0.09, 0.35); }
  hit() { this.tone(900, 0.06, 'square', 0.25); }
  head() { this.tone(1600, 0.12, 'sine', 0.6, 400); }
  kill() { this.tone(700, 0.15, 'triangle', 0.5, 500); }
  death() { this.tone(160, 0.35, 'sawtooth', 0.4, -100); }
  tick() { this.tone(500, 0.04, 'sine', 0.2); }
}

// ─── 적 봇 ───
export class Bot {
  constructor(game, { weapon = WEAPONS.vandal } = {}) {
    this.game = game;
    this.group = new THREE.Group();
    this.parts = [];
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8394a, roughness: 0.55, emissive: 0x2a0006 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xff5566, roughness: 0.45, emissive: 0x3a0008 });
    const mk = (part, box, x, mat) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), mat);
      mesh.position.set(x, box.y, 0);
      mesh.userData = { part, bot: this };
      this.group.add(mesh);
      this.parts.push(mesh);
    };
    mk('head', HITBOX.head, 0, headMat);
    mk('body', HITBOX.body, 0, bodyMat);
    const lx = HITBOX.leg.w / 2 + HITBOX.leg.gap / 2;
    mk('leg', HITBOX.leg, -lx, bodyMat);
    mk('leg', HITBOX.leg, lx, bodyMat);
    this.materials = [bodyMat, headMat];
    this.pedestal = null;

    this.pos = { x: 0, z: 0 };
    this.elev = 0;
    this.vel = { x: 0, z: 0 };
    this.maxSpeed = maxSpeedFor(weapon, false);
    this.hp = PLAYER_HP;
    this.alive = true;
    this.angYaw = NaN;
    this.angRate = 0;
    game.scene.add(this.group);
  }

  place(x, z, elev = 0) {
    this.pos = { x, z };
    this.vel = { x: 0, z: 0 };
    this.hp = PLAYER_HP;
    this.alive = true;
    this.angYaw = NaN;
    this.angRate = 0;
    this.setElevation(elev);
    this.group.visible = true;
    this.sync();
  }

  setElevation(elev) {
    this.elev = elev;
    if (this.pedestal) {
      this.group.remove(this.pedestal);
      this.pedestal.geometry.dispose();
      this.pedestal = null;
    }
    if (elev > 0.01) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, elev, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x5a6378, roughness: 0.9 }),
      );
      m.position.y = -elev / 2;
      this.pedestal = m;
      this.group.add(m);
    }
  }

  move(dt, wish) {
    this.vel = stepVelocity(this.vel, wish, this.maxSpeed, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  sync() {
    this.group.position.set(this.pos.x, this.elev, this.pos.z);
    const cam = this.game.camera.position;
    this.group.rotation.y = Math.atan2(cam.x - this.pos.x, cam.z - this.pos.z);
  }

  headPoint() {
    return new THREE.Vector3(this.pos.x, this.elev + HITBOX.head.y, this.pos.z);
  }

  // 시야 판정용 샘플 지점들 (머리, 몸 중앙, 양 어깨, 무릎)
  samplePoints() {
    const cam = this.game.camera.position;
    const dx = cam.x - this.pos.x, dz = cam.z - this.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = -dz / len, sz = dx / len;
    const e = this.elev;
    const sh = HITBOX.body.w / 2 - 0.04;
    const P = (ox, y) => new THREE.Vector3(this.pos.x + sx * ox, e + y, this.pos.z + sz * ox);
    return [
      P(0, HITBOX.head.y), P(0, HITBOX.body.y), P(sh, HITBOX.body.y + 0.2), P(-sh, HITBOX.body.y + 0.2),
      P(0.1, 0.45), P(-0.1, 0.45),
    ];
  }

  setVisible(v) {
    this.group.visible = v;
  }

  flash() {
    for (const m of this.materials) m.emissive.setHex(0xffffff);
    setTimeout(() => {
      this.materials[0].emissive.setHex(0x2a0006);
      this.materials[1].emissive.setHex(0x3a0008);
    }, 50);
  }

  dispose() {
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}

export const DEFAULT_SETTINGS = {
  sens: 0.35,
  dpi: 800,
  vertMult: 1.0,
  calib: 1.0,
  rawInput: true,
  weapon: 'vandal',
  difficulty: 'normal',
  distance: '15',
  strafeProfile: 'normal',
  strafeStops: 'normal',
  strafeDuel: true,
  duration: 60,
  rounds: 20,
  flickTargets: 30,
  crossColor: '#00ff9c',
  crossSize: 6,
  crossGap: 3,
  crossDot: true,
  speedGraph: true,
  volume: 0.4,
};

// ─── 게임 엔진 ───
export class Game {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.settings = { ...DEFAULT_SETTINGS };
    this.sfx = new Sfx();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.raycaster = new THREE.Raycaster();

    this.walls = [];
    this.wallMeshes = [];
    this.bots = [];
    this.decals = [];
    this.textures = {
      floor: gridTexture('#2b3040', '#3a4156', '#454e68'),
      wall: gridTexture('#6d7486', '#7d8598', '#8a92a6'),
      crate: gridTexture('#8b6f4e', '#9b7f5e', '#6b5236'),
    };

    this.player = {
      pos: new THREE.Vector3(),
      vel: { x: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      canMove: true,
      bounds: null,
      hp: PLAYER_HP,
    };
    this.keys = new Set();
    this.mouseDown = false;
    this.sensMultiplier = 1;
    this.time = 0;
    this.running = false;
    this.paused = false;
    this.locked = false;
    this.lockTime = 0;
    this.rawActive = false;
    this.scenario = null;
    this.lastShotT = -10;
    this.nextFireT = 0;
    this.sprayIndex = 0;
    this.lastFrame = performance.now();
    this.fps = 0;
    this.stopTracker = new StopTracker();
    this.stopEvents = [];

    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get weapon() {
    return WEAPONS[this.settings.weapon] || WEAPONS.vandal;
  }

  // 발로란트 수평 FOV 103° 를 유지하도록 수직 FOV 계산
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    const hfov = VALORANT.HFOV_DEG * DEG;
    this.camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / aspect)) / DEG;
    this.camera.updateProjectionMatrix();
  }

  // ─── 입력 ───
  bindInput() {
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove';
    document.addEventListener(moveEvent, (e) => this.onMouseMove(e));
    document.addEventListener('mousedown', (e) => {
      if (!this.running || this.paused || !this.locked) return;
      if (e.button === 0) {
        this.mouseDown = true;
        this.tryFire();
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    document.addEventListener('keydown', (e) => {
      if (!this.running) return;
      this.keys.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.lockTime = performance.now();
      this.hooks.onLockChange?.(this.locked);
      if (!this.locked && this.running && !this.paused) {
        this.paused = true;
        this.keys.clear();
        this.mouseDown = false;
        this.hooks.onPause?.();
      }
    });
  }

  async lock() {
    this.sfx.ensure();
    try {
      if (this.settings.rawInput) {
        await this.canvas.requestPointerLock({ unadjustedMovement: true });
        this.rawActive = true;
        return true;
      }
    } catch (err) {
      // 원시 입력 미지원 브라우저 → 일반 포인터 락
    }
    try {
      await this.canvas.requestPointerLock();
      this.rawActive = false;
      return true;
    } catch {
      return false;
    }
  }

  onMouseMove(e) {
    if (!this.locked || !this.running || this.paused) return;
    // 포인터 락 직후 튀는 값 무시 (일부 브라우저 버그)
    if (performance.now() - this.lockTime < 80) return;
    const mx = e.movementX, my = e.movementY;
    if (Math.abs(mx) > 20000 || Math.abs(my) > 20000) return;
    const k = VALORANT.YAW_DEG_PER_COUNT * this.settings.sens * this.sensMultiplier * this.settings.calib * DEG;
    const p = this.player;
    p.yaw -= mx * k;
    p.pitch -= my * k * this.settings.vertMult;
    const lim = 89 * DEG;
    p.pitch = Math.max(-lim, Math.min(lim, p.pitch));
    this.camera.rotation.set(p.pitch, p.yaw, 0);
  }

  // 프레임 사이 이벤트 시각까지 반영한 게임 시간
  now() {
    if (!this.running || this.paused) return this.time;
    return this.time + Math.min(0.05, (performance.now() - this.lastFrame) / 1000);
  }

  // ─── 월드 구성 ───
  clearWorld() {
    for (const b of this.bots) b.dispose();
    this.bots = [];
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
    }
    this.decals = [];
    while (this.scene.children.length) {
      const o = this.scene.children[0];
      this.scene.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material) o.material.dispose();
    }
    this.walls = [];
    this.wallMeshes = [];

    this.scene.background = new THREE.Color(0x9fb4c8);
    this.scene.fog = new THREE.Fog(0x9fb4c8, 60, 220);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f4a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    const floorTex = this.textures.floor.clone();
    floorTex.needsUpdate = true;
    floorTex.repeat.set(200, 200);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.wallMeshes.push(floor);
  }

  // x1..x2, y1..y2, z1..z2 범위의 박스 (벽/상자). solid 이면 이동·시야를 막는다.
  addBox(x1, x2, y1, y2, z1, z2, { kind = 'wall', solid = true } = {}) {
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1), d = Math.abs(z2 - z1);
    const tex = this.textures[kind === 'crate' ? 'crate' : 'wall'].clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(w, d), h);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
    );
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    this.scene.add(mesh);
    if (solid) {
      this.wallMeshes.push(mesh);
      this.walls.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), z1: Math.min(z1, z2), z2: Math.max(z1, z2), y1: Math.min(y1, y2) });
    }
    return mesh;
  }

  spawnBot() {
    const b = new Bot(this, { weapon: this.weapon });
    this.bots.push(b);
    return b;
  }

  setPlayer(x, z, yawDeg = null, pitchDeg = null) {
    const p = this.player;
    p.pos.set(x, 0, z);
    p.vel = { x: 0, z: 0 };
    if (yawDeg !== null) p.yaw = yawDeg * DEG;
    if (pitchDeg !== null) p.pitch = pitchDeg * DEG;
    this.syncCamera();
  }

  syncCamera() {
    const p = this.player;
    this.camera.position.set(p.pos.x, VALORANT.EYE_HEIGHT, p.pos.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0);
  }

  // ─── 조준/시야 계산 ───
  aimError(point) {
    const c = this.camera.position;
    const dx = point.x - c.x, dy = point.y - c.y, dz = point.z - c.z;
    const ty = Math.atan2(-dx, -dz) / DEG;
    const tp = Math.atan2(dy, Math.hypot(dx, dz)) / DEG;
    return {
      ex: wrapDeg(ty - this.player.yaw / DEG),
      ey: tp - this.player.pitch / DEG,
      yaw: ty,
      dist: Math.hypot(dx, dy, dz),
    };
  }

  headRadiusDeg(bot) {
    const d = bot.headPoint().distanceTo(this.camera.position);
    return Math.atan((HITBOX.head.w / 2) / Math.max(0.5, d)) / DEG;
  }

  // 봇의 좌우 각속도 추적 (트래킹 분석용)
  trackBot(bot, dt) {
    const e = this.aimError(bot.headPoint());
    if (Number.isFinite(bot.angYaw) && dt > 0) {
      const rate = wrapDeg(e.yaw - bot.angYaw) / dt;
      bot.angRate = bot.angRate * 0.6 + rate * 0.4;
    }
    bot.angYaw = e.yaw;
    return e;
  }

  hasLOS(a, b) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const dist = dir.length();
    if (dist < 1e-3) return true;
    dir.divideScalar(dist);
    this.raycaster.set(a, dir);
    this.raycaster.near = 0;
    this.raycaster.far = dist - 0.02;
    return this.raycaster.intersectObjects(this.wallMeshes, false).length === 0;
  }

  // 플레이어가 봇을 볼 수 있는지 (신체 일부라도)
  canSeeBot(bot) {
    if (!bot.alive || !bot.group.visible) return false;
    const eye = this.camera.position.clone();
    return bot.samplePoints().some((pt) => this.hasLOS(eye, pt));
  }

  // 봇이 플레이어를 볼 수 있는지 (플레이어 머리/몸/어깨)
  botCanSeePlayer(bot) {
    if (!bot.alive) return false;
    const eye = bot.headPoint();
    const p = this.player.pos;
    const dx = eye.x - p.x, dz = eye.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = -dz / len, sz = dx / len;
    const pts = [
      new THREE.Vector3(p.x, VALORANT.EYE_HEIGHT, p.z),
      new THREE.Vector3(p.x, 1.2, p.z),
      new THREE.Vector3(p.x + sx * 0.25, 1.35, p.z + sz * 0.25),
      new THREE.Vector3(p.x - sx * 0.25, 1.35, p.z - sz * 0.25),
    ];
    return pts.some((pt) => this.hasLOS(eye, pt));
  }

  // ─── 사격 ───
  tryFire() {
    const t = this.now();
    if (t < this.nextFireT) return;
    this.nextFireT = t + 1 / this.weapon.fireRate;
    this.fire(t);
  }

  fire(t) {
    const w = this.weapon;
    const p = this.player;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    this.sprayIndex = t - this.lastShotT < 0.3 ? this.sprayIndex + 1 : 0;
    this.lastShotT = t;
    const spread = spreadFor(w, speed, this.sprayIndex);
    const r = spread * Math.sqrt(Math.random());
    const th = Math.random() * Math.PI * 2;
    const euler = new THREE.Euler(p.pitch + r * Math.sin(th) * DEG, p.yaw + r * Math.cos(th) * DEG, 0, 'YXZ');
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(euler);

    this.raycaster.set(this.camera.position, dir);
    this.raycaster.near = 0;
    this.raycaster.far = 400;
    const targets = [...this.wallMeshes];
    for (const b of this.bots) if (b.alive && b.group.visible) targets.push(...b.parts);
    const hit = this.raycaster.intersectObjects(targets, false)[0];

    let part = null, bot = null;
    if (hit && hit.object.userData.part) {
      part = hit.object.userData.part;
      bot = hit.object.userData.bot;
    }
    if (hit) this.addDecal(hit.point, !!bot);
    this.sfx.shot();

    const shot = {
      t, part, bot, speed, spread,
      moving: !isAccurate(speed, w),
      spray: this.sprayIndex,
    };
    this.scenario?.onShot(shot);
    this.hooks.onShot?.(shot);
  }

  // 데미지 적용. 반환값: 킬 여부
  applyDamage(bot, part) {
    const idx = part === 'head' ? 0 : part === 'body' ? 1 : 2;
    bot.hp -= this.weapon.damage[idx];
    bot.flash();
    if (bot.hp <= 0) {
      bot.alive = false;
      bot.setVisible(false);
      this.sfx.kill();
      return true;
    }
    if (part === 'head') this.sfx.head();
    else this.sfx.hit();
    return false;
  }

  playerDie() {
    this.sfx.death();
    this.hooks.onDeath?.();
  }

  addDecal(point, onBot) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(onBot ? 0.03 : 0.04, 6, 6),
      new THREE.MeshBasicMaterial({ color: onBot ? 0xffffff : 0x111111, transparent: true }),
    );
    mesh.position.copy(point);
    this.scene.add(mesh);
    this.decals.push({ mesh, life: 2.0 });
    if (this.decals.length > 60) {
      const d = this.decals.shift();
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
    }
  }

  // ─── 게임 진행 ───
  start(scenario) {
    this.scenario = scenario;
    this.sensMultiplier = 1;
    this.time = 0;
    this.sprayIndex = 0;
    this.lastShotT = -10;
    this.nextFireT = 0;
    this.keys.clear();
    this.mouseDown = false;
    this.stopTracker = new StopTracker();
    this.stopEvents = [];
    this.clearWorld();
    this.player.bounds = null;
    this.player.canMove = true;
    scenario.setup();
    this.syncCamera();
    this.running = true;
    this.paused = false;
    this.lastFrame = performance.now();
  }

  resume() {
    this.paused = false;
    this.lastFrame = performance.now();
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    this.paused = false;
    this.sensMultiplier = 1;
    this.mouseDown = false;
    if (document.pointerLockElement) document.exitPointerLock();
    const result = this.scenario?.result();
    this.hooks.onEnd?.(result);
  }

  abort() {
    this.running = false;
    this.paused = false;
    this.sensMultiplier = 1;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  frame() {
    const nowMs = performance.now();
    let dt = (nowMs - this.lastFrame) / 1000;
    this.lastFrame = nowMs;
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    dt = Math.min(dt, 0.05);
    if (this.running && !this.paused) this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    this.time += dt;
    const p = this.player;
    const w = this.weapon;
    const walking = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const max = maxSpeedFor(w, walking);

    let ix = 0, iz = 0;
    if (p.canMove) {
      if (this.keys.has('KeyW')) iz += 1;
      if (this.keys.has('KeyS')) iz -= 1;
      if (this.keys.has('KeyD')) ix += 1;
      if (this.keys.has('KeyA')) ix -= 1;
    }
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    let wx = rx * ix + fx * iz, wz = rz * ix + fz * iz;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx = (wx / wl) * max; wz = (wz / wl) * max; }
    const opposing = wx * p.vel.x + wz * p.vel.z < 0;
    p.vel = stepVelocity(p.vel, { x: wx, z: wz }, max, dt);
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    if (this.collidePlayer()) this.stopTracker.cancel();
    this.syncCamera();

    this.scenario?.update(dt);
    for (const b of this.bots) b.sync();

    if (this.mouseDown && this.locked) this.tryFire();

    for (const d of this.decals) {
      d.life -= dt;
      d.mesh.material.opacity = Math.max(0, Math.min(1, d.life));
    }

    const speed = Math.hypot(p.vel.x, p.vel.z);
    const runSpeed = maxSpeedFor(w, false);
    const threshold = runSpeed * VALORANT.ACCURATE_SPEED_RATIO;
    const stop = this.stopTracker.update(this.time, speed, runSpeed, threshold, opposing);
    if (stop) {
      this.stopEvents.push(stop);
      this.hooks.onStop?.(stop);
    }
    const bot = this.bots.find((b) => b.alive && b.group.visible);
    this.hooks.onHud?.({
      speed,
      botSpeed: bot ? bot.speed : NaN,
      accurate: isAccurate(speed, w),
      threshold,
      runSpeed,
      yaw: ((-p.yaw / DEG) % 360 + 360) % 360,
      pitch: p.pitch / DEG,
      scenario: this.scenario?.hud(),
      fps: this.fps,
    });

    if (this.scenario?.over) this.finish();
  }

  collidePlayer() {
    const p = this.player;
    const r = VALORANT.PLAYER_RADIUS;
    // 벽이나 이동 범위에 막혀 속도가 깎였으면 true 를 돌려준다
    let blocked = false;
    for (const w of this.walls) {
      if (w.y1 > 1.0) continue;
      const cx = Math.max(w.x1, Math.min(p.pos.x, w.x2));
      const cz = Math.max(w.z1, Math.min(p.pos.z, w.z2));
      const dx = p.pos.x - cx, dz = p.pos.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < r) {
        if (d > 1e-6) {
          const push = (r - d) / d;
          p.pos.x += dx * push;
          p.pos.z += dz * push;
          // 벽 방향 속도 성분 제거
          const nx = dx / d, nz = dz / d;
          const vn = p.vel.x * nx + p.vel.z * nz;
          if (vn < 0) { p.vel.x -= vn * nx; p.vel.z -= vn * nz; blocked = true; }
        } else {
          p.pos.z = w.z2 + r;
        }
      }
    }
    const b = p.bounds;
    if (b) {
      if (p.pos.x < b.x1) { p.pos.x = b.x1; if (p.vel.x < 0) blocked = true; p.vel.x = Math.max(0, p.vel.x); }
      if (p.pos.x > b.x2) { p.pos.x = b.x2; if (p.vel.x > 0) blocked = true; p.vel.x = Math.min(0, p.vel.x); }
      if (p.pos.z < b.z1) { p.pos.z = b.z1; if (p.vel.z < 0) blocked = true; p.vel.z = Math.max(0, p.vel.z); }
      if (p.pos.z > b.z2) { p.pos.z = b.z2; if (p.vel.z > 0) blocked = true; p.vel.z = Math.min(0, p.vel.z); }
    }
    return blocked;
  }
}
