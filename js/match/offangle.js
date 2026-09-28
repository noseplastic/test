// offangle.pro 리포트와 비교 (같은 리플레이 해석기를 쓰는 서비스 → 정답지로 사용)
// 리포트 페이지의 SvelteKit 데이터(__data.json)를 읽어 우리 분석과 나란히 놓는다.

// 매치 링크 → 데이터 주소
export function offangleDataUrl(link) {
  const u = new URL(link);
  const m = u.pathname.match(/\/match\/([0-9a-f-]{36})/i);
  if (!/offangle\.pro$/i.test(u.hostname) || !m) throw new Error('offangle 매치 링크가 아닙니다');
  return {
    url: `https://offangle.pro/match/${m[1]}/__data.json?tab=general`,
    matchId: m[1],
    playerId: u.searchParams.get('player'),
  };
}

// SvelteKit(devalue) 평탄화 데이터 → 객체
export function unflatten(values) {
  const cache = new Map();
  const special = { '-1': undefined, '-2': undefined, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 };
  const h = (i) => {
    if (i < 0) return special[i];
    if (cache.has(i)) return cache.get(i);
    const v = values[i];
    if (v === null || typeof v !== 'object') { cache.set(i, v); return v; }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        if (v[0] === 'Date') return new Date(v[1]);
        if (v[0] === 'Set') { const s = new Set(); cache.set(i, s); for (let k = 1; k < v.length; k++) s.add(h(v[k])); return s; }
        if (v[0] === 'Map') { const m = new Map(); cache.set(i, m); for (let k = 1; k < v.length; k += 2) m.set(h(v[k]), h(v[k + 1])); return m; }
      }
      const a = [];
      cache.set(i, a);
      for (const x of v) a.push(h(x));
      return a;
    }
    const o = {};
    cache.set(i, o);
    for (const [k, x] of Object.entries(v)) o[k] = h(x);
    return o;
  };
  return h(0);
}

export function parseOffangleData(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  const node = (raw.nodes || []).find((n) => n && n.type === 'data' && Array.isArray(n.data));
  if (!node) throw new Error('offangle 데이터 형식을 알 수 없습니다');
  return unflatten(node.data);
}

const REGION = { Head: 'head', Torso: 'body', Arms: 'body', Legs: 'leg', Feet: 'leg' };

/**
 * 우리 분석(res, model)과 offangle 리포트(root)를 비교.
 * playerId = 리플레이의 Subject(PUUID). 표 행: { label, ours, theirs, note }
 */
