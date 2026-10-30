import { config } from '../config.js';

// 플랫폼이 보낸 검증 트래픽 표시. detect가 감사 로그에서 이 요청을 학습 데이터로 다시 읽지 않게 한다
export const PROBE_HEADER = 'x-anvil-probe';
// 규칙 파일마다 이 헤더 값에만 418로 답하는 확인용 규칙을 넣어, 그 파일이 적용됐는지 알아낸다
export const RELOAD_HEADER = 'x-anvil-reload';
const RELOAD_TIMEOUT_MS = 20000;
const RELOAD_CONFIRMS = 3; // 이전 워커가 남아 있을 수 있어서 연속으로 확인한다

/**
 * 요청 문자열을 그대로 전달할 수 있게 만든다.
 * URL 파서는 탭을 지우고 # 뒤를 잘라내므로, HTTP에 그대로 못 싣는 문자만 먼저 인코딩한다.
 * 이미 있는 %XX는 건드리지 않아서 이중 인코딩 공격도 원문대로 나간다.
 */
export function toWire(request) {
  return request.replace(/[^\x21-\x7e]|["#<>\\^`{|}]/gu, encodeURIComponent);
}

/** nginx -s reload는 새 설정이 적용되기 전에 끝나므로, 해당 규칙 파일이 실제로 돌 때까지 기다린다 */
export async function waitForReload(stamp) {
  if (!config.wafUrl) return;
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  let confirms = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL('/health', config.wafUrl), {
        headers: { [PROBE_HEADER]: '1', [RELOAD_HEADER]: stamp },
        signal: AbortSignal.timeout(2000),
      });
      await res.body?.cancel().catch(() => {});
      confirms = res.status === 418 ? confirms + 1 : 0;
      if (confirms >= RELOAD_CONFIRMS) return;
    } catch { confirms = 0; /* reload 중 연결이 끊길 수 있음 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('WAF에 새 규칙이 적용되지 않았습니다');
}

/** 요청 하나를 실제 WAF로 보낸다. 403이면 차단 */
export async function sendToWaf(request) {
  const url = new URL(toWire(request), config.wafUrl);
  if (url.origin !== new URL(config.wafUrl).origin) {
    throw Object.assign(new Error('WAF 밖 주소로는 요청을 보내지 않습니다'), { status: 400 });
  }
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { [PROBE_HEADER]: '1' },
    signal: AbortSignal.timeout(5000),
  });
  await res.body?.cancel().catch(() => {});
  return { status: res.status, blocked: res.status === 403 };
}
