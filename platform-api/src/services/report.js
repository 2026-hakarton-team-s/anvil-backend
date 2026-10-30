import { TYPE_KEYS } from '../utils/constants.js';

const publicRule = (r) => ({
  id: r.id,
  type: r.type,
  pattern: r.pattern,
  tier: r.tier,
  flags: r.flags,
  gen: r.gen,
  status: r.status,
  detect: r.detect,
  fp: r.fp,
  bypass: r.bypass,
  fpSamples: r.fpSamples ?? [],
  bypassSamples: r.bypassSamples ?? [],
});

/** 프론트가 /api/report 와 SSE로 받는 화면용 데이터 (명세는 docs/api.md) */
export function buildReport(st, config) {
  const last = st.history[st.history.length - 1];
  const deployed = TYPE_KEYS.map((t) => st.deployed[t]).filter(Boolean);
  const techniques = new Set(deployed.flatMap((r) => r.flags));
  const attacks = TYPE_KEYS.flatMap((t) => st.corpus[t].map((a) => ({ type: t, text: a.text, learned: !!a.learned })));
  return {
    gen: st.gen,
    busy: st.busy,
    activeStage: st.activeStage,
    stages: st.stages,
    // 자동 반복 진행 상황: { total, current, startGen, endGen, stoppedEarly, startedAt, finishedAt } 또는 null
    run: st.run ?? null,
    seed: st.seed ?? null,
    converged: last.bypass === 0 && deployed.length === TYPE_KEYS.length && st.gen >= 3,
    kpis: {
      deployed: deployed.length,
      totalTypes: TYPE_KEYS.length,
      detect: last.detect,
      bypass: last.bypass,
      fp: last.fp,
      techniques: techniques.size,
      corpus: attacks.length,
    },
    candidates: st.candidates.map(publicRule),
    deployed: deployed.map(publicRule),
    history: st.history,
    corpus: { attacks, learned: attacks.filter((a) => a.learned).length },
    logs: st.logs,
    env: { wafConnected: !!config.wafUrl, aiEnabled: !!config.openaiKey },
  };
}
