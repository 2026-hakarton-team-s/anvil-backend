import { config } from '../config.js';
import { ALL_FLAGS, FLAG_LABEL, TYPE_KEYS } from '../utils/constants.js';
import { isSafePattern } from '../utils/matcher.js';
import { askJson } from '../utils/llm.js';

/** 지난 세대에 당한 우회 기법은 높은 확률로, 그 외는 가끔 탐색적으로 정규화 플래그에 추가 */
function assignFlags(type, learned, rng) {
  const flags = ALL_FLAGS.filter((f) => (learned[type].includes(f) ? rng.rand() < 0.75 : rng.rand() < 0.08));
  if (flags.includes('url2') && !flags.includes('url')) flags.push('url');
  return ALL_FLAGS.filter((f) => flags.includes(f));
}

/** 패턴 풀에서 유형당 최대 4개를 가중치로 뽑음. 세대가 지날수록 원문 복사(literal)보다 일반화(good) 비중이 커짐 */
function pickFromPool(pool, gen, rng) {
  const picks = {};
  const w = {
    literal: Math.max(0.15, 1 - gen * 0.25),
    good: Math.min(1.6, 0.5 + gen * 0.3),
    broad: 0.55, // 과일반화 룰도 꾸준히 섞어서 오탐 검증이 걸러내는 모습을 보여줌
  };
  for (const type of TYPE_KEYS) {
    const entries = pool[type];
    const picked = new Set();
    let guard = 0;
    while (picked.size < Math.min(4, entries.length) && guard++ < 50) {
      const total = entries.reduce((a, x) => a + w[x.tier], 0);
      let r = rng.rand() * total;
      for (const x of entries) {
        r -= w[x.tier];
        if (r <= 0) { picked.add(x); break; }
      }
    }
    picks[type] = [...picked].map((x) => ({ p: x.p, tier: x.tier }));
  }
  return picks;
}

const SYSTEM_PROMPT = [
  'You write regular-expression signatures for a web application firewall.',
  'Given attack request samples per type, benign request samples, the attacker techniques that already bypassed earlier signatures,',
  'and the signatures currently deployed, return up to 4 new signatures per type.',
  'Rules: patterns must be JavaScript-compatible regex source strings without inline flags or delimiters; each pattern must be under 300 characters.',
  'Before matching, the engine normalizes each request according to the rule flags:',
  'url = percent-decode once, url2 = percent-decode twice, cmt = remove /* ... */ comments, ws = turn tabs, "+" and %09 into spaces and collapse runs of spaces.',
  'Case-insensitive matching is applied when the rule has flag i. Write patterns against the normalized text.',
  'Cover the techniques listed in "bypassedTechniques" and the requests listed in "bypassedExamples" by generalizing their structure.',
  'Prefer patterns that generalize the attack structure, but must NOT match any benign sample. Do not repeat a deployed signature.',
  'Respond with JSON only: {"rules":[{"type":"sqli|xss|path|cmd","pattern":"..."}]}',
].join(' ');

const emptyPicks = () => Object.fromEntries(TYPE_KEYS.map((t) => [t, []]));

/** 지난 세대 우회 정보: 뚫린 정규화 기법, 뚫린 공격 예시, 지금 배포된 룰 */
function learnedContext(st) {
  return {
    bypassedTechniques: TYPE_KEYS.flatMap((t) => st.learned[t].map((f) => `${t}: ${FLAG_LABEL[f]}`)),
    bypassedExamples: TYPE_KEYS.flatMap((t) =>
      st.corpus[t].filter((a) => a.learned).slice(-4).map((a) => ({ type: t, text: a.text }))),
    deployed: Object.values(st.deployed).map((r) => ({ type: r.type, pattern: r.pattern })),
  };
}

async function askLLM(st, normal) {
  const attacks = Object.fromEntries(TYPE_KEYS.map((t) => [t, st.corpus[t].map((a) => a.text)]));
  const data = await askJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ attacks, benign: normal.slice(0, 25), ...learnedContext(st) }) },
  ]);
  const picks = emptyPicks();
  for (const r of Array.isArray(data.rules) ? data.rules : []) {
    // LLM이 준 패턴은 그대로 믿지 않고 길이·컴파일 가능 여부를 먼저 거른다 (오탐 검증은 engine이 한다)
    const dup = picks[r?.type]?.some((x) => x.p === r.pattern);
    if (picks[r?.type] && picks[r.type].length < 4 && !dup && isSafePattern(r.pattern)) {
      picks[r.type].push({ p: r.pattern, tier: 'ai' });
    }
  }
  return picks;
}

/** STEP 2: 시그니처 후보 생성. OpenAI 키가 있으면 LLM, 없거나 실패하면 패턴 풀 */
export async function generateCandidates({ st, seed, rng }) {
  let picks = null;
  let source = 'pool';
  let note = null;
  if (config.openaiKey) {
    try {
      picks = await askLLM(st, seed.normal);
      source = 'openai';
    } catch (err) {
      note = `OpenAI 호출 실패, 패턴 풀로 대체: ${err.message}`;
    }
  }
  const fallback = pickFromPool(seed.pool, st.gen, rng);
  const candidates = [];
  for (const type of TYPE_KEYS) {
    // LLM이 특정 유형을 비워 오면 그 유형만 패턴 풀로 채운다
    const entries = picks?.[type]?.length ? picks[type] : fallback[type];
    for (const entry of entries) {
      candidates.push({
        id: 'R' + String(++st.ruleSeq).padStart(3, '0'),
        type,
        pattern: entry.p,
        tier: entry.tier,
        flags: assignFlags(type, st.learned, rng),
        gen: st.gen,
        status: 'pending',
      });
    }
  }
  return { candidates, source, note };
}
