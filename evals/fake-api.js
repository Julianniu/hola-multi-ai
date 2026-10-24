// 假的 OpenAI 兼容接口：测 API 队友的"手脚"在接口出问题时表现如何（不花钱、结果固定）
// flaky：前两次分别返回 429、500，第三次正常回答
// loop：每次都让队友去读一个不存在的文件（看它会不会一直重复下去）
'use strict';
const http = require('http');

async function fakeApi(scenario) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch (_) {}
      requests.push({ url: req.url, messages: (j.messages || []).length, tools: !!j.tools });
      const n = requests.length;
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const answer = (message) => send(200, { choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      if (scenario === 'flaky') {
        if (n === 1) return send(429, { error: { message: 'Rate limit reached, please retry later' } });
        if (n === 2) return send(500, { error: { message: 'Internal server error' } });
        return answer({ content: '收到，已完成：OK-完成' });
      }
      if (scenario === 'loop') {
        return answer({ content: '', tool_calls: [{ id: 'call_' + n, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '不存在的文件.txt' }) } }] });
      }
      answer({ content: 'OK' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, requests, close: () => new Promise((r) => srv.close(r)) };
}

// 指向假接口的 API 队友（data/members.json 的格式）
const fakeApiMember = (port, id = 'apitest') => ({
  id, name: 'API测试员', color: '#888888', strengths: '测试用', type: 'api',
  api: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-model', apiKey: '', temperature: '', vision: false, hands: true, full: false, effort: '' },
});

module.exports = { fakeApi, fakeApiMember };
