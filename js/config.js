// 발로란트 인게임 수치. 커뮤니티/위키 기준 값이며, 패치로 바뀌면 여기만 고치면 된다.
// 단위: 거리 m, 시간 s, 각도 deg (1m = 발로란트 100 유닛)

export const VALORANT = {
  // 인게임 감도 1.0 기준 마우스 1카운트당 회전 각도 (yaw).
  // cm/360 = 360 * 2.54 / (0.07 * sens * DPI)
  YAW_DEG_PER_COUNT: 0.07,
  // 발로란트 수평 FOV는 103도로 고정 (16:9 기준)
  HFOV_DEG: 103,
  // 눈높이. 평지에서 크로스헤어를 수평으로 두면 서 있는 적의 머리 높이와 같다.
  EYE_HEIGHT: 1.6,
  // 칼 들었을 때 달리기 속도. 무기별 속도는 WEAPONS.moveMult 로 곱한다.
  BASE_RUN_SPEED: 6.75,
  // Shift 걷기 = 달리기의 약 56%
  WALK_MULT: 0.5625,
  // 최고 속도의 30% 이하이면 "정지" 판정 → 첫 발 정확도 적용 (데드존)
  ACCURATE_SPEED_RATIO: 0.3,
  // 0 → 최고 속도까지 걸리는 시간, 최고 속도 → 0 (키를 떼었을 때) 걸리는 시간.
  // 반대 키 카운터 스트레이프 시 두 감속이 합쳐져 약 55ms 만에 정확도 구간에 들어간다.
  ACCEL_TIME: 0.18,
  STOP_TIME: 0.14,
  PLAYER_RADIUS: 0.3,
};

// 히트박스 (캐릭터 발 기준 높이). 머리 중심 = EYE_HEIGHT.
export const HITBOX = {
  head: { w: 0.25, h: 0.27, d: 0.25, y: 1.6 },
  body: { w: 0.5, h: 0.62, d: 0.3, y: 1.16 },
  leg: { w: 0.19, h: 0.85, d: 0.2, y: 0.425, gap: 0.07 },
};

// damage: [머리, 몸, 다리] (방어구 포함 150HP 기준, 0~30m 구간 데미지)
// spread: 첫 발 오차 (deg), movePenalty: 달리는 중 추가 오차 (deg)
// sprayGrow: 연사 시 한 발마다 늘어나는 오차, sprayMax: 연사 오차 상한
export const WEAPONS = {
  vandal: {
    name: 'Vandal', damage: [160, 40, 34], fireRate: 9.75, moveMult: 0.8,
    spread: 0.25, movePenalty: 5.0, sprayGrow: 0.35, sprayMax: 3.0,
  },
  phantom: {
    name: 'Phantom', damage: [156, 39, 33], fireRate: 11, moveMult: 0.8,
    spread: 0.2, movePenalty: 4.5, sprayGrow: 0.3, sprayMax: 2.6,
  },
  sheriff: {
    name: 'Sheriff', damage: [159, 55, 46], fireRate: 4, moveMult: 0.8,
    spread: 0.25, movePenalty: 4.0, sprayGrow: 0.9, sprayMax: 3.5,
  },
  ghost: {
    name: 'Ghost', damage: [105, 30, 25], fireRate: 6.75, moveMult: 0.85,
    spread: 0.3, movePenalty: 2.5, sprayGrow: 0.4, sprayMax: 2.5,
  },
};

export const PLAYER_HP = 150;

// 적 반응 속도 (ms): 적이 나를 본 뒤 총을 쏘기까지
export const DIFFICULTY = {
  easy: { name: '쉬움', reactionMs: 450 },
  normal: { name: '보통', reactionMs: 320 },
  hard: { name: '어려움', reactionMs: 230 },
  pro: { name: '프로', reactionMs: 170 },
};

// 다른 게임 감도 → 발로란트 감도 변환 (yaw 비율)
export const GAME_YAW = {
  valorant: { name: 'VALORANT', yaw: 0.07 },
  cs2: { name: 'CS2 / CS:GO', yaw: 0.022 },
  apex: { name: 'Apex Legends', yaw: 0.022 },
  overwatch: { name: 'Overwatch 2', yaw: 0.0066 },
};
