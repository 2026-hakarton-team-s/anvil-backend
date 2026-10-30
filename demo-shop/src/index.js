import express from 'express';

// WAF가 지키는 샘플 쇼핑 API.
// DB, 파일, 명령 실행을 전혀 쓰지 않고 받은 값을 그대로 돌려주기만 한다 (실제 취약점 없음).
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ service: 'demo-shop', ok: true }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/search', (req, res) => res.json({ query: req.query.q ?? '', results: [] }));
app.get('/item', (req, res) => res.json({ id: req.query.id ?? null, name: 'sample item', price: 12000 }));
app.get('/download', (req, res) => res.json({ file: req.query.file ?? null, note: 'demo: no file access' }));
app.post('/login', (req, res) => res.json({ user: req.body?.user ?? null, token: 'demo-token' }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`demo-shop: http://localhost:${port}`));
