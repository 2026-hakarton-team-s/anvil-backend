import { config } from '../config.js';
import { TYPE_KEYS } from '../utils/constants.js';
import { ruleMatches } from '../utils/matcher.js';

const CONCURRENCY = 8;
const TIMEOUT_MS = 5000;

/**
 * 판정을 위해 WAF에 보낸 요청의 경로(URI). WAF 로그에는 이 요청도 남으므로,
 * detect()가 이 목록에 있는 URI를 "관찰된 공격"으로 다시 가져가지 않게 한다.
 */
export const probedUris = new Set();

/** 요청 하나를 실제 WAF에 보내 403으로 막혔는지 본다. WAF 주소 밖으로는 보내지 않는다 */
async function probeWaf(request) {
  const base = new URL(config.wafUrl);
  const url = new URL(request, base);
  if (url.origin !== base.origin) throw new Error('WAF 밖 주소로는 요청을 보내지 않습니다');
  probedUris.add(url.pathname + url.search);
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel().catch(() => {});
  return res.status === 403;
}

/** 요청 목록을 WAF에 보내 막힘 여부를 같은 순서의 배열로 돌려준다 */
async function wafBlocked(requests) {
  const out = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      out[i] = await probeWaf(requests[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker));
  return out;
}

/**
 * 배포 룰셋 성능 판정 (STEP 5 실전 레드팀).
 * useWaf이면 실제 WAF에 요청을 보내 막힘 여부로 판정하고, 아니면 배포 룰을 로컬 매칭한다.
 * 탐지율은 원본 공격 + 변형 공격 전체, 우회율은 변형 공격 중 뚫린 비율, 오탐은 정상 요청 중 막힌 비율.
 */
export async function judgeDeployed({ rules, variants, seedAttacks, normal, useWaf }) {
  const seeds = TYPE_KEYS.flatMap((t) => seedAttacks[t]);
  const attacks = seeds.concat(variants.map((v) => v.text));
  const requests = attacks.concat(normal);
  const blocked = useWaf
    ? await wafBlocked(requests)
    : requests.map((req) => rules.some((r) => ruleMatches(r, req)));

  const attackBlocked = blocked.slice(0, attacks.length);
  const normalBlocked = blocked.slice(attacks.length);
  const variantBlocked = attackBlocked.slice(seeds.length);
  const escaped = variants.filter((_, i) => !variantBlocked[i]);
  const count = (arr) => arr.filter(Boolean).length;
  return {
    mode: useWaf ? 'waf' : 'local',
    detect: attacks.length ? count(attackBlocked) / attacks.length : 0,
    bypass: variants.length ? escaped.length / variants.length : 1,
    fp: count(normalBlocked) / normal.length,
    escaped,
  };
}
