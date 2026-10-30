import { Router } from 'express';

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function createRouter(engine, addSseClient) {
  const r = Router();

  r.get('/health', (req, res) => res.json({ ok: true }));
  r.get('/report', (req, res) => res.json(engine.report()));
  r.get('/events', (req, res) => addSseClient(req, res, engine.report()));

  // 여러 세대 자동 실행 (기본 3세대). body: { generations, fpMax, bypMax, intensity, stageDelayMs, generationDelayMs, stopWhenConverged } (모두 선택)
  // wait=false 를 주면 끝날 때까지 기다리지 않고 바로 202를 돌려준다 (진행은 /api/events SSE로 확인)
  r.post('/run', async (req, res, next) => {
    const opts = req.body ?? {};
    if (opts.wait === false) {
      if (engine.report().busy) return next(Object.assign(new Error('이미 실행 중입니다'), { status: 409 }));
      engine.run(opts).catch((e) => console.error('[run]', e));
      return res.status(202).json({ started: true });
    }
    try { res.json(await engine.run(opts)); } catch (e) { next(e); }
  });

  // 초기화. body: { seed } (선택, 기본 20261031)
  r.post('/reset', async (req, res, next) => {
    try { res.json(await engine.reset(req.body ?? {})); } catch (e) { next(e); }
  });

  // 데모 한 번에: 시드 고정 초기화 후 자동 실행. body: { seed, generations, ... } (선택)
  // 바로 202를 돌려주고 진행은 SSE로 보여준다 (발표 때 버튼 하나로 처음부터 재현)
  r.post('/demo', async (req, res, next) => {
    try {
      const opts = req.body ?? {};
      await engine.reset({ seed: opts.seed });
      engine.run(opts).catch((e) => console.error('[demo]', e));
      res.status(202).json({ started: true, seed: engine.report().seed });
    } catch (e) { next(e); }
  });

  // 요청 하나를 현재 배포 룰(과 WAF)로 검사. body: { request: "/search?q=..." }
  r.post('/test', async (req, res, next) => {
    try {
      const request = req.body?.request;
      if (typeof request !== 'string' || !request.startsWith('/') || request.startsWith('//') || request.length > 2000) {
        throw bad('request는 "/"로 시작하는 2000자 이하 문자열이어야 합니다');
      }
      res.json(await engine.test(request));
    } catch (e) { next(e); }
  });

  // 테스트용 샘플 요청. /api/samples?kind=normal|attack|mutated
  r.get('/samples', (req, res, next) => {
    try { res.json({ request: engine.sample(req.query.kind) }); } catch (e) { next(e); }
  });

  return r;
}
