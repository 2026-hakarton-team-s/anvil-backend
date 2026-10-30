import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// 실제 data/state.json, waf 규칙 파일을 건드리지 않도록 임시 폴더로 돌린다 (import 전에 설정해야 함)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-engine-'));
process.env.ANVIL_STATE_FILE = path.join(tmp, 'state.json');
process.env.WAF_RULES_FILE = path.join(tmp, 'anvil-rules.conf');
delete process.env.OPENAI_API_KEY;  // 패턴 풀로만 돌려야 결과가 재현된다
delete process.env.WAF_TEST_CMD;
delete process.env.WAF_RELOAD_CMD;
delete process.env.WAF_URL;

const { loadSeed, newState } = await import('../src/store.js');
const { createRng } = await import('../src/utils/rng.js');
const { createEngine, DEMO_SEED, GOOD_SEEDS } = await import('../src/services/engine.js');

async function makeEngine(onChange) {
  const seed = await loadSeed();
  const rng = createRng(DEMO_SEED);
  return createEngine({ seed, state: newState(rng.getSeed(), seed), rng, onChange });
}

const FAST = { stageDelayMs: 0, generationDelayMs: 0 };

test('/api/run은 기본 3세대를 이어서 실행하고 진행 상황을 남긴다', async () => {
  const engine = await makeEngine();
  const r = await engine.run({ ...FAST, stopWhenConverged: false });
  assert.equal(r.gen, 3);
  assert.equal(r.history.length, 4); // 0세대 + 3세대
  assert.equal(r.busy, false);
  assert.deepEqual(
    { total: r.run.total, current: r.run.current, startGen: r.run.startGen, endGen: r.run.endGen },
    { total: 3, current: 3, startGen: 1, endGen: 3 });
  assert.ok(r.run.finishedAt >= r.run.startedAt);
});

test('generations는 1~5로 제한되고, 이어서 실행하면 세대 번호가 계속 올라간다', async () => {
  const engine = await makeEngine();
  await engine.run({ ...FAST, generations: 1 });
  const r = await engine.run({ ...FAST, generations: 99, stopWhenConverged: false });
  assert.equal(r.run.total, 5);
  assert.equal(r.run.startGen, 2);
  assert.equal(r.gen, 6);
});

test('실행 중에는 다시 실행하거나 초기화할 수 없다 (409)', async () => {
  const engine = await makeEngine();
  const p = engine.run({ stageDelayMs: 20, generations: 1 });
  await assert.rejects(engine.run(FAST), (e) => e.status === 409);
  await assert.rejects(engine.reset(), (e) => e.status === 409);
  await p;
});

test('같은 시드로 초기화하면 데모 결과가 똑같이 재현된다', async () => {
  const runOnce = async (seed) => {
    const engine = await makeEngine();
    await engine.reset({ seed });
    const r = await engine.run({ ...FAST, stopWhenConverged: false });
    return { history: r.history, deployed: r.deployed.map((d) => [d.id, d.pattern, d.flags.join('')]) };
  };
  const a = await runOnce(DEMO_SEED);
  const b = await runOnce(DEMO_SEED);
  assert.deepEqual(a, b);
  assert.equal((await makeEngine().then((e) => e.reset({ seed: 7 }))).seed, 7);
  await assert.rejects((await makeEngine()).reset({ seed: 'abc' }), (e) => e.status === 400);
});

test('세대 진행이 onChange(SSE)로 단계마다 전달된다', async () => {
  const seen = [];
  const engine = await makeEngine((rep) => seen.push({ gen: rep.gen, stage: rep.activeStage, current: rep.run?.current, busy: rep.busy }));
  await engine.run({ ...FAST, generations: 2, stopWhenConverged: false });
  for (const g of [1, 2]) {
    const stages = new Set(seen.filter((s) => s.gen === g && s.stage !== null).map((s) => s.stage));
    assert.deepEqual([...stages].sort(), [0, 1, 2, 3, 4], `${g}세대 5단계 모두 전송`);
  }
  assert.equal(seen.at(-1).busy, false);
  assert.equal(seen.at(-1).current, 2);
});

test('시드 없이 초기화하면 수렴이 확인된 시드 중 하나를 무작위로 고른다', async () => {
  const engine = await makeEngine();
  const picked = new Set();
  for (let i = 0; i < 30; i++) {
    const r = await engine.reset(i % 2 ? {} : { seed: 'random' });
    assert.ok(GOOD_SEEDS.includes(r.seed), `GOOD_SEEDS 밖의 시드: ${r.seed}`);
    picked.add(r.seed);
  }
  assert.ok(picked.size > 1, '30번 초기화했는데 항상 같은 시드'); // 매번 다른 진행을 보여줘야 한다
  assert.match(engine.report().logs[0].msg, /무작위 시드/);
});

test('GOOD_SEEDS는 모두 4세대 안에 오탐 0%로 수렴한다 (데이터·로직이 바뀌면 이 테스트가 깨진다)', async () => {
  const slow = [];
  for (const s of GOOD_SEEDS) {
    const engine = await makeEngine();
    await engine.reset({ seed: s });
    let r;
    // 프론트 "자동 진화"와 같은 방식: 1세대씩, 기본 슬라이더 값
    do { r = await engine.run({ ...FAST, generations: 1, fpMax: 0, bypMax: 10, intensity: 2 }); } while (!r.converged && r.gen < 4);
    if (!r.converged || r.kpis.fp !== 0) slow.push(`${s}(gen ${r.gen}, detect ${r.kpis.detect.toFixed(2)})`);
  }
  assert.deepEqual(slow, [], `4세대 안에 수렴하지 못한 시드: ${slow.join(', ')}`);
});
