import express from 'express';

// WAF가 지키는 샘플 쇼핑 API.
// /login과 /search는 문자열로 이어 붙인 SQL의 취약한 동작을 메모리 안에서 흉내 낸다.
// 실제 DB, 파일, 명령 실행은 전혀 쓰지 않으므로 뚫려도 아래 가짜 데이터만 응답된다.
const app = express();
app.use(express.json());

const USERS = [
  { id: 1, username: 'admin', password: 'fake-admin-pass', role: 'admin' },
  { id: 2, username: 'kim', password: 'fake-kim-pass', role: 'user' },
];
const ITEMS = ['running shoes', 'canvas shoes', 'wool socks'];

const LOGIN_BYPASS = /'\s*(or|and)\s+'?\w+'?\s*=\s*'?\w+|'\s*(--|#)/i;
const UNION_SELECT = /union\s+(all\s+)?select/i;

function login(user = '', password = '') {
  const input = `${user} ${password}`;
  if (LOGIN_BYPASS.test(input)) return { ok: true, breached: true, user: USERS[0].username, role: USERS[0].role, token: 'demo-token' };
  const found = USERS.find((u) => u.username === user && u.password === password);
  return found ? { ok: true, breached: false, user: found.username, role: found.role, token: 'demo-token' } : { ok: false, breached: false };
}

app.get('/', (req, res) => res.json({ service: 'demo-shop', ok: true }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/search', (req, res) => {
  const q = String(req.query.q ?? '');
  if (UNION_SELECT.test(q)) return res.json({ query: q, breached: true, results: USERS });
  res.json({ query: q, breached: false, results: ITEMS.filter((i) => q && i.includes(q.toLowerCase())) });
});
app.get('/item', (req, res) => res.json({ id: req.query.id ?? null, name: 'sample item', price: 12000 }));
app.get('/download', (req, res) => res.json({ file: req.query.file ?? null, note: 'demo: no file access' }));
app.get('/login', (req, res) => {
  const result = login(String(req.query.user ?? ''), String(req.query.password ?? ''));
  res.status(result.ok ? 200 : 401).json(result);
});
app.post('/login', (req, res) => {
  const result = login(String(req.body?.user ?? ''), String(req.body?.password ?? ''));
  res.status(result.ok ? 200 : 401).json(result);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`demo-shop: http://localhost:${port}`));
