import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { TYPE_KEYS } from './utils/constants.js';

const readJson = async (name) => JSON.parse(await fs.readFile(path.join(config.dataDir, name), 'utf8'));
const stateFile = path.join(config.dataDir, 'state.json');

/** 공격 샘플, 정상 요청, 룰 후보 풀 (읽기 전용 시드 데이터) */
export async function loadSeed() {
  const [attacks, normal, pool] = await Promise.all([
    readJson('attacks.json'),
    readJson('normal.json'),
    readJson('rule-candidates.json'),
  ]);
  return { attacks, normal, pool };
}

export function newState(rngSeed, seed) {
  const byType = (fn) => Object.fromEntries(TYPE_KEYS.map((t) => [t, fn(t)]));
  return {
    gen: 0,
    ruleSeq: 0,
    rngSeed,
    busy: false,
    activeStage: null,
    stages: ['', '', '', '', ''],
    corpus: byType((t) => seed.attacks[t].map((text) => ({ text, learned: false, techs: [] }))),
    learned: byType(() => []), // 유형별로 지난 세대에 당한 우회 기법(정규화 플래그)
    deployed: {},              // 유형 → 배포된 룰
    candidates: [],
    history: [{ gen: 0, detect: 0, bypass: 1, fp: 0 }],
    logs: [],
  };
}

export async function loadState() {
  try {
    const s = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    s.busy = false;
    s.activeStage = null;
    return s;
  } catch {
    return null;
  }
}

export async function saveState(state) {
  await fs.writeFile(stateFile, JSON.stringify(state));
}
