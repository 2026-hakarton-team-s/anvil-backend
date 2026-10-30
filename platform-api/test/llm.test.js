import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { loadSeed, newState } from '../src/store.js';
import { createRng } from '../src/utils/rng.js';
import { generateCandidates } from '../src/services/generate.js';
import { generateAttacks } from '../src/services/attacker.js';
import { judgeDeployed } from '../src/services/oracle.js';

// 실제 OpenAI는 부르지 않고 fetch를 가로채서 응답을 흉내 낸다
const llmReply = (obj) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

function withKey(fn) {
  const original = config.openaiKey;
  config.openaiKey = 'test-key';
  return fn().finally(() => { config.openaiKey = original; });
}

const seed = await loadSeed();

test('B2: LLM 규칙 중 깨진 정규식과 중복은 버리고, 지난 세대 우회 정보를 입력에 넣는다', async () => {
  const st = newState(1, seed);
  st.gen = 2;
  st.learned.sqli = ['url'];
  st.corpus.sqli.push({ text: "/item?id=1%27%20OR%201=1", learned: true, techs: ['url'] });
  let sent = null;
  const rules = [
    { type: 'sqli', pattern: "'\\s*or\\s+1=1" },
    { type: 'sqli', pattern: "'\\s*or\\s+1=1" }, // 중복
    { type: 'sqli', pattern: '(unclosed' }, // 깨진 정규식
    { type: 'xss', pattern: 'a'.repeat(301) }, // 너무 긴 패턴
    { type: 'cmd', pattern: '(;|\\|)\\s*cat\\b' },
  ];
  const result = await withKey(() =>
    withFetch(async (url, opts) => {
      sent = JSON.parse(opts.body);
      return llmReply({ rules });
    }, () => generateCandidates({ st, seed, rng: createRng(3) })));

  assert.equal(result.source, 'openai');
  const sqli = result.candidates.filter((c) => c.type === 'sqli' && c.tier === 'ai');
  assert.deepEqual(sqli.map((c) => c.pattern), ["'\\s*or\\s+1=1"]);
  assert.equal(result.candidates.some((c) => c.pattern === '(unclosed'), false);
  assert.equal(result.candidates.some((c) => c.pattern.length > 300), false);
  assert.equal(result.candidates.filter((c) => c.tier === 'ai').length, 2);

  const user = JSON.parse(sent.messages[1].content);
  assert.ok(user.bypassedTechniques.includes('sqli: URL디코딩'));
  assert.ok(user.bypassedExamples.some((e) => e.text === '/item?id=1%27%20OR%201=1'));
  assert.ok(sent.messages[0].content.includes('url = percent-decode once'));
});

test('B2: 키가 없거나 LLM이 실패하면 패턴 풀로 대체된다', async () => {
  const st = newState(1, seed);
  const noKey = await generateCandidates({ st, seed, rng: createRng(3) });
  assert.equal(noKey.source, 'pool');
  assert.equal(noKey.note, null);

  const failed = await withKey(() =>
    withFetch(async () => new Response('boom', { status: 500 }), () =>
      generateCandidates({ st: newState(1, seed), seed, rng: createRng(3) })));
  assert.equal(failed.source, 'pool');
  assert.match(failed.note, /OpenAI 응답 오류 500/);
  assert.ok(failed.candidates.length > 0);
});

