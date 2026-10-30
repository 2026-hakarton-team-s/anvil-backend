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
- `demo-shop/` : WAF가 보호하는 샘플 쇼핑 API (DB·파일·명령 실행 없음)
- `waf/rules/anvil-rules.conf` : Platform API가 쓰는 ModSecurity 규칙 파일 (자동 생성)
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
```
이 상태에서도 `/api/run`으로 세대를 돌리고 로컬 룰 검사까지 동작합니다.

### 2) WAF + Demo Shop (Docker)
```bash
docker compose up -d --build     # WAF: http://localhost:8000
```
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

## 아직 검증하지 않은 부분 (해커톤 중 확인 필요)
- `docker-compose.yml`의 WAF 환경변수 이름, 규칙 파일 마운트 경로는 이미지 버전에 따라 다를 수 있음 (문법만 확인, 실제 기동은 안 해봄)
- `deploy.js`가 만드는 ModSecurity `SecRule`이 실제 WAF에서 JS 정규식과 같은 결과를 내는지
- WAF 감사 로그(`WAF_LOG_FILE`) 형식과 `detect.js`의 파싱
- OpenAI 호출 (키 없이 패턴 풀로만 테스트함)
