import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config, backendRoot } from '../config.js';
import { RELOAD_HEADER, waitForReload } from './waf.js';

const sh = promisify(exec);

/**
 * 룰 하나를 ModSecurity SecRule 한 줄로 바꾼다.
 * 정규화 플래그는 ModSecurity 변환 함수(t:)로 대응시킨다.
 * URL 디코딩은 HTTP를 거친 요청이면 항상 필요해서 기본 1회이고, url2만 1회를 더한다.
 * ARGS와 REQUEST_URI는 이미 디코딩된 값이라 원문인 REQUEST_URI_RAW로 검사해야 디코딩 횟수가 겹치지 않는다.
 * 본문은 ARGS_POST로 검사한다 (JSON 본문은 REQUEST_BODY가 비어 있음).
 */
export function renderRule(rule) {
  const id = 1000000 + Number(rule.id.replace(/\D/g, ''));
  const pattern = (rule.flags.includes('i') ? '(?i)' : '') + rule.pattern.replace(/"/g, '\\"');
  const transforms = ['t:none'];
  const decodes = rule.flags.includes('url2') ? 2 : 1;
  for (let i = 0; i < decodes; i++) transforms.push('t:urlDecodeUni');
  // removeComments는 주석을 공백 없이 지워 UNION/**/SELECT → UNIONSELECT 가 되므로
  // matcher.js의 normalize(주석 → 공백)와 같은 결과를 내는 replaceComments를 쓴다
  if (rule.flags.includes('cmt')) transforms.push('t:replaceComments');
  if (rule.flags.includes('ws')) transforms.push('t:compressWhitespace');
  return `SecRule REQUEST_URI_RAW|ARGS_POST "@rx ${pattern}" "id:${id},phase:2,deny,status:403,log,msg:'ANVIL ${rule.id} ${rule.type}',${transforms.join(',')}"`;
}

export function renderConf(rules, stamp) {
  const lines = [
    '# ANVIL이 자동으로 쓰는 파일입니다. 직접 수정하지 마세요.',
    `# 생성 시각: ${new Date().toISOString()} / 규칙 ${rules.length}개`,
    `SecRule REQUEST_HEADERS:${RELOAD_HEADER} "@streq ${stamp}" "id:1999999,phase:1,deny,status:418,nolog"`,
  ];
  if (!rules.length) lines.push('# 아직 배포된 규칙이 없습니다.');
  for (const r of rules) lines.push(`# ${r.id} (${r.type}, ${r.gen}세대)`, renderRule(r));
  return lines.join('\n') + '\n';
}

async function run(cmd) {
  await sh(cmd, { cwd: backendRoot, timeout: 20000 });
}

/**
 * 규칙 파일을 쓰고 WAF에 반영한다.
 * 테스트나 reload가 실패하면 이전 파일로 되돌리고 오류를 던진다.
 * 파일은 삭제·교체하지 않고 같은 파일에 덮어써야 Docker 파일 마운트가 유지된다.
 */
export async function applyRules(rules) {
  const file = config.wafRulesFile;
  let previous = null;
  try { previous = await fs.readFile(file, 'utf8'); } catch { /* 첫 배포 */ }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const stamp = Date.now().toString(36);
  await fs.writeFile(file, renderConf(rules, stamp));

  if (!config.wafTestCmd && !config.wafReloadCmd) return { reloaded: false };
  try {
    if (config.wafTestCmd) await run(config.wafTestCmd);
    if (config.wafReloadCmd) {
      await run(config.wafReloadCmd);
      await waitForReload(stamp);
    }
    return { reloaded: true };
  } catch (err) {
    if (previous !== null) {
      await fs.writeFile(file, previous);
      if (config.wafReloadCmd) await run(config.wafReloadCmd).catch(() => {});
    }
    throw new Error(`WAF 반영 실패, 이전 규칙으로 되돌림: ${String(err.message).split('\n')[0]}`);
  }
}
