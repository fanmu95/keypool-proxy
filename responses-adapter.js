'use strict';
/*
 * responses-adapter.js — Codex Responses API ⇄ Chat Completions 协议翻译层
 *
 * 链路: Codex(wire_api=responses) → 本适配器(:9189) → 9119 聚合网关 → 上游密钥池
 * 模型名保持聚合网关格式: sensenova/deepseek-v4-pro
 *
 * 支持:
 *   POST /v1/responses  非流式 + SSE 流式(增量文本/思维链, 工具调用)
 *   GET  /v1/models     透传网关聚合模型列表
 *   DELETE /v1/responses/:id  中断请求(幂等返回 200)
 *
 * 鉴权: 原样透传客户端 Authorization 头到网关(由网关 accessKey 校验)。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.ADAPTER_PORT, 10) || 9189;
const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:9119').replace(/\/+$/, '');
const LOG_FILE = path.join(__dirname, 'adapter.log');

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ─── Responses input → Chat Completions messages ───
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') parts.push(p.text);       // input_text/output_text/summary_text
  }
  return parts.join('');
}

function responsesToChat(body) {
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  let input = body.input;
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input)) input = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : null);

    if (type === 'message' && item.role) {
      const role = item.role === 'developer' ? 'system' : item.role;
      const text = textFromContent(item.content);
      if (role === 'system') messages.push({ role: 'system', content: text });
      else messages.push({ role, content: text });
    } else if (type === 'function_call' && item.name) {
      // 连续的 function_call 合并进同一条 assistant 消息
      const last = messages[messages.length - 1];
      const tc = { id: item.call_id || item.id || genId('call'), type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } };
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(tc);
      else messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
    } else if (type === 'function_call_output') {
      const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id, content: out });
    } else if (type === 'reasoning') {
      // 思维链项: 仅作上下文参考, chat 协议无法回传, 跳过
      continue;
    } else if (type === 'message' && !item.role) {
      continue;
    }
    // 其他类型(local_shell_call 等): 忽略
  }
  return messages;
}

function toolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (t && t.type === 'function' && t.name) {
      out.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } });
    }
    // 自定义/受限工具类型不映射, Codex 默认只用 function
  }
  return out.length ? out : undefined;
}

function mapToolChoice(tc) {
  if (!tc) return 'auto';
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (typeof tc === 'object' && tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

function buildChatRequest(rBody) {
  const chat = {
    model: rBody.model,
    messages: responsesToChat(rBody),
    stream: !!rBody.stream,
  };
  const tools = toolsToChat(rBody.tools);
  if (tools) { chat.tools = tools; chat.tool_choice = mapToolChoice(rBody.tool_choice); }
  const eff = rBody.reasoning && rBody.reasoning.effort;
  if (eff) chat.reasoning_effort = eff;
  if (rBody.max_output_tokens) chat.max_tokens = rBody.max_output_tokens;
  if (rBody.temperature !== undefined && rBody.temperature !== null) chat.temperature = rBody.temperature;
  if (rBody.top_p !== undefined && rBody.top_p !== null) chat.top_p = rBody.top_p;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return chat;
}

// ─── Chat 响应 → Responses 响应(非流式) ───
function buildUsage(chat) {
  const u = chat.usage || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
  };
}

function chatToResponses(chat) {
  const choice = (chat.choices && chat.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];
  if (msg.reasoning_content) {
    output.push({ type: 'reasoning', id: genId('rs'), summary: [{ type: 'summary_text', text: msg.reasoning_content }], content: null });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call', id: genId('fc'), call_id: tc.id, name: tc.function && tc.function.name,
        arguments: (tc.function && tc.function.arguments) || '{}', status: 'completed',
      });
    }
  } else {
    output.push({ type: 'message', id: genId('msg'), role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
  }
  return {
    id: 'resp_' + (chat.id || genId('x')), object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model: chat.model || '', output,
    usage: buildUsage(chat), error: null, incomplete_details: null, instructions: null,
    metadata: {}, temperature: 1, tool_choice: 'auto', tools: [], parallel_tool_calls: true,
    reasoning: { effort: null, summary: null }, store: false, text: { format: { type: 'text' } },
  };
}

// ─── 上游转发 ───
function forwardToGateway(reqPath, method, headers, bodyBuf, onResponse, onError) {
  const u = new URL(GATEWAY + reqPath);
  const fwdHeaders = { 'content-type': 'application/json' };
  if (headers['authorization']) fwdHeaders['authorization'] = headers['authorization'];
  if (headers['accept']) fwdHeaders['accept'] = headers['accept'];
  const opts = { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: fwdHeaders, timeout: 300000 };
  const req = http.request(opts, (res) => onResponse(res));
  req.on('error', onError);
  req.on('timeout', () => { req.destroy(new Error('gateway timeout')); });
  if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
  req.end();
  return req;
}

function sseWrite(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* client gone */ }
}

