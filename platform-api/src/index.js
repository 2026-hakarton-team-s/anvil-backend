import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { loadSeed, loadState, newState } from './store.js';
import { createRng } from './utils/rng.js';
import { createEngine } from './services/engine.js';
import { createRouter } from './routes/index.js';

const seed = await loadSeed();
const rng = createRng();
const state = (await loadState()) ?? newState(rng.getSeed(), seed);
rng.setSeed(state.rngSeed);

// SSE: 상태가 바뀔 때마다 접속 중인 화면에 report를 밀어준다
const clients = new Set();
const broadcast = (report) => {
  const msg = `event: report\ndata: ${JSON.stringify(report)}\n\n`;
  for (const c of clients) c.write(msg);
};
const addSseClient = (req, res, report) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: report\ndata: ${JSON.stringify(report)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
};

const engine = createEngine({ seed, state, rng, onChange: broadcast });

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '100kb' }));
app.use('/api', createRouter(engine, addSseClient));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`ANVIL platform-api: http://localhost:${config.port}`);
  console.log(`  WAF 연동: ${config.wafUrl || '꺼짐 (WAF_URL 없음)'} / OpenAI: ${config.openaiKey ? '켜짐' : '꺼짐 (패턴 풀 사용)'}`);
});
