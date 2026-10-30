# ANVIL Backend

자가개선형 웹 방어 시그니처 플랫폼 백엔드.
공격 요청에서 방어 규칙(시그니처)을 만들고, 정상 트래픽 오탐 검증과 AI 우회 공격 시뮬레이션을 반복해 살아남은 규칙만 WAF에 적용합니다.

## 구조

```
User/Attacker → WAF Gateway(Nginx+ModSecurity+CRS) → Demo Shop API
                     ↑ 룰 배포        │ WAF 로그
                     └──── Platform API ←→ OpenAI
                               ↕ REST/SSE        ↕ JSON 저장소
                          Admin 대시보드
```

## 폴더
- `platform-api/` : 탐지·생성·검증·배포를 맡는 Platform API (Node, Express)
  - `src/services/engine.js` 5단계 루프를 돌리는 오케스트레이터
  - `src/services/` detect / generate / validate / deploy / report
  - `src/utils/` 정규화·매칭, 변형 공격 생성, 시드 고정 난수
  - `test/` 단위 테스트
- `demo-shop/` : WAF가 보호하는 샘플 쇼핑 API. `/login`, `/search`는 메모리 안에서 SQL 인젝션 피해를 흉내 냄 (DB·파일·명령 실행 없음)
- `waf/rules/anvil-rules.conf` : Platform API가 쓰는 ModSecurity 규칙 파일 (자동 생성)
- `waf/conf/anvil-include.conf` : 규칙 파일을 CRS보다 먼저 읽게 하는 Include
- `scripts/waf-check.mjs` : 후보 규칙을 실제 WAF에 배포해 로컬 판정과 비교
- `data/` : 공격 샘플(`attacks.json`), 정상 요청(`normal.json`), 룰 후보 풀(`rule-candidates.json`)
  - 실행 중 `state.json`이 생기며 git에는 올리지 않음
- `docs/api.md` : API 명세

## 실행 방법

### 1) Platform API만 (WAF 없이, 가장 빠름)
```bash
cd platform-api
npm install
npm start          # http://localhost:8080
npm test           # 단위 테스트
npm run demo       # 서버 없이 시드 고정 데모(3세대) 결과 미리 보기
```
발표 데모는 `POST /api/demo` 한 번이면 됩니다 (시드 고정 초기화 + 3세대 자동 실행, 진행은 SSE). 자세한 내용은 `docs/api.md`.
이 상태에서도 `/api/run`으로 세대를 돌리고 로컬 룰 검사까지 동작합니다.

### 2) WAF + Demo Shop (Docker)
```bash
mkdir -p data/waf-logs && chmod 777 data/waf-logs   # WAF 감사 로그 폴더 (처음 한 번)
docker compose up -d --build     # WAF: http://localhost:8000
```
WAF가 막은 요청은 `data/waf-logs/audit.log`에 쌓이고, 다음 세대 실행 때 `detect.js`가 읽어 학습 데이터에 넣습니다.
CRS는 점수만 매기고 차단하지 않으므로, 규칙이 없으면 공격이 타깃까지 그대로 도달합니다. 403은 ANVIL 규칙이 막았다는 뜻입니다.
`node scripts/waf-check.mjs`로 WAF 판정이 로컬 판정과 같은지 확인할 수 있습니다 (약 3분, CI에서도 실행).
Platform API가 규칙을 반영하고 WAF를 reload하도록 `.env`를 설정합니다.
```
WAF_URL=http://localhost:8000
WAF_TEST_CMD=docker compose exec -T waf nginx -t
WAF_RELOAD_CMD=docker compose exec -T waf nginx -s reload
```
`.env`는 자동으로 읽히지 않으니 셸에서 불러온 뒤 실행하세요.
```bash
cd platform-api
set -a; source ../.env; set +a
npm start
```

## 환경변수 (`.env.example` 참고)
| 이름 | 설명 |
|---|---|
| `PORT` | Platform API 포트 (기본 8080) |
| `OPENAI_API_KEY` | 비우면 `data/rule-candidates.json` 패턴 풀로 규칙 후보 생성 |
| `OPENAI_MODEL` | 사용할 모델 이름 |
| `WAF_URL` | 설정하면 요청 테스트가 실제 WAF로도 전송됨 |
| `WAF_TEST_CMD` / `WAF_RELOAD_CMD` | 규칙 반영 전 문법 검사, 반영 명령. 실패하면 이전 규칙으로 롤백 |

## WAF 판정과 로컬 판정의 차이
- 실제 HTTP 요청은 WAF가 항상 한 번 URL 디코딩합니다. 그래서 단일 URL 인코딩은 실제 WAF를 우회하지 못하고, 로컬 검증의 `url` 플래그 없는 룰만 뚫린 것으로 나옵니다.
- 실제 WAF에서 우회가 되는 인코딩은 이중 인코딩(`url2`)입니다. WAF 결과가 필요한 검증은 `src/services/waf.js`의 `sendToWaf`를 쓰세요.

## 아직 검증하지 않은 부분 (해커톤 중 확인 필요)
- OpenAI 호출 (키 없이 패턴 풀로만 테스트함)