// ─── 流式: chat SSE → responses SSE ───
function streamResponses(req, res, chatBodyStr, model) {
  let headersSent = false;
  function startStream() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sseWrite(res, 'response.created', { type: 'response.created', response: baseResp });
    sseWrite(res, 'response.in_progress', { type: 'response.in_progress', response: baseResp });
  }

  const responseId = genId('resp');
  const baseResp = {
    id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress', model, output: [], error: null, incomplete_details: null,
    instructions: null, metadata: {}, temperature: 1, tool_choice: 'auto', tools: [],
    parallel_tool_calls: true, reasoning: { effort: null, summary: null }, store: false,
    text: { format: { type: 'text' } }, usage: null,
  };

  let outputIndex = -1;
  let rsItem = null, msgItem = null;
  const toolCalls = {};
  let usage = null;
  let done = false;

  function ensureReasoning() {
    if (rsItem) return;
    outputIndex += 1;
    rsItem = { id: genId('rs'), outIdx: outputIndex, text: '' };
    sseWrite(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: rsItem.outIdx,
      item: { type: 'reasoning', id: rsItem.id, summary: [], content: null, status: 'in_progress' } });
  }
  function ensureMessage() {
    if (msgItem) return;
    outputIndex += 1;
    msgItem = { id: genId('msg'), outIdx: outputIndex, text: '' };
    sseWrite(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: msgItem.outIdx,
      item: { type: 'message', id: msgItem.id, role: 'assistant', status: 'in_progress', content: [] } });
    sseWrite(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: msgItem.id,
      output_index: msgItem.outIdx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  }

  function handleLine(dataStr) {
    if (!dataStr || dataStr === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(dataStr); } catch (e) { return; }
    if (evt.usage) usage = evt.usage;
    const choice = (evt.choices && evt.choices[0]) || {};
    const delta = choice.delta || {};
    if (delta.reasoning_content) {
      ensureReasoning();
      rsItem.text += delta.reasoning_content;
      sseWrite(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta',
        item_id: rsItem.id, output_index: rsItem.outIdx, summary_index: 0, delta: delta.reasoning_content });
    }
    if (delta.content) {
      ensureMessage();
      msgItem.text += delta.content;
      sseWrite(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: msgItem.id,
        output_index: msgItem.outIdx, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        if (!toolCalls[i]) toolCalls[i] = { call_id: (tc.id && tc.id !== '') ? tc.id : genId('call'), name: '', args: '' };
        if (tc.id && tc.id !== '') toolCalls[i].call_id = tc.id;
        if (tc.function) {
          if (tc.function.name) toolCalls[i].name += tc.function.name;
          if (tc.function.arguments) toolCalls[i].args += tc.function.arguments;
        }
      }
    }
  }

  function finish() {
    if (done) return;
    done = true;
    startStream();
    if (rsItem) {
      sseWrite(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: rsItem.outIdx,
        item: { type: 'reasoning', id: rsItem.id, summary: [{ type: 'summary_text', text: rsItem.text }], content: null, status: 'completed' } });
    }
    if (msgItem) {
      sseWrite(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: msgItem.id,
        output_index: msgItem.outIdx, content_index: 0, text: msgItem.text });
      sseWrite(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: msgItem.id,
        output_index: msgItem.outIdx, content_index: 0, part: { type: 'output_text', text: msgItem.text, annotations: [] } });
      sseWrite(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: msgItem.outIdx,
        item: { type: 'message', id: msgItem.id, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: msgItem.text, annotations: [] }] } });
    }
    const tcIdxs = Object.keys(toolCalls).sort((a, b) => a - b);
    const tcItems = [];
    for (const i of tcIdxs) {
      const tc = toolCalls[i];
      outputIndex += 1;
      const item = { type: 'function_call', id: genId('fc'), call_id: tc.call_id, name: tc.name, arguments: tc.args || '{}', status: 'completed' };
      tcItems.push(item);
      sseWrite(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex,
        item: Object.assign({}, item, { status: 'in_progress' }) });
      sseWrite(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    const finalOutput = [];
    if (rsItem) finalOutput.push({ type: 'reasoning', id: rsItem.id, summary: [{ type: 'summary_text', text: rsItem.text }], content: null });
    if (msgItem) finalOutput.push({ type: 'message', id: msgItem.id, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: msgItem.text, annotations: [] }] });
    for (const it of tcItems) finalOutput.push(it);
    const finalResp = Object.assign({}, baseResp, {
      status: 'completed', output: finalOutput,
      usage: usage ? buildUsage({ usage }) : { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
    });
    sseWrite(res, 'response.completed', { type: 'response.completed', response: finalResp });
    res.end();
    log(`[STREAM] model=${model} text=${msgItem ? msgItem.text.length : 0}ch reasoning=${rsItem ? rsItem.text.length : 0}ch tools=${tcIdxs.length}`);
  }

  forwardToGateway('/v1/chat/completions', 'POST', req.headers, chatBodyStr, (up) => {
    if (up.statusCode !== 200) {
      let errBody = '';
      up.on('data', (c) => { errBody += c.toString('utf8'); });
      up.on('end', () => {
        if (done) return; done = true;
        if (headersSent) { try { res.end(); } catch (e) {} return; }   // 流已开始, 无法改状态码, 只能断开
        res.writeHead(up.statusCode || 502, { 'content-type': 'application/json' });
        res.end(errBody || JSON.stringify({ error: 'upstream ' + up.statusCode }));
        log(`[STREAM-ERR] upstream ${up.statusCode}: ${errBody.slice(0, 200)}`);
      });
      return;
    }
    startStream();
    let buf = '';
    up.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handleLine(line.slice(5).trim());
      }
    });
    up.on('end', finish);
    up.on('error', (err) => { log('[STREAM-ERR] ' + err.message); finish(); });
  }, (err) => {
    if (done) return; done = true;
    if (headersSent) { try { res.end(); } catch (e) {} return; }
    try { res.writeHead(502, { 'content-type': 'application/json' }); } catch (e) {}
    try { res.end(JSON.stringify({ error: { message: 'gateway connect failed: ' + err.message } })); } catch (e) {}
    log('[STREAM-ERR] ' + err.message);
  });
}

