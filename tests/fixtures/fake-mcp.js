#!/usr/bin/env node
// 假的外部 MCP 服务（走标准输入输出）：两个工具，一个只读（list_users，自己标了 readOnlyHint），一个会改动（send_message）。
// 每次调用记到 FAKE_MCP_LOG，测试拿来核对 Hola 转过来的调用；顺便核对密钥确实传到了服务这边（API_TOKEN）。
'use strict';
const fs = require('fs');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const TOOLS = [
  { name: 'list_users', description: '列出用户', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'send_message', description: '发一条消息', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    else if (m.method === 'tools/call') {
      const p = m.params || {};
      if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ name: p.name, args: p.arguments, token: process.env.API_TOKEN }) + '\n');
      const text = p.name === 'list_users' ? '张三, 李四' : `已发送：${(p.arguments || {}).text}`;
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
    } else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
