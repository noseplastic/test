import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMatchStats, pickFocus, buildCoachCard, todayTraining, CUES } from '../js/coach.js';
import { buildAdvice } from '../js/analysis.js';

test('every advice key from buildAdvice has an overlay cue', () => {
  const advice = buildAdvice({
    shots: 40, hits: 20, reactionMs: 350, reactionSamples: 5, placementPitch: 2, placementSamples: 5,
    placementLowRate: 0.5, placementYaw: 10, movingShotRate: 0.3, stopMs: 120, stopSamples: 6, counterRate: 0.2,
    overshootRate: 0.5, undershootRate: 0.1, flickSamples: 6, avgCorrections: 2, lagRate: 0.8, leadRate: 0.2,
    headshotRate: 0.2, sprayShotRate: 0.4, engagements: 10, kills: 4, deaths: 6,
  }, { mode: 'peek', edpi: 600 });
  assert.ok(advice.length > 5);
  for (const a of advice) if (a.key) assert.ok(CUES[a.key], `missing cue for ${a.key}`);
});

test('match stats: low HS and first deaths are flagged, empty values skipped', () => {
  const adv = analyzeMatchStats({ hs: 12, leg: 10, fk: 2, fd: 6 });
  assert.deepEqual(adv.map((a) => [a.level, a.key]), [['bad', 'placement-low'], ['warn', 'leg-shots'], ['bad', 'first-death']]);
  assert.deepEqual(analyzeMatchStats({}), []);
  assert.equal(analyzeMatchStats({ hs: 30 })[0].level, 'good');
});

test('focus picks bad before warn, skips good, dedupes cues', () => {
  const focus = pickFocus([
    { from: 'A', date: 2, advice: [{ level: 'warn', title: 'w', key: 'spray' }, { level: 'good', title: 'g', key: 'headshot' }] },
    { from: 'B', date: 1, advice: [{ level: 'bad', title: 'b', key: 'moving-shot' }, { level: 'warn', title: 'w2', key: 'spray' }] },
  ]);
  assert.deepEqual(focus.map((f) => [f.key, f.from]), [['moving-shot', 'B'], ['spray', 'A']]);
});

test('coach card shows a differing sens recommendation and today count', () => {
  const now = new Date(2026, 8, 28, 20, 0).getTime();
  const history = [
    { date: now - 3600e3, modeName: '감도 찾기', sens: 0.4, rec: 0.36 },
    { date: now - 48 * 3600e3, modeName: '플릭', sens: 0.4, rec: null },
  ];
  const card = buildCoachCard({ settings: { sens: 0.4, dpi: 800 }, history, now });
  assert.equal(card.edpi, 320);
  assert.equal(card.rec.sens, 0.36);
  assert.equal(card.warmup, 1);
  assert.ok(card.tips.length > 0);
  assert.equal(buildCoachCard({ settings: { sens: 0.36, dpi: 800 }, history, now }).rec, null);
  assert.equal(todayTraining([], now).count, 0);
});
