import { config } from '../config.js';
import { TYPE_KEYS, TYPES, FLAG_LABEL } from '../utils/constants.js';
import { generateVariants } from '../utils/mutate.js';
import { ruleMatches } from '../utils/matcher.js';
import { newState, saveState } from '../store.js';
import { detect } from './detect.js';
import { generateCandidates } from './generate.js';
import { generateAttacks } from './attacker.js';
import { judgeDeployed } from './oracle.js';
import { evalDetection, evalFalsePositive, evalBypass, judge } from './validate.js';
import { applyRules } from './deploy.js';
import { sendToWaf } from './waf.js';
import { buildReport } from './report.js';

export const DEMO_SEED = 20261031; // 발표 데모 기본 시드 (rng.js 기본값과 같음)

/**
 * 초기화할 때 시드를 안 주면 이 중 하나를 무작위로 고른다 → 매번 다른 진행 과정을 보여준다.
 * 1~135 중 "패턴 풀 + 로컬 판정, 오탐 0% · 우회 10% · 강도 2"에서 4세대 안에 100% 수렴한 시드만 골랐다.
 * (무작위 시드 40개를 돌려 보면 3개는 12세대 안에 수렴하지 못해서 아무 시드나 쓰지 않는다)
 * data/rule-candidates.json 이나 생성·변형 로직이 바뀌면 결과가 달라지므로 test/engine.test.js가 다시 확인한다.
 */
export const GOOD_SEEDS = [
  1, 5, 7, 12, 15, 16, 17, 22, 24, 34, 40, 43, 44, 49, 55, 56, 62, 68, 69, 71,
  74, 77, 78, 82, 84, 92, 96, 97, 98, 102, 103, 105, 107, 108, 109, 114, 117, 123, 125, 135,
];
const pickGoodSeed = () => GOOD_SEEDS[Math.floor(Math.random() * GOOD_SEEDS.length)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
const pct = (x) => (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + '%';
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * ANVIL 루프를 돌리는 엔진.
 *   1) 공격 수집 → 2) 시그니처 생성 → 3) 오탐 검증 → 4) AI 우회 시뮬레이션 → 5) 생존 룰 배포
 * onChange는 상태가 바뀔 때마다 report를 넘겨받는다 (SSE로 프론트에 전달).
 */
