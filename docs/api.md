# Platform API 명세

기본 주소 `http://localhost:8080`. 프론트는 Vite 프록시로 `/api`만 호출합니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/report` | 화면에 필요한 전체 상태 (아래 형식) |
| GET | `/api/events` | SSE. 상태가 바뀔 때마다 `event: report`로 전체 report 전송 |
| POST | `/api/run` | **여러 세대 자동 실행 (기본 3세대)**. 끝나면 report 반환. `wait:false`면 바로 202. 실행 중이면 409 |
| POST | `/api/reset` | 초기화 (배포 룰도 비움). **시드를 안 주면 수렴이 확인된 시드 중 무작위** → 매번 다른 진행. 숫자 `{ "seed": 7 }`를 주면 고정 |
| POST | `/api/demo` | **데모 버튼용**: 시드 고정 초기화 + 자동 실행을 한 번에. 바로 202, 진행은 SSE로 |
| POST | `/api/test` | 요청 하나 검사. body `{ "request": "/search?q=..." }` |
| GET | `/api/samples?kind=normal\|attack\|mutated` | 테스트용 샘플 요청 `{ request }` |

오류는 `{ "error": "메시지" }` 와 상태 코드로 응답합니다.

## 변경 이력 (프론트 공유용)
**2026-10-31 B4 오케스트레이터** — 기존 필드는 그대로, 아래만 추가/변경
- `POST /api/run`이 1세대 → **기본 3세대 연속 실행**으로 바뀜. 1세대만 원하면 `{ "generations": 1 }`
- `POST /api/demo` 추가: 발표 때 이 버튼 하나만 누르면 됨
- report에 `run`(자동 실행 진행 상황), `seed` 필드 추가
- `POST /api/reset`이 `{ seed }`를 받음

**2026-10-31 무작위 시드 초기화** — 프론트 수정 없음
- 화면의 "초기화"(시드 없이 호출)가 이제 매번 다른 시드를 고름. 4세대 안에 100% 수렴이 확인된 40개(`GOOD_SEEDS`) 중에서만 고름 (WAF 없이 로컬 판정으로 확인한 결과. WAF 모드에서는 별도 확인 필요)
- 어떤 시드였는지는 이벤트 로그 `초기화 (무작위 시드 44)`와 report의 `seed`에 남음. 같은 흐름을 다시 보려면 `{ "seed": 44 }`로 초기화
- `/api/demo`는 그대로 20261031 고정 (무작위로 하려면 `{ "seed": "random" }`)

## POST /api/run body (모두 선택)
```json
{ "generations": 3, "fpMax": 0, "bypMax": 10, "intensity": 2,
  "stageDelayMs": 600, "generationDelayMs": 1200, "stopWhenConverged": true, "wait": true }
```
- `generations` 연속 실행할 세대 수 1~5 (기본 3)
- `fpMax` 오탐 허용치(%, 0~10), `bypMax` 우회 허용치(%, 0~60)
- `intensity` AI 공격 강도 1~3, `stageDelayMs` 단계별 대기(화면 연출용, 기본 400)
- `generationDelayMs` 세대 사이 대기 (기본 stageDelayMs × 2)
- `stopWhenConverged` 수렴(모든 유형 배포 + 실전 우회 0)하면 남은 세대 건너뜀 (기본 true)
- `wait` false면 끝날 때까지 기다리지 않고 바로 `202 { "started": true }` (진행은 SSE로)

기본값(`stageDelayMs` 400)이면 1세대에 약 2.8초, 3세대에 약 10초 걸립니다. 화면 연출이 빠르면 `stageDelayMs`를 600~1000으로 올리세요.

## POST /api/demo body (모두 선택)
```json
{ "seed": 20261031, "generations": 3, "stageDelayMs": 800 }
```
`/api/reset {seed}` 후 `/api/run`을 `wait:false`로 부른 것과 같습니다. 시드를 안 주면 `/api/reset`과 달리 **20261031 고정**입니다 (리허설한 결과 그대로). 응답 `202 { "started": true, "seed": 20261031 }`.

## 프론트 연동 예시
```js
// 1) 화면 진입 시 SSE 연결 — 이후 모든 갱신은 여기로 들어옴 (단계·세대가 바뀔 때마다 report 전체)
const es = new EventSource('/api/events');
es.addEventListener('report', (e) => setReport(JSON.parse(e.data)));

