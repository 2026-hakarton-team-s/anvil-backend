import { Router } from 'express';

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function createRouter(engine, addSseClient) {
  const r = Router();

  r.get('/health', (req, res) => res.json({ ok: true }));
  r.get('/report', (req, res) => res.json(engine.report()));
  r.get('/events', (req, res) => addSseClient(req, res, engine.report()));

  // 1세대 실행. body: { fpMax, bypMax, intensity, stageDelayMs } (모두 선택)
  r.post('/run', async (req, res, next) => {
    try { res.json(await engine.run(req.body ?? {})); } catch (e) { next(e); }
  });

  r.post('/reset', async (req, res, next) => {
    try { res.json(await engine.reset()); } catch (e) { next(e); }
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