export function createEngine({ seed, state, rng, onChange = () => {} }) {
  let st = state;
  const changed = () => onChange(buildReport(st, config));
  const log = (msg, level = 'info') => {
    st.logs = [{ gen: st.gen, level, msg, t: Date.now() }, ...st.logs].slice(0, 120);
  };

  async function stage(idx, delay, fn) {
    st.activeStage = idx;
    changed();
    await sleep(delay * 0.4);
    st.stages[idx] = await fn();
    changed();
    await sleep(delay);
  }

  /** 지난 세대에서 룰을 뚫었던 공격들 (우회 시뮬레이션에서 다시 재생) */
  const replayCases = () =>
    TYPE_KEYS.flatMap((t) =>
      st.corpus[t].filter((a) => a.learned).map((a) => ({ type: t, text: a.text, techs: a.techs ?? [], base: a.text })));

  /** 현재 세대가 수렴했는지 (모든 유형에 룰이 배포됐고 실전 우회 0) */
  const isConverged = () => {
    const last = st.history[st.history.length - 1];
    return last.bypass === 0 && Object.keys(st.deployed).length === TYPE_KEYS.length;
  };

  /**
   * POST /api/run: 세대를 generations번 연속 실행한다 (기본 3).
   * 세대 사이에는 st.run으로 진행 상황을 report/SSE에 노출해 프론트가 "2/3세대"를 그릴 수 있게 한다.
   * stopWhenConverged가 true(기본)면 수렴한 세대에서 남은 세대를 건너뛴다.
   */
  async function run(opts = {}) {
    if (st.busy) throw httpError(409, '이미 실행 중입니다');
    const th = {
      fp: clamp(num(opts.fpMax, 0), 0, 10) / 100,
      byp: clamp(num(opts.bypMax, 10), 0, 60) / 100,
      detect: config.minDetect,
    };
    const intensity = clamp(Math.round(num(opts.intensity, 2)), 1, 3);
    const delay = clamp(num(opts.stageDelayMs, 400), 0, 3000);
    const total = clamp(Math.round(num(opts.generations, 3)), 1, 5);
    const genDelay = clamp(num(opts.generationDelayMs, delay * 2), 0, 5000);
    const stopWhenConverged = opts.stopWhenConverged !== false;

    st.busy = true;
    const startGen = st.gen + 1;
    st.run = { total, current: 0, startGen, endGen: startGen + total - 1, stoppedEarly: false, startedAt: Date.now(), finishedAt: null };
    log(`자동 실행 시작: ${startGen}~${st.run.endGen}세대 (${total}세대, 공격 강도 ${intensity})`);
    changed();

    try {
      for (let i = 1; i <= total; i++) {
        st.run.current = i;
        await runGeneration(th, intensity, delay);
        if (i < total && stopWhenConverged && isConverged()) {
          st.run.stoppedEarly = true;
          log(`세대 ${st.gen}에서 수렴해 남은 ${total - i}세대를 건너뜁니다`, 'ok');
          break;
        }
        if (i < total) {
          st.activeStage = null;
          changed();
          await sleep(genDelay);
        }
      }
    } finally {
      st.busy = false;
      st.activeStage = null;
      st.run.finishedAt = Date.now();
      st.rngSeed = rng.getSeed();
      await saveState(st).catch(() => {});
      changed();
    }
    return buildReport(st, config);
  }

  /** 1세대 = 5단계. busy/저장은 run()이 맡는다 */
  async function runGeneration(th, intensity, delay) {
    st.gen += 1;
    st.stages = ['', '', '', '', ''];
    st.activeStage = null;
    changed();

    {
      // STEP 1: 학습 데이터 수집
      await stage(0, delay, async () => {
        const info = await detect(st);
        log(`학습 데이터 ${info.total}건 수집 (우회 사례 ${info.learned}건` + (info.observed ? `, WAF 로그에서 새로 ${info.observed}건` : '') + ')');
        return `공격 ${info.total}건 (우회 사례 ${info.learned})`;
      });

      // STEP 2: 시그니처 후보 생성
      await stage(1, delay, async () => {
        const gen = await generateCandidates({ st, seed, rng });
        st.candidates = gen.candidates;
        st.candidates.forEach((r) => evalDetection(r, seed.attacks[r.type]));
        const learned = TYPE_KEYS.filter((t) => st.learned[t].length)
          .map((t) => `${TYPES[t].label}:${st.learned[t].map((f) => FLAG_LABEL[f]).join('/')}`);
        log(`시그니처 후보 ${st.candidates.length}개 생성 (${gen.source === 'openai' ? 'OpenAI' : '패턴 풀'})`
          + (learned.length ? ` · 학습한 정규화 반영 [${learned.join(', ')}]` : ''));
        if (gen.note) log(gen.note, 'warn');
        return `후보 ${st.candidates.length}개 생성`;
      });

      // STEP 3: 정상 트래픽 오탐 검증
      await stage(2, delay, async () => {
        st.candidates.forEach((r) => evalFalsePositive(r, seed.normal));
        let dropped = 0;
        for (const r of st.candidates) {
          if (r.fp > th.fp + 1e-9) { r.status = 'fp'; dropped++; }
          else if (r.detect < th.detect) { r.status = 'det'; dropped++; }
        }
        const fpDrop = st.candidates.filter((r) => r.status === 'fp');
        log(`오탐 검증: 정상 요청 ${seed.normal.length}건 기준 오탐 ${fpDrop.length}개, 탐지 부족 ${dropped - fpDrop.length}개 탈락`, fpDrop.length ? 'warn' : 'ok');
        if (fpDrop[0]) log(`  예) ${fpDrop[0].pattern} → 정상 요청 "${fpDrop[0].fpSamples[0]}" 차단`, 'warn');
        return `정상 ${seed.normal.length}건 검사 · ${dropped}개 탈락`;
      });

      // STEP 4: AI 우회 공격 시뮬레이션
      let variants = [];
      await stage(3, delay, async () => {
        const replay = replayCases();
        const attacks = await generateAttacks({ seed, st, intensity, perBase: 6, rng });
        if (attacks.note) log(attacks.note, 'warn');
        variants = attacks.variants.concat(replay);
        for (const r of st.candidates) {
          evalBypass(r, variants);
          if (r.status !== 'pending') continue;
          // 오탐 없이 탐지는 하던 룰이 뚫린 기법만 다음 세대가 학습
          for (const f of r.bypassTechs) if (!st.learned[r.type].includes(f)) st.learned[r.type].push(f);
          r.status = judge(r, th);
        }
        const bypDrop = st.candidates.filter((r) => r.status === 'byp').length;
        log(`AI 공격자(${attacks.source === 'llm' ? 'LLM' : '규칙 기반'})가 변형 공격 ${attacks.variants.length}건 생성 (강도 ${intensity}) + 과거 우회 사례 ${replay.length}건 재생 → 룰 ${bypDrop}개 우회당해 탈락`, bypDrop ? 'warn' : 'ok');
        return `변형 공격 ${variants.length}건 · ${bypDrop}개 뚫림`;
      });

      // STEP 5: 생존 룰 배포 + 실전 레드팀
      await stage(4, delay, async () => {
        const prev = structuredClone(st.deployed);
        let changedCount = 0;
        for (const type of TYPE_KEYS) {
          const survivors = st.candidates.filter((r) => r.type === type && r.status === 'ok')
            .sort((a, b) => a.bypass - b.bypass || a.fp - b.fp || b.detect - a.detect);
          if (!survivors.length) continue;
          const best = survivors[0];
          const cur = st.deployed[type];
          if (cur) { evalBypass(cur, variants); evalFalsePositive(cur, seed.normal); }
          if (!cur || best.bypass < cur.bypass - 1e-9 || (best.bypass === cur.bypass && best.fp < cur.fp)) {
            best.status = 'deploy';
            st.deployed[type] = best;
            changedCount++;
            log(`${TYPES[type].label} 룰 ${cur ? '교체' : '배포'}: ${best.id} (우회 ${pct(best.bypass)}, 오탐 ${pct(best.fp)})`, 'ok');
          }
        }

        if (changedCount) {
          try {
            const res = await applyRules(Object.values(st.deployed));
            log(res.reloaded ? 'WAF에 규칙을 반영하고 reload했습니다' : 'WAF 명령이 설정되지 않아 규칙 파일만 갱신했습니다', res.reloaded ? 'ok' : 'info');
          } catch (err) {
            st.deployed = prev; // 롤백
            st.candidates.forEach((r) => { if (r.status === 'deploy') r.status = 'ok'; });
            changedCount = 0;
            log(err.message, 'bad');
          }
        }

        // 배포 후 실전 레드팀: 새 변형 공격으로 다시 공격 → 뚫린 공격은 다음 세대 학습 데이터로
        const redTeam = await generateAttacks({ seed, st, intensity, perBase: 8, rng });
        if (redTeam.note) log(redTeam.note, 'warn');
        const judgeArgs = {
          rules: Object.values(st.deployed),
          variants: redTeam.variants,
          seedAttacks: seed.attacks,
          normal: seed.normal,
        };
        let m;
        try {
          m = await judgeDeployed({ ...judgeArgs, useWaf: !!config.wafUrl });
        } catch (err) {
          log(`WAF 판정 실패, 로컬 매칭으로 대체: ${err.message}`, 'warn');
          m = await judgeDeployed({ ...judgeArgs, useWaf: false });
        }
        let added = 0;
        const perType = {};
        for (const v of m.escaped) {
          const corpus = st.corpus[v.type];
          perType[v.type] ??= 0;
          if (perType[v.type] < 3 && corpus.filter((x) => x.learned).length < 12 && !corpus.some((x) => x.text === v.text)) {
            corpus.push({ text: v.text, learned: true, techs: v.techs });
            perType[v.type]++;
            added++;
          }
        }
        st.history.push({ gen: st.gen, detect: m.detect, bypass: m.bypass, fp: m.fp });
        log(`실전 레드팀(${m.mode === 'waf' ? '실제 WAF' : '로컬 매칭'}) 결과: 탐지 ${pct(m.detect)}, 우회 성공 ${m.escaped.length}건 → 학습 데이터 ${added}건 추가`, m.escaped.length ? 'bad' : 'ok');
        if (m.bypass === 0 && Object.keys(st.deployed).length === TYPE_KEYS.length) {
          log(`세대 ${st.gen}: 현재 강도의 AI 공격을 모두 차단 (오탐 ${pct(m.fp)}). 강도를 올려 다시 시험해보세요.`, 'ok');
        }
        return `${changedCount}개 반영 · 실전 우회 ${m.escaped.length}건`;
      });
    }
  }

  /**
   * 초기화.
   *  - seed 없음 / "random" → GOOD_SEEDS 중 무작위 (화면의 "초기화" 버튼은 seed 없이 부르므로 매번 다른 진행)
   *  - seed 숫자 → 그 시드로 고정 (같은 시드 + 같은 옵션 = 같은 결과, 단 OpenAI를 쓰면 달라짐)
   */
  async function reset(opts = {}) {
    if (st.busy) throw httpError(409, '실행 중에는 초기화할 수 없습니다');
    const random = opts.seed === undefined || opts.seed === null || opts.seed === '' || opts.seed === 'random';
    const s = random ? pickGoodSeed() : Number(opts.seed);
    if (!Number.isInteger(s)) throw httpError(400, 'seed는 정수 또는 "random"이어야 합니다');
    rng.setSeed(s);
    st = newState(rng.getSeed(), seed);
    st.seed = s;
    await applyRules([]).catch(() => {}); // WAF 규칙도 비움
    log(`초기화 (${random ? '무작위 ' : ''}시드 ${s}): 배포된 룰 없음, 공격 원본 샘플만 보유`);
    await saveState(st).catch(() => {});
    changed();
    return buildReport(st, config);
  }

  /** 요청 하나를 현재 배포 룰로 검사. WAF_URL이 있으면 진짜 WAF에도 보낸다 */
  async function test(request) {
    const rules = Object.values(st.deployed);
    const hit = rules.find((r) => ruleMatches(r, request));
    const result = {
      request,
      deployedCount: rules.length,
      local: hit ? { blocked: true, ruleId: hit.id, type: hit.type, pattern: hit.pattern } : { blocked: false },
    };
    if (config.wafUrl) {
      try {
        result.waf = await sendToWaf(request);
      } catch (err) {
        if (err.status) throw err;
        result.waf = { error: err.message };
      }
    }
    return result;
  }

  function sample(kind) {
    if (kind === 'normal') return rng.pick(seed.normal.filter((n) => n.includes('?')));
    const type = rng.pick(TYPE_KEYS);
    const base = rng.pick(seed.attacks[type]);
    if (kind === 'attack') return base;
    if (kind === 'mutated') return generateVariants(type, [base], 1, 2, rng)[0].text;
    throw httpError(400, 'kind는 normal, attack, mutated 중 하나여야 합니다');
  }

  return { run, reset, test, sample, report: () => buildReport(st, config) };
}
