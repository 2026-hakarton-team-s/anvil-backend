import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { loadSeed, newState } from '../src/store.js';
import { judgeDeployed } from '../src/services/oracle.js';
import { detect } from '../src/services/detect.js';

test('판정용으로 보낸 요청은 WAF 로그에 있어도 학습 데이터로 다시 들어가지 않는다', async () => {
  // 가짜 WAF: 모든 요청을 허용하고, 요청 URI를 감사 로그 형식(JSON 한 줄)으로 기록한다
  const logFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-')), 'audit.log');
  const waf = http.createServer((req, res) => {
    fsSync.appendFileSync(logFile,JSON.stringify({ transaction: { request: { uri: req.url } } }) + '\n');
    res.writeHead(200);
    res.end();
  });
  await new Promise((r) => waf.listen(0, '127.0.0.1', r));
  const originalUrl = config.wafUrl;
  const originalLog = config.wafLogFile;
  config.wafUrl = `http://127.0.0.1:${waf.address().port}`;
  config.wafLogFile = logFile;
  try {
    const seed = await loadSeed();
    await judgeDeployed({
      rules: [],
      variants: [{ type: 'sqli', text: "/item?id=1'%20OR%201=1--" }],
      seedAttacks: seed.attacks,
      normal: ['/search?q=select a plan'],
      useWaf: true,
    });
    // 로그에는 판정 요청이 모두 남아 있다
    const logged = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
    assert.ok(logged.length > 0);

    const st = newState(1, seed);
    const info = await detect(st);
    assert.equal(info.observed, 0);
    assert.equal(st.corpus.sqli.some((a) => a.observed), false);
  } finally {
    config.wafUrl = originalUrl;
    config.wafLogFile = originalLog;
    await new Promise((r) => waf.close(r));
  }
});