// ─── HTTP 服务 ───
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    log(`[IN] ${method} ${p} body=${bodyBuf.length}B`);

    // 模型列表透传
    if (method === 'GET' && (p === '/v1/models' || p === '/models')) {
      forwardToGateway('/v1/models', 'GET', req.headers, null, (up) => {
        res.writeHead(up.statusCode || 502, { 'content-type': up.headers['content-type'] || 'application/json' });
        up.pipe(res);
      }, (err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'gateway connect failed: ' + err.message } }));
        log('[ERR] models: ' + err.message);
      });
      return;
    }

    // Codex 中断请求
    if (method === 'DELETE' && /^\/(v1\/)?responses\/.+/.test(p)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: p.split('/').pop(), object: 'response', status: 'completed', deleted: true }));
      return;
    }

    // Responses 主入口
    if (method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      let rBody;
      try { rBody = JSON.parse(bodyBuf.toString('utf8')); } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
        return;
      }
      if (!rBody || typeof rBody.model !== 'string' || !rBody.model) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing model' } }));
        return;
      }
      const chatReq = buildChatRequest(rBody);
      const chatBody = Buffer.from(JSON.stringify(chatReq), 'utf8');
      log(`[TRANSLATE] model=${rBody.model} msgs=${chatReq.messages.length} tools=${(chatReq.tools || []).length} stream=${!!chatReq.stream}`);

      if (chatReq.stream) {
        streamResponses(req, res, chatBody, rBody.model);
      } else {
        forwardToGateway('/v1/chat/completions', 'POST', req.headers, chatBody, (up) => {
          let body = '';
          up.on('data', (c) => { body += c.toString('utf8'); });
          up.on('end', () => {
            if (up.statusCode !== 200) {
              res.writeHead(up.statusCode || 502, { 'content-type': 'application/json' });
              res.end(body);
              log(`[ERR] upstream ${up.statusCode}: ${body.slice(0, 200)}`);
              return;
            }
            let chat;
            try { chat = JSON.parse(body); } catch (e) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'bad upstream JSON' } }));
              return;
            }
            const resp = chatToResponses(chat);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(resp));
            const txt = resp.output.filter((o) => o.type === 'message').map((o) => o.content[0].text).join('');
            log(`[OK] model=${rBody.model} text=${txt.length}ch usage=${JSON.stringify(resp.usage)}`);
          });
        }, (err) => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'gateway connect failed: ' + err.message } }));
          log('[ERR] ' + err.message);
        });
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown path ' + p }));
  });
});

// 进程级保护: 任何未捕获异常只记日志, 不让适配器整进程退出(Codex 会话依赖它常驻)
process.on('uncaughtException', (err) => { log('[UNCAUGHT] ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)); });
process.on('unhandledRejection', (err) => { log('[REJECTION] ' + (err && err.message ? err.message : err)); });

server.listen(PORT, '127.0.0.1', () => {
  log(`responses-adapter started on http://127.0.0.1:${PORT} → gateway ${GATEWAY}`);
});