test('B3: LLM 공격자의 변형은 검사 후 쓸 수 있는 것만 남는다', async () => {
  const st = newState(1, seed);
  const reply = {
    variants: [
      { base: 0, text: "/item?id=1%27/**/OR/**/1=1--", techs: ['cmt', 'url', 'bogus'] },
      { base: 0, text: "/item?id=1%27/**/OR/**/1=1--" }, // 중복
      { base: 0, text: 'item?id=1' }, // '/'로 시작 안 함
      { base: 1, text: '//evil.example/x' }, // 다른 호스트
      { base: 0, text: seed.attacks.sqli[0] }, // 원본과 같음
      { base: 9, text: '/item?id=2' }, // 없는 원본 번호
      { base: 1, text: '/search?q=a'.padEnd(501, 'a') }, // 너무 김
    ],
  };
  // sqli에만 응답을 주고, 나머지 유형은 빈 응답을 줘서 규칙 기반으로 대체되는지도 본다
  const out = await withKey(() =>
    withFetch(async (url, opts) => {
      const user = JSON.parse(JSON.parse(opts.body).messages[1].content);
      return llmReply(user.type === 'sqli' ? reply : { variants: [] });
    }, () => generateAttacks({ seed, st, intensity: 2, perBase: 6, rng: createRng(5) })));

  assert.equal(out.source, 'llm');
  assert.match(out.note, /xss LLM 공격 실패/);
  const sqli = out.variants.filter((v) => v.type === 'sqli');
  assert.equal(sqli.length, 1);
  assert.equal(sqli[0].text, "/item?id=1%27/**/OR/**/1=1--");
  assert.deepEqual(sqli[0].techs, ['cmt', 'url']);
  assert.equal(sqli[0].base, seed.attacks.sqli[0]);
  assert.ok(out.variants.some((v) => v.type === 'xss'));
});

test('B3: LLM 공격자가 실패하면 규칙 기반 변형으로 대체하고 이유를 남긴다', async () => {
  const st = newState(1, seed);
  const out = await withKey(() =>
    withFetch(async () => new Response('no', { status: 429 }), () =>
      generateAttacks({ seed, st, intensity: 2, perBase: 2, rng: createRng(5) })));
  assert.equal(out.source, 'local');
  assert.match(out.note, /LLM 공격 실패, 규칙 기반으로 대체/);
  const bases = Object.values(seed.attacks).flat().length; // 원본 공격 15개
  assert.equal(out.variants.length, bases * 2);

  const noKey = await generateAttacks({ seed, st, intensity: 2, perBase: 2, rng: createRng(5) });
  assert.equal(noKey.source, 'local');
  assert.equal(noKey.note, null);
});

test('B3: 실제 WAF 요청으로 우회·탐지·오탐을 판정한다 (가짜 WAF 서버)', async () => {
  // 가짜 WAF: 쿼리에 "union" 또는 "<script"가 있으면 403
  const waf = http.createServer((req, res) => {
    const blocked = /union|<script/i.test(decodeURIComponent(req.url));
    res.writeHead(blocked ? 403 : 200);
    res.end();
  });
  await new Promise((r) => waf.listen(0, '127.0.0.1', r));
  const { port } = waf.address();
  const original = config.wafUrl;
  config.wafUrl = `http://127.0.0.1:${port}`;
  try {
    const rules = [{ type: 'sqli', pattern: 'union', flags: ['i'] }];
    const variants = [
      { type: 'sqli', text: '/search?q=UNION%20SELECT' }, // 막힘
      { type: 'sqli', text: "/item?id=1'%20OR%201=1--" }, // 뚫림
    ];
    const m = await judgeDeployed({
      rules,
      variants,
      seedAttacks: { sqli: ['/search?q=union+select'], xss: ['/x?q=<script>'], path: [], cmd: [] },
      normal: ['/home', '/search?q=union+jobs'],
      useWaf: true,
    });
    assert.equal(m.mode, 'waf');
    assert.equal(m.bypass, 0.5);
    assert.deepEqual(m.escaped.map((v) => v.text), ["/item?id=1'%20OR%201=1--"]);
    assert.equal(m.detect, 3 / 4); // 원본 2개 모두 + 변형 2개 중 1개 막힘
    assert.equal(m.fp, 0.5); // "union+jobs"는 가짜 WAF가 막는다
  } finally {
    config.wafUrl = original;
    await new Promise((r) => waf.close(r));
  }
});

test('B3: WAF 밖 주소로 요청을 보내려 하면 거부한다', async () => {
  const original = config.wafUrl;
  config.wafUrl = 'http://127.0.0.1:9';
  try {
    await assert.rejects(
      judgeDeployed({
        rules: [],
        variants: [{ type: 'sqli', text: '//example.com/x' }],
        seedAttacks: { sqli: [], xss: [], path: [], cmd: [] },
        normal: [],
        useWaf: true,
      }),
      /WAF 밖 주소/,
    );
  } finally {
    config.wafUrl = original;
  }
});