// 2) 버튼: 응답을 기다릴 필요 없음, 화면은 SSE가 갱신
await fetch('/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stageDelayMs: 800 }) });

// 3) 진행 표시
// report.busy                → 버튼 비활성화
// report.run.current/total   → "2 / 3 세대"
// report.activeStage (0~4)   → 5단계 중 현재 단계 강조, null이면 단계 사이
// report.history             → 세대별 탐지율/우회율/오탐률 그래프
```

## 시드 고정 데모 시나리오
시드별 결과는 **패턴 풀 + 로컬 판정(WAF 없음)** 기준입니다. WAF를 켜면 5단계 평가가 실제 WAF 응답으로 바뀌어 숫자가 달라질 수 있습니다.

같은 시드 + OpenAI 키 없음(패턴 풀) + 같은 옵션이면 결과가 항상 같습니다. `cd platform-api && npm run demo`로 서버 없이 미리 볼 수 있어요.
기본 시드 `20261031`, 3세대, 강도 2 결과 (로컬 룰 검사 기준, 실제 WAF 결과 아님):

| 세대 | 탐지율 | 우회율 | 오탐률 | 일어나는 일 |
|---|---|---|---|---|
| 0 | 0% | 100% | 0% | 배포 룰 없음 |
| 1 | 0% | 100% | 0% | 후보 16개 전부 탈락 (오탐·탐지 부족·우회). 예) `=\s*\d`가 정상 `/news?id=1024` 차단 |
| 2 | 73.3% | 26.7% | 0% | 1세대에 당한 우회 기법(인코딩·대소문자 등) 학습 → XSS·Path·CMDi 룰 배포 |
| 3 | 100% | 0% | 0% | SQLi 룰 배포 → 4유형 모두 배포, 실전 우회 0건으로 수렴 |

OpenAI 키를 넣으면 LLM 응답이 매번 달라서 이 표와 다르게 나옵니다. 발표 리허설은 키 없이 하세요.

## POST /api/test 응답
```json
{
  "request": "/item?id=1' OR 1=1--",
  "deployedCount": 4,
  "local": { "blocked": true, "ruleId": "R035", "type": "sqli", "pattern": "..." },
  "waf": { "status": 403, "blocked": true }
}
```
`waf`는 백엔드에 `WAF_URL`이 설정된 경우에만 포함됩니다.

## report 형식
```json
{
  "gen": 2,
  "busy": false,
  "activeStage": null,
  "stages": ["공격 27건 ...", "후보 16개 생성", "...", "...", "..."],
  "run": { "total": 3, "current": 2, "startGen": 1, "endGen": 3, "stoppedEarly": false,
           "startedAt": 1730000000000, "finishedAt": null },
  "seed": 20261031,
  "converged": false,
  "kpis": { "deployed": 3, "totalTypes": 4, "detect": 0.73, "bypass": 0.27, "fp": 0, "techniques": 4, "corpus": 30 },
  "candidates": [ { "id": "R017", "type": "sqli", "pattern": "...", "tier": "good",
                    "flags": ["i","url"], "gen": 2, "status": "deploy",
                    "detect": 1, "fp": 0, "bypass": 0.04,
                    "fpSamples": [], "bypassSamples": [{ "text": "...", "techs": ["url"] }] } ],
  "deployed": [ /* candidates와 같은 형식, 유형당 최대 1개 */ ],
  "history": [ { "gen": 0, "detect": 0, "bypass": 1, "fp": 0 } ],
  "corpus": { "attacks": [ { "type": "sqli", "text": "...", "learned": false } ], "learned": 0 },
  "logs": [ { "gen": 2, "level": "ok", "msg": "...", "t": 1730000000000 } ],
  "env": { "wafConnected": false, "aiEnabled": false }
}
```
- `run`: 마지막 `/api/run` 진행 상황. 한 번도 안 돌렸으면 `null`. `finishedAt`이 null이면 실행 중
- `seed`: 마지막 초기화 때 쓴 시드
- `type`: `sqli | xss | path | cmd`
- `status`: `pending | ok | deploy | fp | det | byp` (검증 중, 생존, 배포, 오탐 탈락, 탐지 부족 탈락, 우회 탈락)
- `tier`: `literal | good | broad | ai`
- `flags`: 정규화 플래그 `i url url2 cmt ws`
- 백엔드 없이 프론트만 개발할 때는 `anvil-frontend/src/mock/report.json`이 같은 형식의 예시입니다.
