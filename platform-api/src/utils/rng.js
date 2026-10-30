// 시드 고정 난수: 같은 시드면 같은 결과가 나와서 데모를 재현할 수 있다
export function createRng(seed = 20261031) {
  let s = seed | 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  return {
    rand,
    pick,
    getSeed: () => s,
    setSeed: (v) => { s = v | 0; },
  };
}
