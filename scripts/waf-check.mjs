// 실행 중인 WAF에 규칙을 실제로 배포해 로컬 매칭(matcher.js)과 같은 결과가 나오는지 확인한다.
// 사용법: docker compose up -d --build 후 node scripts/waf-check.mjs
// 끝나면 규칙을 비우고, 불일치가 허용치를 넘으면 종료 코드 1로 끝난다.
process.env.WAF_URL ||= 'http://localhost:8000';
process.env.WAF_TEST_CMD ||= 'docker compose exec -T waf nginx -t';
process.env.WAF_RELOAD_CMD ||= 'docker compose exec -T waf nginx -s reload';

const { default: fs } = await import('node:fs/promises');
const { applyRules } = await import('../platform-api/src/services/deploy.js');
const { sendToWaf } = await import('../platform-api/src/services/waf.js');
const { ruleMatches } = await import('../platform-api/src/utils/matcher.js');
const { generateVariants } = await import('../platform-api/src/utils/mutate.js');
const { createRng } = await import('../platform-api/src/utils/rng.js');
const { TYPE_KEYS } = await import('../platform-api/src/utils/constants.js');

const read = async (name) => JSON.parse(await fs.readFile(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const [attacks, normal, pool] = await Promise.all([read('attacks.json'), read('normal.json'), read('rule-candidates.json')]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_DIFF_RATE = 0.001;
const FLAG_SETS = [['i'], ['i', 'url'], ['i', 'url', 'url2'], ['i', 'cmt', 'ws'], ['i', 'url', 'url2', 'cmt', 'ws']];
const rng = createRng(20261031);

// 재시작 직후에는 연결이 끊길 수 있어서 응답이 올 때까지 기다린다
async function send(request) {
  for (let i = 0; ; i++) {
    try { return await sendToWaf(request); } catch (err) {
      if (i >= 20) throw err;
      await sleep(250);
    }
  }
}

async function basics() {
  await applyRules([]);
  await sleep(500);
  const open = await send("/search?q=' UNION SELECT username,password FROM users--");
  const body = await (await fetch(`${process.env.WAF_URL}/search?q=%27%20UNION%20SELECT%201`)).json();
  if (open.status !== 200 || !body.breached) throw new Error('규칙이 없을 때 공격이 타깃까지 도달해야 합니다');
  console.log('규칙 없음: 공격이 타깃까지 도달하고 데이터가 샜습니다 (CRS가 막지 않음)');
}

let compared = 0;
const diffs = [];

async function compare(type, entry, flags) {
  const rule = { id: 'R900', type, pattern: entry.p, flags, gen: 0 };
  await applyRules([rule]);
  await sleep(300);
  const requests = [...attacks[type], ...normal, ...generateVariants(type, attacks[type], 3, 3, rng).map((v) => v.text)];
  for (const request of requests) {
    // 실제 HTTP 요청은 WAF가 항상 한 번 디코딩하고 +도 공백으로 읽으므로 그 상태로 로컬 판정과 비교한다
    const local = ruleMatches({ ...rule, flags: [...flags, 'url'] }, request.replace(/\+/g, ' '));
    const waf = (await send(request)).blocked;
    compared++;
    if (local !== waf) diffs.push({ type, pattern: entry.p, flags: flags.join(','), request, local, waf });
  }
}

await basics();
try {
  for (const type of TYPE_KEYS) {
    for (const entry of pool[type]) {
      for (const flags of FLAG_SETS) await compare(type, entry, flags);
    }
    console.log(`${type}: 비교 누적 ${compared}건, 불일치 ${diffs.length}건`);
  }
} finally {
  await applyRules([]);
}

const summary = new Map();
for (const d of diffs) {
  const key = `${d.flags} | local=${d.local} waf=${d.waf}`;
  summary.set(key, (summary.get(key) ?? 0) + 1);
}
for (const [key, n] of [...summary].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${key}`);
for (const d of diffs.slice().sort((a, b) => a.local - b.local).reverse().slice(0, 15)) console.log(JSON.stringify(d));
console.log(`결과: ${compared}건 중 불일치 ${diffs.length}건`);
// matcher.js의 ws는 %09 글자도 공백으로 보지만 WAF는 디코딩 횟수만큼만 풀기 때문에 드물게 차이가 난다
process.exit(diffs.length / compared > MAX_DIFF_RATE ? 1 : 0);
