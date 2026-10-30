import { config } from '../config.js';
import { ALL_FLAGS, TYPE_KEYS } from '../utils/constants.js';
import { isSafePattern } from '../utils/matcher.js';

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
  'Given attack request samples per type and benign request samples, return up to 4 signatures per type.',
  'Rules: patterns must be JavaScript-compatible regex source strings without inline flags or delimiters;',
  'case-insensitivity and decoding are handled separately; each pattern must be under 300 characters;',
  'prefer patterns that generalize the attack structure but must NOT match the benign samples.',
  'Respond with JSON only: {"rules":[{"type":"sqli|xss|path|cmd","pattern":"..."}]}',
].join(' ');

async function askOpenAI(corpus, normal) {
  const attacks = Object.fromEntries(TYPE_KEYS.map((t) => [t, corpus[t].map((a) => a.text)]));
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify({
      model: config.openaiModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ attacks, benign: normal.slice(0, 25) }) },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`OpenAI 응답 오류 ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
  const picks = Object.fromEntries(TYPE_KEYS.map((t) => [t, []]));
  for (const r of parsed.rules ?? []) {
    // LLM이 준 패턴은 그대로 믿지 않고 길이·컴파일 가능 여부를 먼저 거른다
    if (picks[r?.type] && picks[r.type].length < 4 && isSafePattern(r.pattern)) {
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
      picks = await askOpenAI(st.corpus, seed.normal);
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