export function compareWithOffangle(root, model, res, me) {
  const subject = model.players.get(me)?.subject;
  const them = root.players.find((p) => p.playerId === subject);
  if (!them) return { error: 'offangle 리포트에서 같은 플레이어를 찾지 못했습니다 (다른 경기일 수 있음)' };

  // 팀: offangle 의 팀 구분과 우리 적 추정이 맞는지
  const bySubject = new Map([...model.players.values()].map((p) => [p.subject, p.ps]));
  const enemySet = new Set(res.diagnostics.enemies);
  let teamOk = 0, teamN = 0;
  for (const p of root.players) {
    if (p.playerId === subject) continue;
    const ps = bySubject.get(p.playerId);
    if (ps === undefined) continue;
    teamN++;
    if ((p.team !== them.team) === enemySet.has(ps)) teamOk++;
  }

  // 명중 부위 분포
  const regions = { head: 0, body: 0, leg: 0 };
  for (const b of them.enemySpottedBreakdown || []) {
    if (b.firingPattern !== null) continue; // 무기별 합계 행만
    for (const [k, n] of Object.entries(b.damageRegions || {})) if (REGION[k]) regions[REGION[k]] += n;
  }
  const theirHits = regions.head + regions.body + regions.leg;
  const ourShots = res.engagements.flatMap((e) => e.shots);
  const ourHits = ourShots.filter((s) => s.part);
  const ourHead = ourHits.filter((s) => s.part === 'head').length;

  const st = res.stats;
  const m = them.metrics || {};
  const move = (them.deadzoneBreakdown || []).reduce((a, b) => ({ n: a.n + b.eligibleShots, v: a.v + b.movementViolationShots }), { n: 0, v: 0 });
  const rows = [
    { label: '킬 / 데스', ours: `${st.killsTotal} / ${st.deathsTotal}`, theirs: `${them.scoreboard.kills} / ${them.scoreboard.deaths}`, note: '같아야 정상' },
    { label: '팀 구분 (적/아군)', ours: teamN ? `${teamOk}/${teamN} 일치` : '-', theirs: '기준', note: '틀리면 교전 대상이 틀림' },
    {
      label: '크로스헤어 배치 (중앙값)',
      ours: Number.isFinite(st.placementPitch) ? `${Math.hypot(st.placementPitch, st.placementYaw).toFixed(1)}° (상하 ${st.placementPitch.toFixed(1)} · 좌우 ${st.placementYaw.toFixed(1)})` : '-',
      theirs: Number.isFinite(m.crosshairPlacement?.medianDegrees) ? `${m.crosshairPlacement.medianDegrees.toFixed(1)}° (${m.crosshairPlacement.measured}교전)` : '-',
      note: res.diagnostics.map ? '보인 순간 기준' : '우리는 맵 없이 반응 시작 기준이라 정의가 다름',
    },
    {
      label: '첫 데미지까지 (평균)',
      ours: Number.isFinite(st.reactionMs) ? `${Math.round(st.reactionMs)}ms (첫 발, 중앙값)` : '-',
      theirs: Number.isFinite(m.timeToDamage?.averageSeconds) ? `${Math.round(m.timeToDamage.averageSeconds * 1000)}ms` : '-',
      note: '보인 순간이 필요 (맵)',
    },
    {
      label: '킬까지 (평균)',
      ours: '-',
      theirs: Number.isFinite(m.timeToKill?.averageSeconds) ? `${Math.round(m.timeToKill.averageSeconds * 1000)}ms` : '-',
      note: '',
    },
    {
      label: '소총 첫 발 명중률',
      ours: Number.isFinite(st.firstShotAcc) ? `${Math.round(st.firstShotAcc * 100)}% (${st.firstShotSamples}발)` : '-',
      theirs: them.overview?.rifleFirstShot ? `${Math.round(them.overview.rifleFirstShot.accuracy * 100)}% (${them.overview.rifleFirstShot.eligibleShots}발)` : '-',
      note: 'offangle 은 적이 보일 때 쏜 첫 발만',
    },
    {
      label: '명중률',
      ours: ourShots.length ? `${Math.round((ourHits.length / ourShots.length) * 100)}% (${ourHits.length}/${ourShots.length})` : '-',
      theirs: them.overview ? `${Math.round(them.overview.enemySpottedAccuracy * 100)}% (${them.overview.enemySpottedHits}/${them.overview.enemySpottedShots})` : '-',
      note: 'offangle 은 적이 보일 때 쏜 샷만',
    },
    {
      label: '헤드 비율 (맞힌 것 중)',
      ours: ourHits.length ? `${Math.round((ourHead / ourHits.length) * 100)}%` : '-',
      theirs: theirHits ? `${Math.round((regions.head / theirHits) * 100)}%` : '-',
      note: '',
    },
    {
      label: '멈춰서 쏜 비율',
      ours: Number.isFinite(st.movingShotRate) ? `${Math.round((1 - st.movingShotRate) * 100)}%` : '-',
      theirs: move.n ? `${Math.round(((move.n - move.v) / move.n) * 100)}% (${move.n}발)` : '-',
      note: '',
    },
  ];

  // 상대별 전적
  const opp = (root.duels || []).filter((d) => d.playerId === subject).map((d) => {
    const p = root.players.find((x) => x.playerId === d.opponentId);
    const ps = bySubject.get(d.opponentId);
    const ourK = model.damage.filter((x) => x.attackerPs === me && x.victimPs === ps && x.killed).length;
    const ourD = model.damage.filter((x) => x.attackerPs === ps && x.victimPs === me && x.killed).length;
    return { agent: p?.character || '?', theirs: `${d.kills}–${d.deaths}`, ours: `${ourK}–${ourD}` };
  });

  return { rows, opponents: opp, player: `${them.character} · ${them.apiCompetitiveTierName || ''}`, map: root.match?.mapId };
}
