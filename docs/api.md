# Platform API 명세

기본 주소 `http://localhost:8080`. 프론트는 Vite 프록시로 `/api`만 호출합니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/report` | 화면에 필요한 전체 상태 (아래 형식) |
| GET | `/api/events` | SSE. 상태가 바뀔 때마다 `event: report`로 전체 report 전송 |
| POST | `/api/run` | 1세대 실행. 끝나면 report 반환. 실행 중이면 409 |
| POST | `/api/reset` | 초기화 (배포 룰도 비움) |
| POST | `/api/test` | 요청 하나 검사. body `{ "request": "/search?q=..." }` |
| GET | `/api/samples?kind=normal\|attack\|mutated` | 테스트용 샘플 요청 `{ request }` |

오류는 `{ "error": "메시지" }` 와 상태 코드로 응답합니다.

## POST /api/run body (모두 선택)
```json
{ "fpMax": 0, "bypMax": 10, "intensity": 2, "stageDelayMs": 600 }
```
- `fpMax` 오탐 허용치(%, 0~10), `bypMax` 우회 허용치(%, 0~60)
- `intensity` AI 공격 강도 1~3, `stageDelayMs` 단계별 대기(화면 연출용)

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
- `type`: `sqli | xss | path | cmd`
- `status`: `pending | ok | deploy | fp | det | byp` (검증 중, 생존, 배포, 오탐 탈락, 탐지 부족 탈락, 우회 탈락)
- `tier`: `literal | good | broad | ai`
- `flags`: 정규화 플래그 `i url url2 cmt ws`
- 백엔드 없이 프론트만 개발할 때는 `anvil-frontend/src/mock/report.json`이 같은 형식의 예시입니다.
