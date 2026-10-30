import { ruleMatches } from '../utils/matcher.js';
import { TECHNIQUES } from '../utils/mutate.js';

/** 탐지율: 이 유형의 원본 공격을 몇 % 잡나 */
export function evalDetection(rule, seedAttacks) {
  const hit = seedAttacks.filter((s) => ruleMatches(rule, s)).length;
  rule.detect = seedAttacks.length ? hit / seedAttacks.length : 0;
}

/** STEP 3: 정상 요청 중 몇 %를 잘못 막나 */
export function evalFalsePositive(rule, normal) {
  const fps = normal.filter((n) => ruleMatches(rule, n));
  rule.fp = fps.length / normal.length;
  rule.fpSamples = fps.slice(0, 3);
}

/** STEP 4: AI 변형 공격 중 몇 %가 룰을 뚫나. 뚫은 기법은 다음 세대가 학습 */
export function evalBypass(rule, variants) {
  const mine = variants.filter((v) => v.type === rule.type);
  const escaped = mine.filter((v) => !ruleMatches(rule, v.text));
  rule.bypass = mine.length ? escaped.length / mine.length : 0;
  rule.bypassSamples = escaped.slice(0, 3).map((v) => ({ text: v.text, techs: v.techs }));
  const flags = new Set();
  escaped.forEach((v) => (v.techs ?? []).forEach((t) => TECHNIQUES[t] && flags.add(TECHNIQUES[t].flag)));
  rule.bypassTechs = [...flags];
}

/** 생존 판정: 오탐 → 탐지 부족 → 우회 순으로 걸러낸다 */
export function judge(rule, th) {
  if (rule.fp > th.fp + 1e-9) return 'fp';
  if (rule.detect < th.detect) return 'det';
  if (rule.bypass > th.byp + 1e-9) return 'byp';
  return 'ok';
}
