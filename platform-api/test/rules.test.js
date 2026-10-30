import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalize, ruleMatches, isSafePattern } from '../src/utils/matcher.js';
import { generateVariants } from '../src/utils/mutate.js';
import { createRng } from '../src/utils/rng.js';
import { evalDetection, evalFalsePositive, evalBypass, judge } from '../src/services/validate.js';
import { renderConf, renderRule } from '../src/services/deploy.js';
import { toWire } from '../src/services/waf.js';

const read = async (name) => JSON.parse(await fs.readFile(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
const GOOD_SQLI = "'\\s*(OR|AND)\\s+'?\\w+'?\\s*=\\s*'?\\w+|UNION\\s+(ALL\\s+)?SELECT|;\\s*DROP\\s+TABLE";

test('normalize는 URL 인코딩과 주석을 되돌린다', () => {
  assert.equal(normalize('a%27%20OR', ['url']), "a' OR");
  assert.equal(normalize("a'/**/OR", ['cmt']), "a' OR");
});

test('isSafePattern은 깨진 정규식과 너무 긴 패턴을 거른다', () => {
  assert.equal(isSafePattern('(unclosed'), false);
  assert.equal(isSafePattern('a'.repeat(301)), false);
  assert.equal(isSafePattern('union\\s+select'), true);
});

test('과하게 넓은 룰(select)은 정상 요청을 막아 오탐으로 탈락한다', async () => {
  const normal = await read('normal.json');
  const broad = { type: 'sqli', pattern: 'select', flags: ['i'] };
  evalFalsePositive(broad, normal);
  assert.ok(broad.fp > 0);
  assert.equal(judge({ ...broad, detect: 1, bypass: 0 }, { fp: 0, byp: 0.1, detect: 0.75 }), 'fp');
});

test('일반화된 SQLi 룰은 오탐이 없고 원본 공격을 모두 잡는다', async () => {
  const [normal, attacks] = await Promise.all([read('normal.json'), read('attacks.json')]);
  const good = { type: 'sqli', pattern: GOOD_SQLI, flags: ['i'] };
  evalFalsePositive(good, normal);
  evalDetection(good, attacks.sqli);
  assert.equal(good.fp, 0);
  assert.equal(good.detect, 1);
});

test('원문 복사형 룰은 변형 공격에 뚫리고, 정규화 플래그를 켜면 줄어든다', async () => {
  const attacks = await read('attacks.json');
  const variants = generateVariants('sqli', attacks.sqli, 12, 3, createRng(1));
  const literal = { type: 'sqli', pattern: "1' OR 1=1--", flags: [] };
  evalBypass(literal, variants);
  assert.ok(literal.bypass > 0.5);

  const hardened = { type: 'sqli', pattern: GOOD_SQLI, flags: ['i', 'url', 'url2', 'cmt', 'ws'] };
  evalBypass(hardened, variants);
  assert.ok(hardened.bypass < literal.bypass);
});

test('같은 시드면 변형 공격이 같다 (데모 재현성)', async () => {
  const attacks = await read('attacks.json');
  const a = generateVariants('xss', attacks.xss, 4, 2, createRng(7)).map((v) => v.text);
  const b = generateVariants('xss', attacks.xss, 4, 2, createRng(7)).map((v) => v.text);
  assert.deepEqual(a, b);
});

test('renderRule은 정규화 플래그를 ModSecurity 변환 함수로 바꾼다', () => {
  const line = renderRule({ id: 'R012', type: 'sqli', pattern: 'a"b', flags: ['i', 'url2', 'cmt'] });
  assert.match(line, /^SecRule REQUEST_URI_RAW\|ARGS_POST "@rx \(\?i\)a\\"b"/);
  assert.match(line, /id:1000012/);
  assert.equal((line.match(/t:urlDecodeUni/g) ?? []).length, 2);
  assert.match(line, /t:replaceComments/);
  assert.doesNotMatch(line, /t:removeComments/);
});

test('renderConf는 적용 여부를 확인하는 규칙을 항상 넣는다', () => {
  assert.match(renderConf([], 'abc'), /x-anvil-reload "@streq abc".*status:418/);
});

test('renderRule은 HTTP 디코딩을 기본 1회 적용한다', () => {
  const line = renderRule({ id: 'R001', type: 'sqli', pattern: 'a', flags: [] });
  assert.equal((line.match(/t:urlDecodeUni/g) ?? []).length, 1);
});

test('toWire는 HTTP에 못 싣는 문자만 인코딩하고 기존 %XX는 유지한다', () => {
  assert.equal(toWire("/s?q=a'\tb#c<d"), "/s?q=a'%09b%23c%3Cd");
  assert.equal(toWire('/s?q=%2527%20x'), '/s?q=%2527%20x');
});

test('ruleMatches는 정규화 후 요청에 패턴을 적용한다', () => {
  const rule = { pattern: 'union\\s+select', flags: ['i', 'cmt'] };
  assert.equal(ruleMatches(rule, "/s?q=1'/**/UnIoN/**/SeLeCt"), true);
  assert.equal(ruleMatches(rule, '/s?q=union jobs'), false);
});
