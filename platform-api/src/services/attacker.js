import { config } from '../config.js';
import { TYPE_KEYS } from '../utils/constants.js';
import { askJson } from '../utils/llm.js';
import { TECHNIQUES, generateVariants } from '../utils/mutate.js';

const MAX_LEN = 500;
const TECH_KEYS = Object.keys(TECHNIQUES);

const SYSTEM_PROMPT = [
  'You are the attacker in a red-team test of a web application firewall.',
  'The target is a deliberately vulnerable demo shop that runs only in the local test lab.',
  'Rewrite each given attack request so that it keeps the same attack effect but is more likely to slip past a signature-based WAF.',
  'Techniques you may use: cmt (replace spaces with /**/, SQL only), ws (replace spaces with a tab, "+", %09 or double spaces),',
  'case (mix upper and lower case letters), url (percent-encode punctuation once), url2 (percent-encode punctuation twice).',
  'Use at most "maxTechniques" techniques per variant. Use the "previouslyEscaped" requests as hints for what already worked.',
  'Each variant must be a request path that starts with "/" and keeps the same path and parameter structure.',
  'Respond with JSON only: {"variants":[{"base":<index of the attack>,"text":"<request path>","techs":["cmt|ws|case|url|url2"]}]}',
].join(' ');

/** LLM이 준 변형 한 개를 검사한다. 쓸 수 없으면 null */
function acceptVariant(v, bases, maxTechs, seen) {
  const base = Number.isInteger(v?.base) ? bases[v.base] : undefined;
  const text = v?.text;
  if (base === undefined || typeof text !== 'string') return null;
  if (!text.startsWith('/') || text.startsWith('//') || text.length > MAX_LEN) return null;
  if (text === base || seen.has(text)) return null;
  seen.add(text);
  const techs = (Array.isArray(v.techs) ? v.techs : []).filter((t) => TECH_KEYS.includes(t)).slice(0, maxTechs);
  return { text, techs, base };
}

async function askAttacker(type, bases, perBase, intensity, st) {
  const escaped = st.corpus[type].filter((a) => a.learned).slice(-6).map((a) => a.text);
  const data = await askJson([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        type,
        attacks: bases.map((text, base) => ({ base, text })),
        variantsPerAttack: perBase,
        maxTechniques: intensity,
        previouslyEscaped: escaped,
      }),
    },
  ], { timeoutMs: 60000 });
  const seen = new Set();
  const list = Array.isArray(data.variants) ? data.variants : [];
  return list
    .map((v) => acceptVariant(v, bases, intensity, seen))
    .filter(Boolean)
    .slice(0, perBase * bases.length)
    .map((v) => ({ type, ...v }));
}

/**
 * STEP 4·5: 유형별 변형 공격 생성. LLM 공격자를 쓰고, 키가 없거나 응답을 못 쓰면 규칙 기반 변형기로 대체한다.
 * 반환: { variants: [{ type, text, techs, base }], source: 'llm' | 'local', note }
 * 순서대로 한 유형씩 호출해서 규칙 기반 대체가 같은 시드에서 항상 같은 결과를 내게 한다.
 */
export async function generateAttacks({ seed, st, intensity, perBase, rng }) {
  const variants = [];
  const notes = [];
  let llmUsed = false;
  for (const type of TYPE_KEYS) {
    const bases = seed.attacks[type];
    if (config.openaiKey) {
      try {
        const got = await askAttacker(type, bases, perBase, intensity, st);
        if (!got.length) throw new Error('쓸 수 있는 변형이 없음');
        variants.push(...got);
        llmUsed = true;
        continue;
      } catch (err) {
        notes.push(`${type} LLM 공격 실패, 규칙 기반으로 대체: ${err.message}`);
      }
    }
    variants.push(...generateVariants(type, bases, perBase, intensity, rng));
  }
  return {
    variants,
    source: llmUsed ? 'llm' : 'local',
    note: notes.length ? notes.join(' / ') : null,
  };
}
