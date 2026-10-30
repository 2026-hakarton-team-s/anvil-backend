import fs from 'node:fs/promises';
import { config } from '../config.js';
import { TYPE_KEYS } from '../utils/constants.js';

const SIGNS = {
  sqli: /'\s*(or|and)\b|union\s+(all\s+)?select|;\s*drop\s+table/i,
  xss: /<\s*script|\bon(error|load|click)\s*=|javascript\s*:/i,
  path: /\.\.[\/\\]/,
  cmd: /(;|\|\|?|&&|`)\s*(cat|ls|id|whoami|wget|curl)\b/i,
};

/** 요청 문자열이 어떤 공격 유형인지 대략 분류 (WAF 로그에서 가져온 요청용 휴리스틱) */
export function classify(raw) {
  let text = raw;
  try { text = decodeURIComponent(raw); } catch { /* 디코딩 실패 시 원문 사용 */ }
  return TYPE_KEYS.find((t) => SIGNS[t].test(text)) ?? null;
}

/**
 * ModSecurity JSON 감사 로그(한 줄에 JSON 하나)에서 요청 URI만 읽는다.
 * 로그 형식은 이미지 버전에 따라 다를 수 있어서 읽지 못하는 줄은 건너뛴다.
 */
async function readWafLog() {
  let raw;
  try { raw = await fs.readFile(config.wafLogFile, 'utf8'); } catch { return []; }
  const uris = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const uri = JSON.parse(line)?.transaction?.request?.uri;
      if (typeof uri === 'string') uris.push(uri);
    } catch { /* JSON이 아닌 줄은 무시 */ }
  }
  return uris;
}

const MAX_OBSERVED = 30;

/** STEP 1: 학습 데이터 수집 (샘플 + 이전 세대 우회 사례 + WAF 로그에서 관찰된 공격) */
export async function detect(st) {
  let observed = 0;
  for (const uri of await readWafLog()) {
    const type = classify(uri);
    if (!type || st.corpus[type].some((a) => a.text === uri)) continue;
    if (observed >= MAX_OBSERVED) break;
    st.corpus[type].push({ text: uri, learned: true, techs: [], observed: true });
    observed++;
  }
  const all = TYPE_KEYS.flatMap((t) => st.corpus[t]);
  return { total: all.length, learned: all.filter((a) => a.learned).length, observed };
}
