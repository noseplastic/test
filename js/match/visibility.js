// "적이 내 화면에 처음 보인 순간" 계산: 맵 충돌 모델(삼각형) + 연막 + 시야각.
//
// 맵 파일 형식 (로컬에서만 만들어 쓰고 저장소에 올리지 않는다 — Riot 저작물):
// { name, units: 'cm', triangles: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...] }  (언리얼 월드 좌표, Z 위)
//
// 리플레이 좌표와 같은 좌표계여야 한다. 검증: 모든 플레이어 위치가 바닥 삼각형 바로 위에 있어야 함 (checkMapFit).

const RAD = Math.PI / 180;

// ─── 삼각형 BVH (광선이 막히는지만 빠르게 판정) ───
export class TriangleBVH {
  constructor(triangles) {
    const tri = triangles instanceof Float32Array ? triangles : Float32Array.from(triangles);
    this.tri = tri;
    const n = tri.length / 9;
    this.count = n;
    const idx = new Uint32Array(n);
    const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      idx[i] = i;
      const o = i * 9;
      cx[i] = (tri[o] + tri[o + 3] + tri[o + 6]) / 3;
      cy[i] = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
      cz[i] = (tri[o + 2] + tri[o + 5] + tri[o + 8]) / 3;
    }
    this.idx = idx;
    this.nodes = [];
    if (n) this.build(0, n, [cx, cy, cz]);
  }

  bounds(start, end) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const o = this.idx[i] * 9;
      for (let v = 0; v < 9; v += 3) {
        for (let a = 0; a < 3; a++) {
          const x = this.tri[o + v + a];
          if (x < b[a]) b[a] = x;
          if (x > b[a + 3]) b[a + 3] = x;
        }
      }
    }
    return b;
  }

  build(start, end, cen) {
    const node = { box: this.bounds(start, end), start, end, left: -1, right: -1 };
    const id = this.nodes.length;
    this.nodes.push(node);
    if (end - start <= 8) return id;
    const b = node.box;
    const axis = [b[3] - b[0], b[4] - b[1], b[5] - b[2]].reduce((m, v, i, arr) => (v > arr[m] ? i : m), 0);
    const c = cen[axis];
    // 중앙값 기준 분할
    const sub = Array.from(this.idx.subarray(start, end)).sort((p, q) => c[p] - c[q]);
    this.idx.set(sub, start);
    const mid = (start + end) >> 1;
    node.left = this.build(start, mid, cen);
    node.right = this.build(mid, end, cen);
    return id;
  }

  // a → b 선분이 삼각형에 막히는지
  blocked(a, b) {
    if (!this.count) return false;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const inv = [1 / dx, 1 / dy, 1 / dz];
    const stack = [0];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (!rayBox(a, inv, node.box)) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.end; i++) {
          if (segTri(a, dx, dy, dz, this.tri, this.idx[i] * 9)) return true;
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return false;
  }
}

// 선분(0~1)과 AABB 교차
function rayBox(o, inv, b) {
  let t0 = 0, t1 = 1;
  const oo = [o.x, o.y, o.z];
  for (let a = 0; a < 3; a++) {
    let tn = (b[a] - oo[a]) * inv[a];
    let tf = (b[a + 3] - oo[a]) * inv[a];
    if (Number.isNaN(tn) || Number.isNaN(tf)) { if (oo[a] < b[a] || oo[a] > b[a + 3]) return false; continue; }
    if (tn > tf) { const s = tn; tn = tf; tf = s; }
    if (tn > t0) t0 = tn;
    if (tf < t1) t1 = tf;
    if (t0 > t1) return false;
  }
  return true;
}

// Möller–Trumbore, 선분 내부(1e-4 ~ 1-1e-4)에서만
function segTri(o, dx, dy, dz, T, k) {
  const e1x = T[k + 3] - T[k], e1y = T[k + 4] - T[k + 1], e1z = T[k + 5] - T[k + 2];
  const e2x = T[k + 6] - T[k], e2y = T[k + 7] - T[k + 1], e2z = T[k + 8] - T[k + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const sx = o.x - T[k], sy = o.y - T[k + 1], sz = o.z - T[k + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-4 && t < 1 - 1e-4;
}

// 선분이 구(연막)를 지나는지. 둘 중 한 명이 연막 안에 있으면 막힌 것으로 본다
export function segmentHitsSphere(a, b, c, r) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz || 1e-9;
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy + (c.z - a.z) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + dx * t - c.x, py = a.y + dy * t - c.y, pz = a.z + dz * t - c.z;
  return px * px + py * py + pz * pz <= r * r;
}

// 화면 안(수평 FOV 103°, 16:9)인지. ex/ey: 크로스헤어 기준 각도 오차
export function onScreen(ex, ey, hfov = 103, aspect = 16 / 9) {
  if (Math.abs(ex) >= 90) return false;
  const th = Math.tan((hfov / 2) * RAD);
  const tv = th / aspect;
  // 카메라 공간: 앞 = cos(ey)cos(ex), 오른쪽 = cos(ey)sin(ex), 위 = sin(ey) → 투영 평면 좌표
  const x = Math.tan(ex * RAD);
  const y = Math.tan(ey * RAD) / Math.cos(ex * RAD);
  return Math.abs(x) <= th && Math.abs(y) <= tv;
}

// 적 몸에서 보이는지 확인할 지점 (머리 기준 아래로 cm)
export const BODY_POINTS = [0, -35, -75];

/**
 * 한 순간에 적이 보이는지.
 * eye: 내 눈 위치, head: 적 머리 위치, err: (eye 에서 head 방향 - 내 시야) 각도 오차 fn(point) → { ex, ey }
 */
export function isVisible({ bvh, smokes = [], eye, head, errOf, t }) {
  const activeSmokes = smokes.filter((s) => t >= s.t0 && t <= s.t1);
  for (const dz of BODY_POINTS) {
    const p = { x: head.x, y: head.y, z: head.z + dz };
    const e = errOf(p);
    if (!e || !onScreen(e.ex, e.ey)) continue;
    if (bvh && bvh.blocked(eye, p)) continue;
    if (activeSmokes.some((s) => segmentHitsSphere(eye, p, s, s.r))) continue;
    return true;
  }
  return false;
}

/**
 * 맵이 리플레이 좌표와 맞는지: 플레이어 위치 바로 아래(발밑 300cm 이내)에 바닥이 있는 비율
 */
export function checkMapFit(bvh, positions, footZ = -150) {
  let ok = 0, n = 0;
  for (const p of positions) {
    n++;
    if (bvh.blocked({ x: p.x, y: p.y, z: p.z }, { x: p.x, y: p.y, z: p.z + footZ - 300 })) ok++;
  }
  return n ? ok / n : NaN;
}

export function loadMap(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  if (!m || !Array.isArray(m.triangles) || m.triangles.length % 9) throw new Error('맵 파일 형식이 아닙니다 (triangles 배열 필요)');
  return { name: m.name || '맵', bvh: new TriangleBVH(m.triangles) };
}
