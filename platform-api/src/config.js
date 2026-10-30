import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, '../..'); // anvil-backend/

export const config = {
  port: Number(process.env.PORT) || 8080,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  dataDir: path.join(backendRoot, 'data'),

  // 배포된 규칙을 WAF가 읽는 파일 (docker-compose에서 이 파일을 WAF에 마운트)
  wafRulesFile: process.env.WAF_RULES_FILE || path.join(backendRoot, 'waf/rules/anvil-rules.conf'),
  // 비어 있으면 건너뜀 (WAF 없이 로컬 검증만 할 때). 테스트 → reload 순서로 실행되고, 실패하면 이전 규칙으로 되돌림
  wafTestCmd: process.env.WAF_TEST_CMD || '',
  wafReloadCmd: process.env.WAF_RELOAD_CMD || '',
  // 설정하면 요청 테스트가 진짜 WAF로도 전송됨 (예: http://localhost:8000)
  wafUrl: process.env.WAF_URL || '',
  // WAF 감사 로그(JSON 한 줄씩). 없으면 무시
  wafLogFile: process.env.WAF_LOG_FILE || path.join(backendRoot, 'data/waf-logs/audit.log'),

  // 비어 있으면 data/rule-candidates.json 패턴 풀로 대체
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  minDetect: 0.75,
};
