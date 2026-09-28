# 발로 에임 코치 — 작업 메모 (Claude 용)

발로란트 에임 트레이너 + 실전 에임 분석 도구. UI·주석은 한국어. 테스트: `npm test`, 단일 HTML 빌드: `npm run build`.

## 구성
- 트레이너(브라우저/Electron): `js/game.js`, `js/scenarios.js`, 분석 `js/analysis.js`, 감도 `js/sens.js`
- 오버레이 코치 카드: `js/coach.js`, `overlay.html`, `desktop/main.cjs`(항상 위·클릭 통과 창, 트레이, 단축키)
- 실전 분석 (주력): **리플레이(.vrf)** → ValorantReplayParser(MIT, .NET 10, CI 에서 win-x64 로 빌드해 앱에 포함) NDJSON
  → `js/match/replay.js` (교전 재구성·지표) + `js/match/visibility.js` (맵 충돌 모델로 "적이 보인 순간", 맵은 로컬 추출 전용)
- 정답지 비교: `js/match/offangle.js` — offangle.pro 도 같은 파서 사용. `https://offangle.pro/match/<id>/__data.json?tab=general`
  (SvelteKit devalue 형식)에 선수별 팀·K/D·배치·TTD/TTK·명중·상대별 전적이 있음. PUUID(=리플레이 Subject)로 매칭
- 입력 기록+영상 엔진 `js/match/engine.js`, 트레이너 기반 검증 `js/match/validate.js` (현재 보류, 리플레이가 주력)

## 파서 출력에서 알아낸 것 (13.06)
- 데미지·킬은 `rpc_received` (DamageableComponent:MulticastNotifyDamage_*, ShooterCharacter:MulticastNotifyKilledEnemy)
- 이동은 `remote_character_movement` — 여러 move 가 같은 time_ms 로 묶여 옴 (spreadBatches 로 분산), 간격 ~8ms
- 발사 `valorant_shot_received` 의 location/rotation 은 조준 방향 (이동 기록 시야와 0.29° 이내 일치 확인)
- 맵 이름은 헤더 LevelNamesAndTimes 에만 있어 `tools/parser-patches/manifest-level-names.patch` 로 manifest.json 에 추가
- 파서는 패치마다 리플레이 암호화 변환이 바뀜 → `.github/workflows/build-windows.yml` 의 PARSER_COMMIT 갱신

## 검증 기준 경기 (offangle 17fe8afd-…, Summit, 사용자 = Clove, PUUID 79800fdd…)
K/D 10/23, 배치 중앙값 4.24°(13교전), TTD 평균 657ms, TTK 평균 822ms, 소총 첫 발 29%(5/17),
적 보일 때 명중 23%(26/112), Phantom 이동 위반 4/53, 상대별: Iso 4–7, Chamber 3–6, Jett 2–3, Clove 0–4, Fade 1–2

## 다음 할 일
1. 새 빌드로 위 경기 재분석 → offangle 비교 표에서 K/D·팀·상대별 전적 일치 확인
2. 맵 충돌 모델 로컬 추출 (HOME_SETUP.md 4번, 약관 위험 — 사용자 결정, 결과물 커밋 금지) → 배치·TTD 를 offangle 과 맞추기
3. 추출한 맵 데이터·게임 파일은 절대 저장소에 올리지 않기
