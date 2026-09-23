// 假秒懂：按「方法 路径」路由，记录每个请求供断言。routes 可在测试中途替换，用来模拟状态变化。
import { createServer } from 'node:http';

export function ok(data, extra = {}) {
  return { status: 200, body: { code: 0, data, ...extra } };
}

export async function startFakeMiaodong(routes = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : null,
        auth: req.headers.authorization ?? null,
      };
      requests.push(record);
      const handler = routes[`${req.method} ${url.pathname}`];
      const reply = handler
        ? await handler(record)
        : { status: 404, body: { message: `Cannot ${req.method} ${url.pathname}`, error: 'Not Found', statusCode: 404 } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, routes, close: () => new Promise((resolve) => server.close(resolve)) };
}
