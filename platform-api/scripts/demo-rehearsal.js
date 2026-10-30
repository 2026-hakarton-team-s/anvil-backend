// 데모 리허설: 서버를 띄우지 않고 시드 고정으로 N세대를 돌려 화면에 나올 숫자를 미리 본다.
//   npm run demo                 기본 시드 20261031, 3세대
//   npm run demo -- 7 5          시드 7, 5세대
// 실제 data/state.json 과 WAF 규칙 파일은 건드리지 않는다. OpenAI 키는 무시한다 (패턴 풀 = 재현 가능).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-demo-'));
process.env.ANVIL_STATE_FILE = path.join(tmp, 'state.json');
process.env.WAF_RULES_FILE = path.join(tmp, 'anvil-rules.conf');
for (const k of ['OPENAI_API_KEY', 'WAF_TEST_CMD', 'WAF_RELOAD_CMD', 'WAF_URL']) delete process.env[k];

const { loadSeed, newState } = await import('../src/store.js');
const { createRng } = await import('../src/utils/rng.js');
const { createEngine, DEMO_SEED } = await import('../src/services/engine.js');

const seedArg = process.argv[2] ? Number(process.argv[2]) : DEMO_SEED;
const gens = process.argv[3] ? Number(process.argv[3]) : 3;
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';

const seed = await loadSeed();
const rng = createRng(seedArg);
const engine = createEngine({ seed, state: newState(rng.getSeed(), seed), rng });
await engine.reset({ seed: seedArg });
const r = await engine.run({ generations: gens, stageDelayMs: 0, generationDelayMs: 0, stopWhenConverged: false });

console.log(`\n=== ANVIL 데모 리허설 (시드 ${seedArg}, ${gens}세대) ===\n`);
console.log('세대  탐지율   우회율   오탐률');
for (const h of r.history) console.log(`${String(h.gen).padStart(3)}  ${pct(h.detect)}  ${pct(h.bypass)}  ${pct(h.fp)}`);

console.log('\n배포된 룰');
for (const d of r.deployed) console.log(`  ${d.id} ${d.type.padEnd(4)} [${d.flags.join(',')}] ${d.pattern}`);

console.log('\n로그 (오래된 순)');
for (const l of [...r.logs].reverse()) console.log(`  [${l.gen}세대 ${l.level}] ${l.msg}`);
console.log(`\n수렴: ${r.converged ? '예' : '아니오'}`);
await fs.rm(tmp, { recursive: true, force: true });
