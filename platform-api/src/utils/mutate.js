// "AI 공격자" 역할: 공격 의도는 그대로 두고 겉모습만 바꾼 변형 공격을 만든다.
// 기본 공격자는 services/attacker.js(LLM)이고, 이 규칙 기반 변형기는 LLM을 못 쓸 때의 대체 수단이다.
export const TECHNIQUES = {
  cmt: { label: '주석 삽입', flag: 'cmt', only: ['sqli'] },
  ws: { label: '공백 치환', flag: 'ws' },
  case: { label: '대소문자 혼합', flag: 'i' },
  url: { label: 'URL 인코딩', flag: 'url' },
  url2: { label: '이중 인코딩', flag: 'url2' },
};
const TECH_ORDER = ['cmt', 'ws', 'case', 'url', 'url2']; // 인코딩은 마지막에 적용

function urlEncodeSome(s, rng, all = false) {
  return s.replace(/['<>\/ ;|()=.`&:\\]/g, (c) =>
    all || rng.rand() < 0.7 ? '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') : c);
}

function applyTech(key, s, rng) {
  switch (key) {
    case 'cmt': return s.replace(/ /g, '/**/');
    case 'ws': return s.replace(/ /g, () => rng.pick(['\t', '+', '%09', '  ']));
    case 'case': return s.replace(/[a-z]/gi, (c) => (rng.rand() < 0.5 ? c.toUpperCase() : c.toLowerCase()));
    case 'url': return urlEncodeSome(s, rng);
    case 'url2': return urlEncodeSome(s, rng, true).replace(/%/g, '%25');
    default: return s;
  }
}

/** 요청의 쿼리 부분만 변형 (경로는 유지) */
export function mutate(req, techKeys, rng) {
  const i = req.indexOf('?');
  const head = i >= 0 ? req.slice(0, i + 1) : '';
  let q = i >= 0 ? req.slice(i + 1) : req;
  const keys = techKeys.includes('url2') ? techKeys.filter((k) => k !== 'url') : techKeys;
  for (const k of TECH_ORDER) if (keys.includes(k)) q = applyTech(k, q, rng);
  return head + q;
}

export function techsFor(type) {
  return TECH_ORDER.filter((k) => !TECHNIQUES[k].only || TECHNIQUES[k].only.includes(type));
}

/** 원본 공격마다 변형 perBase개 생성. intensity = 한 번에 섞는 기법의 최대 개수 */
export function generateVariants(type, bases, perBase, intensity, rng) {
  const out = [];
  const avail = techsFor(type);
  for (const base of bases) {
    for (let n = 0; n < perBase; n++) {
      const count = 1 + Math.floor(rng.rand() * intensity);
      const chosen = [];
      while (chosen.length < Math.min(count, avail.length)) {
        const t = rng.pick(avail);
        if (!chosen.includes(t)) chosen.push(t);
      }
      out.push({ type, text: mutate(base, chosen, rng), techs: chosen, base });
    }
  }
  return out;
}
