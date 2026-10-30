const MAX_PATTERN = 300;
const cache = new Map();

function compile(pattern, flags) {
  const ci = flags.includes('i');
  const key = (ci ? 'i:' : 'c:') + pattern;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(pattern, ci ? 'i' : '');
    cache.set(key, re);
  }
  return re;
}

/** 외부(LLM 등)에서 온 패턴을 쓰기 전에 거르는 검사: 길이 제한 + 컴파일 가능 + 줄바꿈 없음 */
export function isSafePattern(pattern) {
  if (typeof pattern !== 'string') return false;
  if (pattern.length < 1 || pattern.length > MAX_PATTERN) return false;
  if (/[\r\n]/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function hexDecode(s) {
  return s.replace(/%([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 검사 전 정규화: 우회 기법(인코딩·주석·공백)을 무력화한다 */
export function normalize(s, flags) {
  let x = s;
  if (flags.includes('url') || flags.includes('url2')) {
    x = hexDecode(x);
    if (flags.includes('url2')) x = hexDecode(x);
  }
  if (flags.includes('cmt')) x = x.replace(/\/\*.*?\*\//g, ' ');
  if (flags.includes('ws')) x = x.replace(/%09/gi, ' ').replace(/[\t+]/g, ' ').replace(/ {2,}/g, ' ');
  return x;
}

export function ruleMatches(rule, req) {
  return compile(rule.pattern, rule.flags).test(normalize(req, rule.flags));
}
