import { config } from '../config.js';

// 플랫폼이 보낸 검증 트래픽 표시. detect가 감사 로그에서 이 요청을 학습 데이터로 다시 읽지 않게 한다
export const PROBE_HEADER = 'x-anvil-probe';

/**
 * 요청 문자열을 그대로 전달할 수 있게 만든다.
 * URL 파서는 탭을 지우고 # 뒤를 잘라내므로, HTTP에 그대로 못 싣는 문자만 먼저 인코딩한다.
 * 이미 있는 %XX는 건드리지 않아서 이중 인코딩 공격도 원문대로 나간다.
 */
export function toWire(request) {
  return request.replace(/[^\x21-\x7e]|["#<>\\^`{|}]/gu, encodeURIComponent);
}

/** 요청 하나를 실제 WAF로 보낸다. 403이면 차단 */
export async function sendToWaf(request) {
  const url = new URL(toWire(request), config.wafUrl);
  if (url.origin !== new URL(config.wafUrl).origin) {
    throw Object.assign(new Error('허용되지 않는 요청 주소입니다'), { status: 400 });
  }
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { [PROBE_HEADER]: '1' },
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, blocked: res.status === 403 };
}
