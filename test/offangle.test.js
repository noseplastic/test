import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unflatten, parseOffangleData, offangleDataUrl, compareWithOffangle } from '../js/match/offangle.js';
import { buildReplayModel, analyzeReplay, parseNdjson } from '../js/match/replay.js';
import { fakeReplay } from './fixtures/fake-replay.js';

test('devalue unflatten resolves shared references and arrays', () => {
  const root = unflatten([{ a: 1, b: 2, c: 1 }, 'x', [3, 4], 5, 6]);
  assert.deepEqual(root, { a: 'x', b: [5, 6], c: 'x' });
  assert.throws(() => offangleDataUrl('https://example.com/match/x'));
  assert.equal(offangleDataUrl('https://offangle.pro/match/17fe8afd-d68d-4ec3-bcac-2d88cb58b90f?player=abc').playerId, 'abc');
});

test('comparison matches players by PUUID and checks teams and kills', () => {
  const r = fakeReplay();
  const model = buildReplayModel(parseNdjson(r.events), parseNdjson(r.movement));
  const res = analyzeReplay(model, 100);
  const player = (id, team, character, k, d) => ({
    playerId: id, team, character, scoreboard: { kills: k, deaths: d }, metrics: {}, overview: null, enemySpottedBreakdown: [], deadzoneBreakdown: [],
  });
  const data = {
    match: { mapId: 'Test' },
    players: [player('puuid-100', 'Blue', 'Jett', 3, 1), player('puuid-300', 'Blue', 'Sage', 0, 0), player('puuid-200', 'Red', 'Raze', 0, 3), player('puuid-400', 'Red', 'Reyna', 1, 0)],
    duels: [{ playerId: 'puuid-100', opponentId: 'puuid-200', kills: 3, deaths: 0 }],
  };
  // devalue 형식으로 감싸기 (평탄화 없이 루트 하나만: 값은 인덱스가 아닌 그대로 → 문자열화 후 재구성)
  const flat = [];
  const put = (v) => {
    const i = flat.length;
    flat.push(null);
    if (v === null || typeof v !== 'object') flat[i] = v;
    else if (Array.isArray(v)) flat[i] = v.map(put);
    else flat[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]));
    return i;
  };
  put(data);
  const root = parseOffangleData({ type: 'data', nodes: [null, { type: 'data', data: flat }] });
  const c = compareWithOffangle(root, model, res, 100);
  assert.equal(c.rows[0].ours, '3 / 1');
  assert.equal(c.rows[0].theirs, '3 / 1');
  assert.equal(c.rows[1].ours, '3/3 일치');
  assert.deepEqual(c.opponents, [{ agent: 'Raze', theirs: '3–0', ours: '3–0' }]);
});
