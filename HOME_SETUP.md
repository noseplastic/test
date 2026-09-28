# 집에서 할 일 (실전 리플레이 분석 검증 + 맵 추출 준비)

## 1. 리플레이 준비
1. 발로란트 클라이언트 → 경기 기록 → 최근 경기 → **리플레이 다운로드**
2. 파일 위치: `%LOCALAPPDATA%\VALORANT\Saved\Demos\*.vrf`
3. 현재 패치 13.06 은 해석기(ValorantReplayParser 2026-09-27 커밋)가 지원합니다. 패치가 바뀌면 해석이 실패할 수 있습니다.

## 2. offangle 로 같은 리플레이 분석 (비교용 정답)
1. https://offangle.pro 에 같은 .vrf 업로드
2. 리포트에서 **교전별 반응 속도(첫 데미지까지 시간)·크로스헤어 배치** 화면을 스크린샷
3. 지표 설명(물음표/툴팁)도 스크린샷 — 지표 정의를 맞추는 데 씁니다

## 3. 우리 앱으로 분석
1. [최신 Windows 빌드](https://github.com/noseplastic/test/releases) 의 `ValoAimTrainer-win-x64.zip` → 압축 해제 → `ValoAimTrainer.exe`
2. **실전 리플레이** 탭 → 목록에서 **분석**
3. 결과 아래 **데이터 진단** 을 열어 전부 복사해서 보내주세요. 특히:
   - 내 이동·시야 기록 **평균 간격** (플릭 분석 가능 여부)
   - **좌표 보정 오차**, **시야 규칙 오차** (1° 넘으면 데이터 해석이 틀린 것)
   - 맵 이름이 제대로 나오는지, 연막 개수
4. 해석 실패 시 오류 메시지 전체

## 4. (선택) 로컬 Claude Code 로 맵 충돌 모델 추출

> ⚠️ 게임 파일 추출은 Riot 약관상 허용된 행위가 아닙니다. 하신다면:
> **발로란트를 끈 상태**에서, 게임 파일은 **읽기만**, 추출 결과는 **절대 커밋/배포하지 않기** (`maps/` 는 .gitignore 처리됨).

준비물: Git, Node.js 22, .NET 10 SDK, Claude Code

```bash
git clone https://github.com/noseplastic/test valo-coach
cd valo-coach
git checkout claude/valorant-aim-overlay-yen0za
npm ci && npm test
claude
```

Claude 에게: "HOME_SETUP.md 4번 맵 추출 진행해줘"

### Claude 가 할 일 (로컬 세션용 메모)
1. 게임 폴더 확인: 보통 `C:\Riot Games\VALORANT\live\ShooterGame\Content\Paks` (.pak/.utoc/.ucas, 암호화됨).
   해독 키(AES)는 패치마다 커뮤니티에 공유됨 — 사용자에게 출처를 확인받고 사용.
2. `tools/map-extract/` 에 CUE4Parse(FModel 이 쓰는 라이브러리, 라이선스 확인) 기반 C# 콘솔 도구 작성:
   - 각 맵 `.umap` 의 StaticMesh 액터 + 월드 변환 → 메시의 **충돌(BodySetup) 우선, 없으면 LOD0** 삼각형
   - 출력: `maps/<코드명>.json` = `{ name, units: 'cm', triangles: [x,y,z,...] }` (언리얼 월드 좌표)
   - 코드명: Ascent, Bonsai(Split), Triad(Haven), Duality(Bind), Port(Icebox), Foxtrot(Breeze), Canyon(Fracture),
     Pitt(Pearl), Jam(Lotus), Juliett(Sunset), Infinity(Abyss) (`js/match/replay.js` MAPS)
   - 유리·펜스·풀 등 **총알/시야가 통과하는 메시는 제외** 필요 (충돌 채널 확인)
3. 앱이 읽는 위치로 복사: `%APPDATA%\valo-aim-trainer-desktop\maps\<코드명>.json` (또는 트레이너 탭에서 파일 선택)
4. 검증:
   - 데이터 진단의 **발밑 바닥 일치** 90% 이상 (좌표계가 맞는지)
   - 교전별 반응 속도를 offangle 스크린샷과 비교 → 차이가 크면 몸 판정 지점(`BODY_POINTS`)·연막 반지름(`SMOKE_RADIUS`) 조정
   - 테스트: `test/visibility.test.js` 참고

## 5. 해석기 업데이트 (패치 후 실패할 때)
- 해석기는 Riot 이 패치마다 바꾸는 리플레이 암호화 변환을 역분석해서 추가합니다
  (`src/Replay.Encoding/PayloadEncryption/VersionedTransforms/ValorantSeededTransform13_06.cs` 같은 파일).
- 업스트림에 새 패치 지원이 올라오면 `.github/workflows/build-windows.yml` 의 `PARSER_COMMIT` 만 바꾸면 됩니다.
