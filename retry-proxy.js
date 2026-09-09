#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Paths ───
const KEYS_FILE = path.join(__dirname, 'keys.json');

// ─── State ───
let config = loadConfig();
let keyIndex = {};        // provider -> next index (round-robin, legacy)
let weightState = {};     // provider -> { current, currentWeight } for weighted RR
let stats = {};          // provider -> { key -> { success, fail, lastStatus, lastTime, avgLatency } }
let recentLogs = [];     // ring buffer of recent log lines
const MAX_LOGS = 200;

// ─── Logging ───
const LOG_FILE = path.join(__dirname, 'proxy.log');
function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  // Persist to disk so a crash leaves evidence (sync: tiny volume, always survives)
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) { /* never break on logging */ }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch (e) {
    log('FATAL: keys.json load failed: ' + e.message);
    process.exit(1);
  }
}

function saveConfig() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function reloadConfig() {
  config = loadConfig();
  // Reset index if out of bounds
  for (const pid in config.providers) {
    if (keyIndex[pid] === undefined) keyIndex[pid] = 0;
    const n = (config.providers[pid].keys || []).length;
    if (n > 0 && keyIndex[pid] >= n) keyIndex[pid] = 0;
    if (!stats[pid]) stats[pid] = {};
    // Init stats for new keys
    for (const k of (config.providers[pid].keys || [])) {
      const kv = keyValue(k);
      if (!stats[pid][kv]) stats[pid][kv] = { success: 0, fail: 0, lastStatus: '-', lastTime: '-', avgLatency: 0 };
    }
  }
}

function getStats() {
  const result = {};
  for (const pid in config.providers) {
    result[pid] = {
      name: config.providers[pid].name,
      targetUrl: config.providers[pid].targetUrl,
      prefix: config.providers[pid].prefix || null,
      mode: providerMode(pid),
      raceMode: config.providers[pid].raceMode,   // legacy: undefined = inherit global
      modelOverrides: config.providers[pid].modelOverrides || {},
      disabledModels: config.providers[pid].disabledModels || {},
      keys: []
    };
    for (const k of (config.providers[pid].keys || [])) {
      const kv = keyValue(k);
      const w = keyWeight(k);
      const s = stats[pid] && stats[pid][kv] ? stats[pid][kv] : { success: 0, fail: 0, lastStatus: '-', lastTime: '-', avgLatency: 0 };
      // Mask key for display — NEVER expose full key to the web UI
      const masked = keyDisplayStr(kv);
      result[pid].keys.push({ key: masked, weight: w, cooldown: coolingRemainSec(pid, kv), tps: tokensPerSec(pid, kv), ...s });
    }
  }
  return result;
}

// ─── Mode helpers: "normal" | "smart" | "pro" | "promax" ───
// normal  = sequential retry over the key pool (default)
// smart   = sequential retry + 429-aware cooldown (429 key frozen N s, others take over)
// pro     = race: every key fires once concurrently, first 200 wins
// promax  = pro with N staggered rounds (keys x rounds legs)
function normalizeMode() {
  const m = config.mode;
  if (m === 'pro' || m === 'promax' || m === 'normal' || m === 'smart') return m;
  // Legacy derive: raceMode=true + raceRounds>1 => promax, else pro
  if (config.raceMode === true) return (parseInt(config.raceRounds) || 1) > 1 ? 'promax' : 'pro';
  return 'normal';
}
function providerMode(pid) {
  const p = config.providers[pid] || {};
  if (p.mode === 'pro' || p.mode === 'promax' || p.mode === 'normal' || p.mode === 'smart') return p.mode;
  // Legacy per-provider override: true => at least pro, false => force normal
  if (p.raceMode === true) return normalizeMode() === 'promax' ? 'promax' : 'pro';
  if (p.raceMode === false) return 'normal';
  return normalizeMode();
}

// ─── Reasoning efforts (full ladder) & models cache ───
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const modelsCache = {};   // pid -> { ts, ids }
const MODELS_TTL = 10 * 60 * 1000;

// ─── 429 cooldown state: provider -> { key -> untilEpochMs } ───
const keyCooldown = {};
function cooldownMs() { return (parseInt(config.cooldown429) || 30) * 1000; }
function mark429Cooldown(pid, key) {
  if (!keyCooldown[pid]) keyCooldown[pid] = {};
  keyCooldown[pid][key] = Date.now() + cooldownMs();
}
function isCooling(pid, key) {
  if (!keyCooldown[pid] || !keyCooldown[pid][key]) return false;
  if (Date.now() >= keyCooldown[pid][key]) { delete keyCooldown[pid][key]; return false; }
  return true;
}
function coolingRemainSec(pid, key) {
  if (!keyCooldown[pid] || !keyCooldown[pid][key]) return 0;
  return Math.max(0, Math.ceil((keyCooldown[pid][key] - Date.now()) / 1000));
}
function anyKeyAvailable(pid) {
  const keys = config.providers[pid].keys || [];
  for (const k of keys) { const kv = keyValue(k); if (!isCooling(pid, kv)) return kv; }
  return null;
}
function minCooldownRemainMs(pid) {
  let min = 0;
  const ks = keyCooldown[pid] || {};
  for (const k in ks) {
    const rem = ks[k] - Date.now();
    if (rem > 0 && (min === 0 || rem < min)) min = rem;
  }
  return min;
}
function clearCooldown(pid) { if (keyCooldown[pid]) delete keyCooldown[pid]; }

// ─── Per-model disable switch: hidden from lists, refused at request time ───
function isModelDisabled(pid, model) {
  const dm = config.providers[pid] && config.providers[pid].disabledModels;
  return !!(dm && dm[model]);
}
function enabledModels(pid) {
  const ids = modelsCache[pid] ? modelsCache[pid].ids : null;
  if (!ids) return null;
  return ids.filter(m => !isModelDisabled(pid, m));
}

// ─── Upstream models fetch (via the normal forward path, first available key) ───
async function fetchUpstreamModels(pid) {
  const prov = config.providers[pid];
  if (!prov) throw new Error('unknown provider');
  const apiKey = anyKeyAvailable(pid) || ((prov.keys && prov.keys[0]) ? keyValue(prov.keys[0]) : null);
  if (!apiKey) throw new Error('no key available');
  const r = await forwardRequest(prov.targetUrl, '/v1/models', {}, 'GET', null, apiKey, 15000);
  const txt = (await drainResponse(r)).toString('utf8');
  if (r.statusCode !== 200) throw new Error('upstream ' + r.statusCode + ': ' + String(txt).slice(0, 120));
  const d = JSON.parse(txt);
  return (d.data || []).map(m => m.id).filter(Boolean);
}

// ─── Reasoning-effort probing ───
// Probe one model across all efforts. onEach(eff, result) fires after each level.
async function probeModelEfforts(pid, model, onEach) {
  const prov = config.providers[pid];
  if (!prov) throw new Error('unknown provider');
  const apiKey = anyKeyAvailable(pid) || ((prov.keys && prov.keys[0]) ? keyValue(prov.keys[0]) : null);
  if (!apiKey) throw new Error('no key available');
  const results = {};
  for (const eff of EFFORTS) {
    const reqBody = Buffer.from(JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi, reply with a single word.' }],
      max_tokens: 128, stream: false, reasoning_effort: eff
    }), 'utf8');
    const t0 = Date.now();
    try {
      const r2 = await forwardRequest(prov.targetUrl, '/v1/chat/completions', { 'content-type': 'application/json' }, 'POST', reqBody, apiKey, 60000);
      const txt = (await drainResponse(r2)).toString('utf8');
      const ms = Date.now() - t0;
      if (r2.statusCode === 200) {
        let hasReasoning = false, snippet = '';
        try {
          const jd = JSON.parse(txt);
          const msg = (jd.choices && jd.choices[0] && jd.choices[0].message) || {};
          const rc = msg.reasoning_content || msg.reasoning || '';
          hasReasoning = (typeof rc === 'string') ? rc.trim().length > 0 : !!rc;
          snippet = ((msg.content || '') + (typeof rc === 'string' && rc ? ' 〈think: ' + rc.slice(0, 50) + '〉' : '')).slice(0, 140);
        } catch (e) { snippet = txt.slice(0, 140); }
        results[eff] = { http: r2.statusCode, ms, hasReasoning, related: false, snippet };
      } else {
        // Non-200: only treat as "effort unsupported" when the error body itself
        // mentions reasoning/thinking. Other errors (quota, params, rate limit)
        // are NOT evidence against the effort level.
        const lower = txt.toLowerCase();
        const kw = ['reasoning', 'effort', 'thinking', '思考', 'not support', 'unsupported', '不支持'];
        const related = kw.some(k => lower.includes(k));
        results[eff] = { http: r2.statusCode, ms, hasReasoning: false, related, snippet: txt.slice(0, 220) };
      }
    } catch (err) {
      results[eff] = { http: 0, ms: Date.now() - t0, hasReasoning: false, related: false, snippet: String(err.message).slice(0, 220) };
    }
    if (onEach) onEach(eff, results[eff]);
  }
  return results;
}

// From the highest effort downward, return the first one the upstream accepts (HTTP 200).
async function probeBestEffort(pid, model) {
  const prov = config.providers[pid];
  const apiKey = anyKeyAvailable(pid) || ((prov.keys && prov.keys[0]) ? keyValue(prov.keys[0]) : null);
  if (!apiKey) return 'none';
  for (const eff of [...EFFORTS].reverse()) {   // ultra -> none
    try {
      const reqBody = Buffer.from(JSON.stringify({
        model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 32, stream: false, reasoning_effort: eff
      }), 'utf8');
      const r2 = await forwardRequest(prov.targetUrl, '/v1/chat/completions', { 'content-type': 'application/json' }, 'POST', reqBody, apiKey, 30000);
      await drainResponse(r2);
      if (r2.statusCode === 200) return eff;
    } catch (e) { /* try next lower */ }
    await sleep(300);   // light throttle between probes
  }
  return 'none';
}

// ─── Provider-wide probe jobs ("one-click test") ───
const probeJobs = {};   // pid -> { running, total, done, current, results: {model: {...}}, error }

function startProbeAll(pid) {
  const prev = probeJobs[pid];
  if (prev && prev.running) return false;
  const job = probeJobs[pid] = { running: true, total: 0, done: 0, current: '', results: prev ? prev.results : {}, error: null, startedAt: Date.now() };
  (async () => {
    try {
      let ids = modelsCache[pid] ? modelsCache[pid].ids : null;
      if (!ids) { ids = await fetchUpstreamModels(pid); modelsCache[pid] = { ts: Date.now(), ids }; }
      ids = ids.filter(m => !isModelDisabled(pid, m));   // skip disabled models
      job.total = ids.length * EFFORTS.length;
      const CONC = 3;   // model-level concurrency
      let idx = 0;
      const worker = async () => {
        while (job.running) {
          const i = idx++;
          if (i >= ids.length) break;
          const model = ids[i];
          job.current = model;
          job.results[model] = await probeModelEfforts(pid, model, () => { job.done++; });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      job.running = false;
      log(`[MGR] probe-all finished for ${pid}: ${ids.length} model(s)`);
    } catch (e) {
      job.running = false;
      job.error = e.message;
      log(`[MGR] probe-all failed for ${pid}: ${e.message}`);
    }
  })();
  return true;
}

// ─── Auto-refresh upstream model lists; new models default to their highest supported effort ───
async function autoRefreshModels() {
  if (config.autoRefreshModels === false) return;
  for (const pid in config.providers) {
    try {
      const ids = await fetchUpstreamModels(pid);
      const old = modelsCache[pid] ? modelsCache[pid].ids : null;
      modelsCache[pid] = { ts: Date.now(), ids };
      const prov = config.providers[pid];
      if (!prov.modelOverrides) prov.modelOverrides = {};
      let added = 0;
      for (const m of ids) {
        if (!(m in prov.modelOverrides)) {
          // New model: probe and default to its highest supported effort (plan B).
          // Disabled models stay hidden and keep no default effort.
          if (isModelDisabled(pid, m)) continue;
          const best = await probeBestEffort(pid, m);
          prov.modelOverrides[m] = best;
          added++;
          log(`[MODELS] ${pid} new model "${m}" -> default effort ${best}`);
        }
      }
      if (added) saveConfig();
      if (old && old.length !== ids.length) log(`[MODELS] ${pid} model count ${old.length} -> ${ids.length}`);
    } catch (e) {
      log(`[MODELS] ${pid} auto-refresh failed: ${e.message}`);
    }
  }
}
setTimeout(() => { autoRefreshModels().catch(() => {}); }, 20000);                  // first run 20s after start
setInterval(() => { autoRefreshModels().catch(() => {}); }, 10 * 60 * 1000);        // then every 10 min

// ─── Route resolution (dynamic: any provider with a "prefix" is routable) ───
function resolveProvider(reqPath) {
  // /<prefix>/* -> provider (prefix stored per-provider in keys.json, e.g. /tr /sn /tm)
  for (const pid in config.providers) {
    const pf = config.providers[pid].prefix;
    if (pf && typeof pf === 'string' && reqPath.startsWith(pf + '/')) {
      return { provider: pid, subPath: '/' + reqPath.slice(pf.length + 1) };
    }
  }
  return null;
}

// ─── Key helpers (support string key = weight 1, or {key, weight}) ───
function keyValue(k) {
  return (typeof k === 'object' && k !== null && k.key) ? k.key : k;
}
function keyWeight(k) {
  return (typeof k === 'object' && k !== null && typeof k.weight === 'number' && k.weight > 0) ? k.weight : 1;
}
function keyDisplayStr(k) {
  const v = keyValue(k);
  return v.length > 12 ? v.slice(0, 6) + '...' + v.slice(-4) : v.slice(0, 4) + '...';
}

// ─── Key selection (weighted round-robin, no cooldown) ───
// Weighted: a key with weight W is picked W times before rotating (smooth weighted round-robin)
function nextKey(providerId) {
  const keys = config.providers[providerId].keys || [];
  if (keys.length === 0) return null;
  if (!weightState[providerId]) weightState[providerId] = { current: null, currentWeight: 0 };
  const ws = weightState[providerId];
  // Smooth weighted round-robin
  while (true) {
    ws.current = (ws.current + 1) % keys.length;
    if (ws.current === 0) {
      ws.currentWeight = ws.currentWeight - gcdOfWeights(keys);
      if (ws.currentWeight <= 0) {
        ws.currentWeight = maxOfWeights(keys);
        if (ws.currentWeight === 0) ws.currentWeight = 1;
      }
    }
    if (keyWeight(keys[ws.current]) >= ws.currentWeight) {
      return keyValue(keys[ws.current]);
    }
  }
}
function gcdOfWeights(keys) {
  let g = 0;
  for (const k of keys) { g = gcd(g, keyWeight(k)); }
  return g || 1;
}
function maxOfWeights(keys) {
  let m = 1;
  for (const k of keys) { m = Math.max(m, keyWeight(k)); }
  return m;
}
function gcd(a, b) {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

// ─── Per-key token throughput (last-60s window from real usage fields) ───
const tokenRate = {};   // pid -> { key -> [{t, tokens}] }

function extractUsage(buf) {
  // 1) plain JSON response
  try {
    const j = JSON.parse(buf);
    if (j.usage && j.usage.total_tokens) return j.usage.total_tokens;
  } catch (e) { /* not plain JSON */ }
  // 2) SSE: scan lines backwards for a chunk carrying usage
  const lines = buf.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (j.usage && j.usage.total_tokens) return j.usage.total_tokens;
    } catch (e) { /* not json line */ }
  }
  return 0;
}

function recordTokens(pid, key, buf) {
  try {
    const tokens = extractUsage(buf.toString('utf8'));
    if (!tokens || tokens <= 0) return;
    if (!tokenRate[pid]) tokenRate[pid] = {};
    if (!tokenRate[pid][key]) tokenRate[pid][key] = [];
    const arr = tokenRate[pid][key];
    arr.push({ t: Date.now(), tokens });
    while (arr.length && arr[0].t < Date.now() - 300000) arr.shift();  // keep 5 min
  } catch (e) { /* stats only, never break the stream */ }
}

function tokensPerSec(pid, key) {
  const arr = (tokenRate[pid] || {})[key] || [];
  const cutoff = Date.now() - 60000;
  let sum = 0;
  for (const e of arr) if (e.t >= cutoff) sum += e.tokens;
  return Math.round(sum / 60);   // 60s window → tokens per second
}

// ─── Sleep helper ───
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Forward request with timeout (returns response stream) ───
function forwardRequest(targetUrl, subPath, headers, method, body, apiKey, timeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const basePath = (parsed.pathname || '/').replace(/\/+$/, '');
    const normSub = (subPath || '').replace(/^\/+/, '');
    const finalPath = basePath + '/' + normSub;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: finalPath,
      method: method || 'POST',
      headers: { ...headers }
    };
    options.headers['authorization'] = 'Bearer ' + apiKey;
    options.headers['host'] = parsed.hostname;
    delete options.headers['content-length'];
    delete options.headers['connection'];
    delete options.headers['transfer-encoding'];
    if (body && body.length > 0) {
      options.headers['content-length'] = Buffer.byteLength(body);
    }

    const reqLib = parsed.protocol === 'https:' ? https : http;
    const req = reqLib.request(options, (res) => {
      resolve(res);
    });

    // Expose the request object so callers can abort it (used by race mode)
    if (onRequest) onRequest(req);

    req.on('error', reject);

    // Timeout: destroy request and reject with timeout error
    const effectiveTimeout = timeoutMs || 30000;
    req.setTimeout(effectiveTimeout, () => {
      req.destroy(new Error('TIMEOUT'));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ─── Drain a response stream (consume error body for retry) ───
function drainResponse(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ─── Check if error is retryable ───
function isRetryable(statusCode) {
  return [400, 429, 500, 502, 503, 504].includes(statusCode);
}

// ─── Race mode: fire ALL keys concurrently, first 200 wins, losers aborted ───
// Each leg retries independently on failure; as soon as one leg succeeds its
// response is streamed to the client and every other in-flight leg is destroyed.
async function handleProxyRace(req, res, provider, providerName, targetUrl, keys, subPath, query, body, cfg) {
  const keyList = keys.map(keyValue);
  // Pro Max: fire multiple staggered rounds of the full key pool.
  // legs = keys x raceRounds; round r starts after r*roundDelay ms.
  // First 200 anywhere wins; every other leg (past or future round) is killed.
  const raceRounds = Math.max(1, parseInt(cfg.raceRounds) || 1);
  const roundDelay = Math.max(0, parseInt(cfg.roundDelay) || 0);
  const hardDeadline = Date.now() + cfg.overallTimeout;
  // Race legs retry concurrently, so they need tighter guardrails than the
  // sequential path: a floor on the retry interval (stops 4 legs hammering
  // upstream at ~39 req/s when retryDelay=0) and a per-leg circuit breaker
  // (stops N simultaneous retry storms instead of one).
  const legRetryDelay = Math.max(cfg.retryDelay || 0, cfg.raceMinRetryDelay || 0);
  const legCircuit = cfg.raceCircuitBreaker || cfg.circuitBreaker;
  let settled = false;
  let lastStatus = 0;
  let lastBody = null;
  const controllers = [];

  // Destroy every in-flight request except the winner's
  const abortLosers = (exceptionCtrl) => {
    for (const c of controllers) {
      if (c === exceptionCtrl) continue;
      if (c.req && !c.req.destroyed) {
        try { c.req.destroy(); } catch (e) { /* already gone */ }
      }
    }
  };

  // Client disconnect BEFORE any leg gets a response head: stop every leg now.
  // The post-200 path checks res.destroyed, but during the connect/wait window
  // nothing cancelled in-flight legs — this closes that gap so the upstream
  // stops generating instead of running to completion (and billing full tokens).
  res.on('close', () => {
    if (settled) return;
    settled = true;
    log(`[RACE DROP] ${providerName} client disconnected, aborting all legs`);
    abortLosers(null);
  });

  const bumpStats = (apiKey, ok, statusLabel, elapsed) => {
    if (!stats[provider]) stats[provider] = {};
    if (!stats[provider][apiKey]) stats[provider][apiKey] = { success: 0, fail: 0, lastStatus: '-', lastTime: '-', avgLatency: 0 };
    const s = stats[provider][apiKey];
    s.lastStatus = statusLabel;
    s.lastTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (ok) {
      s.success++;
      s.avgLatency = Math.round((s.avgLatency * 0.7) + ((elapsed || 0) * 0.3));
    } else {
      s.fail++;
    }
  };

  const runLeg = async (apiKey, legIndex, round) => {
    const keyDisplay = keyDisplayStr(apiKey);

    // Staggered start: round r fires r*roundDelay later. If a winner emerged
    // while we waited (or while an earlier leg was in flight), don't fire.
    if (round > 0 && roundDelay > 0) {
      await sleep(round * roundDelay);
      if (settled || Date.now() > hardDeadline) return;
    }

    for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
      if (settled) return;                    // another leg already won
      if (Date.now() > hardDeadline) return;  // global deadline reached

      const startTime = Date.now();
      const ctrl = { req: null };
      controllers.push(ctrl);                 // register BEFORE await so it can be aborted
      let upstreamRes;

      try {
        upstreamRes = await forwardRequest(
          targetUrl, subPath + query, req.headers, req.method, body, apiKey, cfg.requestTimeout,
          (r) => { ctrl.req = r; }
        );
      } catch (err) {
        if (settled) {
          log(`[RACE ABORT] ${providerName} leg=${legIndex} cancelled (another leg already won)`);
          return;
        }
        const elapsed = Date.now() - startTime;
        const label = err.message === 'TIMEOUT' ? 'TIMEOUT' : 'ERR';
        bumpStats(apiKey, false, label);
        log(`[RACE ${legIndex}] [${label}] ${providerName} key=${keyDisplay} ${err.message} attempt=${attempt + 1}/${cfg.maxRetries} ${elapsed}ms`);
        if (attempt + 1 >= legCircuit) {
          log(`[RACE CIRCUIT] ${providerName} leg=${legIndex} ${legCircuit} consecutive failures, this leg gives up`);
          return;
        }
        if (legRetryDelay > 0) await sleep(legRetryDelay);
        continue;
      }

      // Lost the race while in flight: drain quietly, never touch the client
      if (settled) {
        log(`[RACE LOST] ${providerName} leg=${legIndex} finished but another leg won first`);
        drainResponse(upstreamRes);
        return;
      }

      const status = upstreamRes.statusCode;
      const elapsed = Date.now() - startTime;

      if (status === 200) {
        if (settled) { drainResponse(upstreamRes); return; }
        if (res.destroyed) {
          settled = true;                     // stop every other leg: nobody is listening
          if (!upstreamRes.destroyed) upstreamRes.destroy();
          log(`[RACE DROP] ${providerName} leg=${legIndex} client gone, response discarded`);
          abortLosers(ctrl);
          return;
        }
        settled = true;                       // claim the win BEFORE aborting others
        bumpStats(apiKey, true, status, elapsed);
        log(`[RACE WIN] ${providerName} key=${keyDisplay} leg=${legIndex} attempt=${attempt + 1} ${elapsed}ms`);
        const respHeaders = { ...upstreamRes.headers };
        delete respHeaders['transfer-encoding'];
        res.writeHead(200, respHeaders);
        // Tee a bounded copy (keep the tail — usage sits at the end) to track
        // per-key token throughput without disturbing the streamed response.
        const tee = [];
        let teeBytes = 0;
        upstreamRes.on('data', (c) => {
          tee.push(c); teeBytes += c.length;
          while (teeBytes > 1048576 && tee.length > 1) { teeBytes -= tee[0].length; tee.shift(); }
        });
        upstreamRes.on('end', () => { try { recordTokens(provider, apiKey, Buffer.concat(tee)); } catch (e) { /* stats only */ } });
        upstreamRes.pipe(res);
        // Propagate client disconnects upstream so the model stops generating.
        // Without this it runs to completion and bills the full output tokens.
        res.on('close', () => { if (!upstreamRes.destroyed) upstreamRes.destroy(); });
        abortLosers(ctrl);                    // cancel every other in-flight leg
        return;
      }

      bumpStats(apiKey, false, status);
      lastStatus = status;
      lastBody = await drainResponse(upstreamRes);

      if (isRetryable(status)) {
        log(`[RACE ${legIndex}] [${status}] ${providerName} key=${keyDisplay} RETRY attempt=${attempt + 1}/${cfg.maxRetries} ${elapsed}ms`);
        if (settled) return;
        if (attempt + 1 >= legCircuit) {
          log(`[RACE CIRCUIT] ${providerName} leg=${legIndex} ${legCircuit} consecutive ${status}s, this leg gives up`);
          return;
        }
        if (legRetryDelay > 0) await sleep(legRetryDelay);
        continue;
      }

      log(`[RACE ${legIndex}] [${status}] ${providerName} key=${keyDisplay} NON-RETRYABLE ${elapsed}ms`);
      return;
    }
  };

  // Hard safety net: never hang beyond overallTimeout even if every leg stalls
  const safetyTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    log(`[RACE TIMEOUT] ${providerName} no winner within ${cfg.overallTimeout}ms, aborting all legs`);
    abortLosers(null);
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Race mode deadline exceeded', provider: providerName, overallTimeout: cfg.overallTimeout }));
    }
  }, cfg.overallTimeout);

  // Build the full leg list: every key in every round (rounds x keys legs).
  // Round r is staggered by r*roundDelay inside runLeg.
  const legs = [];
  for (let r = 0; r < raceRounds; r++) {
    for (let i = 0; i < keyList.length; i++) {
      legs.push({ key: keyList[i], round: r, idx: legs.length + 1 });
    }
  }

  try {
    // Per-leg catch: one crashing leg must never reject Promise.all and hang the request
    await Promise.all(legs.map((l) => runLeg(l.key, l.idx, l.round).catch((e) => {
      log(`[RACE ERR] ${providerName} leg=${l.idx} crashed: ${e.message}`);
    })));
  } finally {
    clearTimeout(safetyTimer);
  }

  if (!settled && !res.headersSent) {
    log(`[RACE FAILED] ${providerName} all ${legs.length} leg(s) exhausted (last=${lastStatus})`);
    if (lastBody) {
      res.writeHead(lastStatus || 503, { 'content-type': 'application/json' });
      res.end(lastBody);
    } else {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'All race legs failed', provider: providerName, legs: legs.length }));
    }
  }
}

// ─── Aggregate unified entry: /v1/* with "Provider/model" naming ───
// Any OpenAI-compatible client points at http://host:9119/v1 and addresses
// models as "sensenova/glm-5.2" (provider id or name, case-insensitive).
function resolveAggregate(modelName) {
  if (!modelName || typeof modelName !== 'string') return null;
  const idx = modelName.indexOf('/');
  if (idx <= 0) return null;
  const pref = modelName.slice(0, idx).trim().toLowerCase();
  const rest = modelName.slice(idx + 1).trim();
  if (!pref || !rest) return null;
  for (const pid in config.providers) {
    const p = config.providers[pid];
    const nameBare = String(p.name || '').replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
    if (pid.toLowerCase() === pref || String(p.name || '').toLowerCase() === pref || nameBare === pref) {
      return { provider: pid, model: rest };
    }
  }
  return null;
}

async function handleAggregateModels(res) {
  const data = [];
  for (const pid in config.providers) {
    let ids = modelsCache[pid] ? modelsCache[pid].ids : null;
    if (!ids) {
      try {
        ids = await fetchUpstreamModels(pid);
        modelsCache[pid] = { ts: Date.now(), ids };
      } catch (e) { ids = []; }
    }
    for (const id of ids) {
      if (isModelDisabled(pid, id)) continue;   // disabled models are invisible
      data.push({ id: pid + '/' + id, object: 'model', owned_by: pid });
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data }));
}

// ─── Proxy handler ───
async function handleProxy(req, res) {
  const parsed = url.parse(req.url);
  const reqPath = parsed.pathname;

  // Read request body early (aggregate routing needs body.model)
  const bodyChunks = [];
  req.on('data', (c) => bodyChunks.push(c));
  await new Promise((r) => req.on('end', r));
  let body = Buffer.concat(bodyChunks);

  let provider, subPath;
  const direct = resolveProvider(reqPath);
  if (direct) {
    provider = direct.provider;
    subPath = direct.subPath;
  } else if ((reqPath === '/v1/models' || reqPath === '/models') && req.method === 'GET') {
    // Unified aggregate model list (base URL may or may not include /v1)
    return await handleAggregateModels(res);
  } else if (reqPath === '/' || reqPath === '/v1' || reqPath === '/favicon.ico') {
    // Bare hits to the base URL: guide the client instead of a raw 404
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hint: 'Key-pool aggregate gateway. Set baseURL to this address and use model "provider/model", e.g. "sensenova/glm-5.2". Providers: ' + Object.keys(config.providers).join(', ') }));
    return;
  } else {
    // Unified aggregate entry: model = "Provider/model"; base URL with or without /v1
    let modelName = null;
    try {
      const j = JSON.parse(body.toString('utf8'));
      if (j && typeof j === 'object' && typeof j.model === 'string') modelName = j.model;
    } catch (e) { /* not JSON */ }
    const agg = resolveAggregate(modelName);
    if (!agg) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Aggregate entry: body.model must be "provider/model", e.g. "sensenova/glm-5.2". Providers: ' + Object.keys(config.providers).join(', ') }));
      return;
    }
    provider = agg.provider;
    // Client baseURL may omit /v1 (e.g. http://host:9119 + /chat/completions):
    // always forward the upstream-shaped path /v1/...
    subPath = reqPath.startsWith('/v1/') ? reqPath : '/v1' + reqPath;
    const j = JSON.parse(body.toString('utf8'));
    j.model = agg.model;                     // strip the provider prefix
    body = Buffer.from(JSON.stringify(j), 'utf8');
    log(`[AGG] ${provider} <- ${modelName} (model=${agg.model})`);
  }

  const providerName = config.providers[provider].name;
  const targetUrl = config.providers[provider].targetUrl;
  const keys = config.providers[provider].keys || [];

  if (keys.length === 0) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API keys configured for ' + provider }));
    return;
  }

  // Access-key gate: when set on the page, clients must present this exact
  // Bearer token to reach any upstream (upstream keys stay server-side).
  if (config.accessKey) {
    const auth = String(req.headers['authorization'] || '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== config.accessKey) {
      log(`[AUTH] ${providerName} rejected client (bad/missing access key)`);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing access key. Set it in the management page.' }));
      return;
    }
  }

  // Disabled-model gate: hidden from every list, and requests are refused as
  // if the model did not exist (404).
  {
    const dm = config.providers[provider].disabledModels || {};
    let reqModel = null;
    try {
      const j = JSON.parse(body.toString('utf8'));
      if (j && typeof j === 'object' && typeof j.model === 'string') reqModel = j.model;
    } catch (e) { /* non-JSON body */ }
    if (reqModel && dm[reqModel]) {
      log(`[BLOCKED] ${providerName} model=${reqModel} is disabled`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Model not found: ' + reqModel }));
      return;
    }
  }

  // Reasoning-effort override engine: if this (provider, model) has a forced
  // effort configured, rewrite the request body regardless of what the client sent.
  // Applies uniformly to all modes (sequential + race) since it happens before dispatch.
  {
    const overrides = config.providers[provider].modelOverrides;
    if (overrides && Object.keys(overrides).length > 0 && body.length > 0) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.model === 'string' && overrides[j.model]) {
          const effort = overrides[j.model];
          const before = j.reasoning_effort;
          j.reasoning_effort = effort;
          body = Buffer.from(JSON.stringify(j), 'utf8');
          log(`[OVERRIDE] ${providerName} model=${j.model} reasoning_effort: ${before === undefined ? '(client none)' : before} -> ${effort}`);
        }
      } catch (e) { /* non-JSON body: pass through untouched */ }
    }
  }

  const maxRetries = config.maxRetries || 10;
  const retryDelay = config.retryDelay || 0;       // ms between retries
  const requestTimeout = config.requestTimeout || 30000;  // ms per request
  const overallTimeout = config.overallTimeout || 120000;  // ms total across all retries (safety net)
  const circuitBreaker = config.circuitBreaker || 8;  // max consecutive failures before giving up immediately
  const query = parsed.search || '';

  // Mode dispatch: normal (sequential) vs pro/promax (race family)
  const mode = providerMode(provider);
  if (mode === 'pro' || mode === 'promax') {
    const rounds = (mode === 'promax') ? (parseInt(config.raceRounds) || 3) : 1;
    log(`[RACE] ${providerName} ${mode} mode: ${keys.length} key(s) x ${rounds} round(s) firing`);
    return await handleProxyRace(req, res, provider, providerName, targetUrl, keys, subPath, query, body, {
      maxRetries, retryDelay, requestTimeout, overallTimeout, circuitBreaker,
      raceMinRetryDelay: config.raceMinRetryDelay || 500,
      raceCircuitBreaker: config.raceCircuitBreaker || 5,
      raceRounds: rounds,
      roundDelay: config.roundDelay || 0
    });
  }

  const hardDeadline = Date.now() + overallTimeout;

  // Client disconnect: cancel the in-flight upstream request immediately and
  // stop retrying, so the model stops generating (and stops billing tokens).
  // Without this the loop keeps retrying to a dead socket until success/deadline.
  let clientGone = false;
  let ctrlReq = null;
  res.on('close', () => {
    clientGone = true;
    if (ctrlReq && !ctrlReq.destroyed) {
      try { ctrlReq.destroy(); } catch (e) { /* already gone */ }
    }
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Safety net: if total time spent exceeds overallTimeout, stop retrying
    if (Date.now() > hardDeadline) {
      log(`[DEADLINE] ${providerName} overall ${overallTimeout}ms exceeded after ${attempt} attempts`);
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Overall retry deadline exceeded', provider: providerName, attempts: attempt, overallTimeout }));
      return;
    }
    if (clientGone) {
      log(`[ABORT] ${providerName} client disconnected, stopping retries after ${attempt} attempt(s)`);
      return;
    }
    const seqSmart = (mode === 'smart');
    let apiKey;
    if (seqSmart) {
      // Smart: skip keys currently frozen by a 429; if ALL keys are cooling,
      // wait out the shortest remaining cooldown instead of hammering upstream.
      apiKey = anyKeyAvailable(provider);
      if (!apiKey) {
        const waitMs = minCooldownRemainMs(provider);
        if (waitMs > 0) {
          if (Date.now() + waitMs > hardDeadline) {
            log(`[SMART] ${providerName} all keys cooling (${Math.ceil(waitMs / 1000)}s), deadline too close, giving up`);
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'All keys in 429 cooldown and overall deadline reached', provider: providerName }));
            return;
          }
          log(`[SMART] ${providerName} all keys in 429 cooldown, waiting ${Math.ceil(waitMs / 1000)}s`);
          await sleep(Math.min(waitMs, 10000));
          if (clientGone) return;
          apiKey = anyKeyAvailable(provider) || nextKey(provider);
        } else {
          apiKey = nextKey(provider);
        }
      }
    } else {
      apiKey = nextKey(provider);
    }
    const keyDisplay = keyDisplayStr(apiKey);
    const startTime = Date.now();

    try {
      const upstreamRes = await forwardRequest(targetUrl, subPath + query, req.headers, req.method, body, apiKey, requestTimeout, (r) => { ctrlReq = r; });
      const status = upstreamRes.statusCode;
      const ct = (upstreamRes.headers['content-type'] || '').toLowerCase();
      const elapsed = Date.now() - startTime;

      // Update stats
      if (!stats[provider]) stats[provider] = {};
      if (!stats[provider][apiKey]) stats[provider][apiKey] = { success: 0, fail: 0, lastStatus: '-', lastTime: '-', avgLatency: 0 };
      stats[provider][apiKey].lastStatus = status;
      stats[provider][apiKey].lastTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });

      // Success: stream through immediately (SSE or normal)
      if (status === 200) {
        if (clientGone) {
          if (!upstreamRes.destroyed) upstreamRes.destroy();
          log(`[ABORT] ${providerName} client disconnected, response discarded`);
          return;
        }
        stats[provider][apiKey].success++;
        // Rolling average latency
        stats[provider][apiKey].avgLatency = Math.round((stats[provider][apiKey].avgLatency * 0.7) + (elapsed * 0.3));
        log(`[200] ${providerName} key=${keyDisplay} path=${subPath} attempt=${attempt + 1}/${maxRetries} ${elapsed}ms${ct.includes('text/event-stream') ? ' [SSE]' : ''}`);
        const respHeaders = { ...upstreamRes.headers };
        delete respHeaders['transfer-encoding'];
        res.writeHead(200, respHeaders);
        // Tee a bounded copy (keep the tail — usage sits at the end) to track
        // per-key token throughput without disturbing the streamed response.
        const tee = [];
        let teeBytes = 0;
        upstreamRes.on('data', (c) => {
          tee.push(c); teeBytes += c.length;
          while (teeBytes > 1048576 && tee.length > 1) { teeBytes -= tee[0].length; tee.shift(); }
        });
        upstreamRes.on('end', () => { try { recordTokens(provider, apiKey, Buffer.concat(tee)); } catch (e) { /* stats only */ } });
        upstreamRes.pipe(res);
        // Propagate client disconnects upstream so the model stops generating.
        // Without this it runs to completion and bills the full output tokens.
        res.on('close', () => { if (!upstreamRes.destroyed) upstreamRes.destroy(); });
        return;
      }

      if (isRetryable(status)) {
        stats[provider][apiKey].fail++;
        // Smart: a 429 means "stop using this key for a while" — freeze it so the
        // next attempts skip it and try the others instead of hammering upstream.
        if (mode === 'smart' && status === 429) {
          mark429Cooldown(provider, apiKey);
          log(`[SMART] ${providerName} key=${keyDisplay} 429 -> frozen ${Math.ceil(cooldownMs() / 1000)}s`);
        }
        log(`[${status}] ${providerName} key=${keyDisplay} RETRY attempt=${attempt + 1}/${maxRetries} ${elapsed}ms`);
        // Circuit breaker: stop immediately after N consecutive failures instead of
        // spinning until overallTimeout (prevents 20-minute retry storms)
        if (attempt + 1 >= circuitBreaker) {
          const cbBody = await drainResponse(upstreamRes);
          log(`[CIRCUIT] ${providerName} ${circuitBreaker} consecutive failures, giving up (last=${status})`);
          res.writeHead(status, upstreamRes.headers);
          res.end(cbBody);
          return;
        }
        await drainResponse(upstreamRes);
        if (retryDelay > 0) await sleep(retryDelay);
        continue;
      }

      // Non-retryable error
      stats[provider][apiKey].fail++;
      log(`[${status}] ${providerName} key=${keyDisplay} NON-RETRYABLE ${elapsed}ms`);
      const errBody = await drainResponse(upstreamRes);
      res.writeHead(status, upstreamRes.headers);
      res.end(errBody);
      return;

    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (!stats[provider]) stats[provider] = {};
      if (!stats[provider][apiKey]) stats[provider][apiKey] = { success: 0, fail: 0, lastStatus: 'ERR', lastTime: '-', avgLatency: 0 };
      stats[provider][apiKey].fail++;
      stats[provider][apiKey].lastStatus = err.message === 'TIMEOUT' ? 'TIMEOUT' : 'ERR';
      stats[provider][apiKey].lastTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      log(`[${err.message === 'TIMEOUT' ? 'TIMEOUT' : 'ERR'}] ${providerName} key=${keyDisplay} ${err.message} attempt=${attempt + 1}/${maxRetries} ${elapsed}ms`);
      // Circuit breaker for timeout / network errors (same rationale as above)
      if (attempt + 1 >= circuitBreaker) {
        log(`[CIRCUIT] ${providerName} ${circuitBreaker} consecutive errors, giving up (last=${err.message})`);
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Circuit breaker: too many consecutive failures', provider: providerName, attempts: attempt + 1, lastError: err.message }));
        return;
      }
      if (retryDelay > 0) await sleep(retryDelay);
      continue;
    }
  }

  // All retries exhausted
  log(`[EXHAUSTED] ${providerName} all ${maxRetries} attempts failed`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'All retries exhausted', provider: providerName, attempts: maxRetries }));
}

// ─── Management API ───
async function handleManage(req, res) {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const method = req.method;

  // CORS + no-cache (prevents stale loading state)
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/status
  if (method === 'GET' && p === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      proxyPort: config.port,
      managePort: config.managePort,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay || 0,
      requestTimeout: config.requestTimeout || 30000,
      overallTimeout: config.overallTimeout || 120000,
      circuitBreaker: config.circuitBreaker || 8,
      mode: normalizeMode(),
      cooldown429: config.cooldown429 || 30,
      accessKey: config.accessKey || '',
      raceMode: config.raceMode === true,
      raceMinRetryDelay: config.raceMinRetryDelay || 500,
      raceCircuitBreaker: config.raceCircuitBreaker || 5,
      raceRounds: config.raceRounds || 1,
      roundDelay: config.roundDelay || 0,
      providers: getStats(),
      recentLogs: recentLogs.slice(-50)
    }));
    return;
  }

  // GET /api/config
  if (method === 'GET' && p === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay || 0,
      requestTimeout: config.requestTimeout || 30000,
      overallTimeout: config.overallTimeout || 120000,
      circuitBreaker: config.circuitBreaker || 8,
      mode: normalizeMode(),
      cooldown429: config.cooldown429 || 30,
      accessKey: config.accessKey || '',
      raceMode: config.raceMode === true,
      raceMinRetryDelay: config.raceMinRetryDelay || 500,
      raceCircuitBreaker: config.raceCircuitBreaker || 5,
      raceRounds: config.raceRounds || 1,
      roundDelay: config.roundDelay || 0,
      port: config.port,
      managePort: config.managePort,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([id, v]) => [id, {
          name: v.name, targetUrl: v.targetUrl, keyCount: (v.keys || []).length,
          mode: providerMode(id),
          raceMode: (v.raceMode !== undefined) ? v.raceMode : null   // legacy
        }])
      )
    }));
    return;
  }

  // POST /api/keys/:provider
  if (method === 'POST' && p.startsWith('/api/keys/')) {
    const provider = p.split('/')[3];
    if (!config.providers[provider]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const body = await readJsonBody(req);
    if (!body.key) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'key is required' }));
      return;
    }
    // Support weight: { key, weight } or plain string key
    const weight = parseInt(body.weight);
    const newKey = (weight > 0) ? { key: body.key, weight } : body.key;
    config.providers[provider].keys.push(newKey);
    saveConfig();
    reloadConfig();
    log(`[MGR] Added key to ${provider} (weight=${keyWeight(newKey)}), total=${config.providers[provider].keys.length}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total: config.providers[provider].keys.length }));
    return;
  }

  // POST /api/keys/:provider/:index/weight  — update key weight
  if (method === 'POST' && p.match(/^\/api\/keys\/[^/]+\/\d+\/weight$/)) {
    const parts = p.split('/');
    const provider = parts[3];
    const index = parseInt(parts[4]);
    if (!config.providers[provider]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    if (isNaN(index) || index < 0 || index >= config.providers[provider].keys.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid index' }));
      return;
    }
    const body = await readJsonBody(req);
    const w = Math.max(1, parseInt(body.weight) || 1);
    const existing = config.providers[provider].keys[index];
    const kv = keyValue(existing);
    config.providers[provider].keys[index] = (w > 0) ? { key: kv, weight: w } : kv;
    saveConfig();
    reloadConfig();
    log(`[MGR] Set weight of key[${index}] in ${provider} to ${w}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, weight: w }));
    return;
  }

  // DELETE /api/keys/:provider/:index
  if (method === 'DELETE' && p.startsWith('/api/keys/')) {
    const parts = p.split('/');
    const provider = parts[3];
    const index = parseInt(parts[4]);
    if (!config.providers[provider]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    if (isNaN(index) || index < 0 || index >= config.providers[provider].keys.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid index' }));
      return;
    }
    config.providers[provider].keys.splice(index, 1);
    saveConfig();
    reloadConfig();
    log(`[MGR] Removed key[${index}] from ${provider}, total=${config.providers[provider].keys.length}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total: config.providers[provider].keys.length }));
    return;
  }

  // POST /api/config
  if (method === 'POST' && p === '/api/config') {
    const body = await readJsonBody(req);
    if (body.maxRetries !== undefined) config.maxRetries = parseInt(body.maxRetries) || 10;
    if (body.retryDelay !== undefined) config.retryDelay = Math.max(0, parseInt(body.retryDelay) || 0);
    if (body.requestTimeout !== undefined) config.requestTimeout = Math.max(1000, parseInt(body.requestTimeout) || 30000);
    if (body.overallTimeout !== undefined) config.overallTimeout = Math.max(5000, parseInt(body.overallTimeout) || 120000);
    if (body.circuitBreaker !== undefined) config.circuitBreaker = Math.max(1, parseInt(body.circuitBreaker) || 8);
    if (body.raceMode !== undefined) config.raceMode = (body.raceMode === true || body.raceMode === 'true');
    if (body.mode !== undefined && (body.mode === 'normal' || body.mode === 'smart' || body.mode === 'pro' || body.mode === 'promax')) {
      config.mode = body.mode;
      config.raceMode = (body.mode === 'pro' || body.mode === 'promax');
    }
    if (body.cooldown429 !== undefined) config.cooldown429 = Math.max(1, parseInt(body.cooldown429) || 30);
    if (body.accessKey !== undefined) {
      config.accessKey = String(body.accessKey).trim();
      log(`[MGR] access key ${config.accessKey ? 'SET (client auth enabled)' : 'cleared (client auth disabled)'}`);
    }
    if (body.raceMinRetryDelay !== undefined) config.raceMinRetryDelay = Math.max(0, parseInt(body.raceMinRetryDelay) || 0);
    if (body.raceCircuitBreaker !== undefined) config.raceCircuitBreaker = Math.max(1, parseInt(body.raceCircuitBreaker) || 5);
    if (body.raceRounds !== undefined) config.raceRounds = Math.max(1, parseInt(body.raceRounds) || 1);
    if (body.roundDelay !== undefined) config.roundDelay = Math.max(0, parseInt(body.roundDelay) || 0);
    if (body.port !== undefined) config.port = parseInt(body.port) || 9119;
    if (body.managePort !== undefined) config.managePort = parseInt(body.managePort) || 9120;
    saveConfig();
    log(`[MGR] Config updated: maxRetries=${config.maxRetries} retryDelay=${config.retryDelay}ms requestTimeout=${config.requestTimeout}ms overallTimeout=${config.overallTimeout}ms circuitBreaker=${config.circuitBreaker} raceMode=${config.raceMode === true} raceMinRetryDelay=${config.raceMinRetryDelay}ms raceCircuitBreaker=${config.raceCircuitBreaker} raceRounds=${config.raceRounds} roundDelay=${config.roundDelay}ms`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: { maxRetries: config.maxRetries, retryDelay: config.retryDelay, requestTimeout: config.requestTimeout, overallTimeout: config.overallTimeout, circuitBreaker: config.circuitBreaker, mode: normalizeMode(), cooldown429: config.cooldown429 || 30, accessKey: config.accessKey || '', raceMode: config.raceMode === true, raceMinRetryDelay: config.raceMinRetryDelay, raceCircuitBreaker: config.raceCircuitBreaker, raceRounds: config.raceRounds, roundDelay: config.roundDelay, port: config.port, managePort: config.managePort } }));
    return;
  }

  // POST /api/provider/:id/racemode — per-provider race mode (null = inherit global)
  if (method === 'POST' && p.match(/^\/api\/provider\/[^/]+\/racemode$/)) {
    const providerId = p.split('/')[3];
    if (!config.providers[providerId]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const body = await readJsonBody(req);
    if (body.enabled === null || body.enabled === undefined || body.enabled === 'inherit') {
      delete config.providers[providerId].raceMode;
    } else {
      config.providers[providerId].raceMode = (body.enabled === true || body.enabled === 'true');
    }
    saveConfig();
    const val = (config.providers[providerId].raceMode === undefined) ? 'inherit' : config.providers[providerId].raceMode;
    log(`[MGR] ${providerId} raceMode -> ${val}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, raceMode: (config.providers[providerId].raceMode === undefined) ? null : config.providers[providerId].raceMode }));
    return;
  }

  // ─── Provider CRUD (platform mode: add/edit/remove providers from the UI) ───
  // Validate provider id & prefix format, ensure uniqueness
  function validateProviderPayload(body, existingId) {
    const errs = [];
    const id = (body.id || '').trim();
    const prefix = (body.prefix || '').trim();
    const name = (body.name || '').trim();
    const targetUrl = (body.targetUrl || '').trim();
    if (!/^[a-z][a-z0-9]{0,19}$/.test(id)) errs.push('id 需以小写字母开头，仅含小写字母/数字，≤20字符');
    if (existingId && id !== existingId) errs.push('不允许修改 id');
    if (!/^\/[a-z0-9]{1,12}$/.test(prefix)) errs.push('前缀需形如 /xx（小写字母/数字，≤12字符）');
    if (prefix === '/api' || prefix.startsWith('/api/')) errs.push('前缀不能占用 /api 管理接口');
    if (!/^https?:\/\/.+/.test(targetUrl)) errs.push('targetUrl 需以 http:// 或 https:// 开头');
    if (!name) errs.push('名称不能为空');
    if (errs.length) return { error: errs.join('；') };
    return { id, prefix, name, targetUrl };
  }
  function prefixTaken(prefix, exceptId) {
    for (const pid in config.providers) {
      if (pid === exceptId) continue;
      if (config.providers[pid].prefix === prefix) return true;
    }
    return false;
  }

  // POST /api/providers — add a new provider
  if (method === 'POST' && p === '/api/providers') {
    const body = await readJsonBody(req);
    const v = validateProviderPayload(body, null);
    if (v.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: v.error }));
      return;
    }
    if (config.providers[v.id]) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'id 已存在：' + v.id }));
      return;
    }
    if (prefixTaken(v.prefix, null)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '前缀已被占用：' + v.prefix }));
      return;
    }
    const keys = Array.isArray(body.keys) ? body.keys : [];
    config.providers[v.id] = { name: v.name, targetUrl: v.targetUrl, prefix: v.prefix, keys };
    saveConfig();
    reloadConfig();
    log(`[MGR] Provider added: ${v.id} (${v.name}) prefix=${v.prefix} keys=${keys.length}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/providers/:id — edit name / targetUrl / prefix
  if (method === 'POST' && p.match(/^\/api\/providers\/[^/]+$/)) {
    const providerId = p.split('/')[3];
    const prov = config.providers[providerId];
    if (!prov) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const body = await readJsonBody(req);
    const v = validateProviderPayload(Object.assign({}, body, { id: providerId }), providerId);
    if (v.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: v.error }));
      return;
    }
    if (v.prefix !== (prov.prefix || null) && prefixTaken(v.prefix, providerId)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '前缀已被占用：' + v.prefix }));
      return;
    }
    prov.name = v.name;
    prov.targetUrl = v.targetUrl;
    prov.prefix = v.prefix;
    saveConfig();
    reloadConfig();
    log(`[MGR] Provider updated: ${providerId} name=${v.name} prefix=${v.prefix}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE /api/providers/:id — remove a provider and its keys
  if (method === 'DELETE' && p.match(/^\/api\/providers\/[^/]+$/)) {
    const providerId = p.split('/')[3];
    if (!config.providers[providerId]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    delete config.providers[providerId];
    delete stats[providerId];
    delete weightState[providerId];
    delete keyIndex[providerId];
    saveConfig();
    reloadConfig();
    log(`[MGR] Provider removed: ${providerId}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/model/:pid/toggle — enable/disable a single model
  // body: { model: "glm-5.2", disabled: true|false }
  if (method === 'POST' && p.match(/^\/api\/model\/[^/]+\/toggle$/)) {
    const pid = p.split('/')[3];
    const prov = config.providers[pid];
    if (!prov) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const bodyIn = await readJsonBody(req);
    const model = (bodyIn.model || '').trim();
    if (!model) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model is required' }));
      return;
    }
    if (!prov.disabledModels) prov.disabledModels = {};
    if (bodyIn.disabled) {
      prov.disabledModels[model] = true;
      log(`[MGR] ${pid} model "${model}" DISABLED (hidden + refused)`);
    } else {
      delete prov.disabledModels[model];
      log(`[MGR] ${pid} model "${model}" re-enabled`);
    }
    if (Object.keys(prov.disabledModels).length === 0) delete prov.disabledModels;
    saveConfig();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, disabledModels: prov.disabledModels || {} }));
    return;
  }

  // GET /api/models/:pid — list upstream models (cached 10 min; ?refresh=1 forces)
  if (method === 'GET' && p.match(/^\/api\/models\/[^/]+$/)) {
    const pid = p.split('/')[3];
    const prov = config.providers[pid];
    if (!prov) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const q = url.parse(req.url, true).query || {};
    const force = q.refresh === '1';
    let ids = null, cached = false, err = null;
    if (!force && modelsCache[pid] && (Date.now() - modelsCache[pid].ts) < MODELS_TTL) {
      ids = modelsCache[pid].ids;
      cached = true;
    } else {
      try {
        ids = await fetchUpstreamModels(pid);
        modelsCache[pid] = { ts: Date.now(), ids };
      } catch (e) {
        err = e.message;
        if (modelsCache[pid]) { ids = modelsCache[pid].ids; cached = true; }  // stale fallback
      }
    }
    const visible = ids ? ids.filter(m => !isModelDisabled(pid, m)) : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pid, ids: visible, cached, error: err }));
    return;
  }

  // POST /api/override/:pid — set/clear forced reasoning effort for a model
  // body: { model: "glm-5.2", effort: "high" | null }  (null/"" clears)
  if (method === 'POST' && p.match(/^\/api\/override\/[^/]+$/)) {
    const pid = p.split('/')[3];
    const prov = config.providers[pid];
    if (!prov) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const bodyIn = await readJsonBody(req);
    const model = (bodyIn.model || '').trim();
    if (!model) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model is required' }));
      return;
    }
    if (!prov.modelOverrides) prov.modelOverrides = {};
    const effort = bodyIn.effort;
    if (effort === null || effort === '' || effort === undefined) {
      delete prov.modelOverrides[model];
      log(`[MGR] ${pid} override cleared for model=${model}`);
    } else {
      if (!EFFORTS.includes(effort)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'effort must be one of: ' + EFFORTS.join(', ') }));
        return;
      }
      prov.modelOverrides[model] = effort;
      log(`[MGR] ${pid} model=${model} reasoning_effort forced to ${effort}`);
    }
    if (Object.keys(prov.modelOverrides).length === 0) delete prov.modelOverrides;
    saveConfig();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, overrides: prov.modelOverrides || {} }));
    return;
  }

  // POST /api/probe/effort/:pid — real-probe which reasoning efforts a model accepts
  // body: { model: "glm-5.2" } → per-effort {http, ms, hasReasoning, snippet}
  if (method === 'POST' && p.match(/^\/api\/probe\/effort\/[^/]+$/)) {
    const pid = p.split('/')[4];
    const prov = config.providers[pid];
    if (!prov) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const bodyIn = await readJsonBody(req);
    const model = (bodyIn.model || '').trim();
    if (!model) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model is required' }));
      return;
    }
    const results = await probeModelEfforts(pid, model);
    log(`[MGR] probed reasoning efforts for ${pid}/${model}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pid, model, results }));
    return;
  }

  // POST /api/probe/all/:pid — one-click test: probe EVERY model of this provider
  if (method === 'POST' && p.match(/^\/api\/probe\/all\/[^/]+$/)) {
    const pid = p.split('/')[4];
    if (!config.providers[pid]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown provider' }));
      return;
    }
    const started = startProbeAll(pid);
    if (!started) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'A probe job is already running for this provider', running: true }));
      return;
    }
    log(`[MGR] probe-all started for ${pid}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, started: true }));
    return;
  }

  // GET /api/probe/status/:pid — progress of the provider-wide probe job
  if (method === 'GET' && p.match(/^\/api\/probe\/status\/[^/]+$/)) {
    const pid = p.split('/')[4];
    const job = probeJobs[pid];
    if (!job) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pid, running: false, total: 0, done: 0, results: {} }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pid, running: job.running, total: job.total, done: job.done, current: job.current, error: job.error, results: job.results }));
    return;
  }

  // POST /api/reload
  if (method === 'POST' && p === '/api/reload') {
    reloadConfig();
    log('[MGR] Reloaded config from file');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/logs
  if (method === 'GET' && p === '/api/logs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ logs: recentLogs }));
    return;
  }

  // Serve web UI
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MANAGE_HTML);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found: ' + p }));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { resolve({}); }
    });
  });
}

// ─── Web UI HTML ───
const MANAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>密钥池网关</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --bg:#f5f6f7; --card:#fff; --line:#e5e6eb;
  --text:#1d2129; --text2:#4e5969; --text3:#86909c;
  --accent:#165dff; --accent-bg:#e8f3ff;
  --ok:#00b42a; --ok-bg:#e8ffea;
  --warn:#ff7d00; --warn-bg:#fff3e8;
  --fail:#f53f3f; --fail-bg:#ffece8;
  --mono:'Cascadia Code','JetBrains Mono',Consolas,monospace;
}
body { background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif; }
main { max-width:1560px; margin:0 auto; padding:20px 16px 60px; }
/* ── top bar ── */
.top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:18px; }
.brand { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:700; }
.brand .logo { width:10px; height:10px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 4px var(--ok-bg); }
.pills { display:flex; gap:6px; flex-wrap:wrap; }
.pill { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:3px 12px; font-size:12px; color:var(--text2); display:flex; align-items:center; gap:6px; }
.pill b { color:var(--text); font-weight:600; }
.dot { width:7px; height:7px; border-radius:50%; }
/* ── cards ── */
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin-bottom:16px; }
.card-h { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; gap:10px; }
.card-h h2 { font-size:15px; font-weight:600; }
.hint { color:var(--text3); font-size:12px; }
/* ── mode ── */
.mode-group { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.mode-opt { border:1px solid var(--line); border-radius:8px; padding:12px 14px; cursor:pointer; transition:all .15s; background:#fff; }
.mode-opt:hover { border-color:#c9cdd4; }
.mode-opt.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); background:var(--accent-bg); }
.mode-opt input { display:none; }
.mode-opt b { display:block; font-size:15px; }
.mode-opt span { font-size:12px; color:var(--text3); }
.mode-opt.sel b { color:var(--accent); }
.params { margin-top:12px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; background:var(--bg); border-radius:8px; padding:10px 14px; }
.params .lbl { font-size:12px; color:var(--text2); }
/* ── provider ── */
.prov { border:1px solid var(--line); border-radius:8px; margin-bottom:12px; overflow:hidden; }
.p-head { display:flex; align-items:center; gap:10px; padding:10px 14px; background:#fafbfc; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.p-name { font-weight:600; }
.p-prefix { font-family:var(--mono); font-size:12px; color:var(--accent); background:var(--accent-bg); padding:1px 8px; border-radius:4px; }
.p-url { font-size:12px; color:var(--text3); font-family:var(--mono); }
.p-mode { font-size:11px; padding:1px 8px; border-radius:10px; }
.p-mode.normal { background:#f2f3f5; color:var(--text2); }
.p-mode.smart { background:var(--warn-bg); color:var(--warn); }
.p-mode.pro { background:var(--ok-bg); color:var(--ok); }
.p-mode.promax { background:var(--accent-bg); color:var(--accent); }
.cool-tag { font-size:11px; color:var(--warn); background:var(--warn-bg); padding:0 6px; border-radius:4px; }
/* ── models & reasoning ── */
.m-row { display:flex; align-items:center; gap:10px; padding:7px 14px; border-bottom:1px solid #f2f3f5; flex-wrap:wrap; }
.m-row:last-child { border-bottom:none; }
.m-id { font-family:var(--mono); font-size:12px; }
.m-badge { font-size:11px; padding:1px 8px; border-radius:10px; background:var(--accent-bg); color:var(--accent); }
.eff-row { display:flex; gap:6px; flex-wrap:wrap; padding:6px 14px 10px 34px; background:#fafbfc; }
.eff-pill { border:1px solid var(--line); background:#fff; border-radius:14px; padding:2px 10px; font-size:12px; cursor:pointer; color:var(--text2); }
.eff-pill.ok { background:var(--ok-bg); border-color:#b7ebc3; color:var(--ok); }
.eff-pill.info { background:var(--accent-bg); border-color:#bcd7ff; color:var(--accent); }
.eff-pill.warn { background:var(--warn-bg); border-color:#ffd6ad; color:var(--warn); }
.eff-pill.fail { background:var(--fail-bg); border-color:#ffd0c9; color:var(--fail); }
.eff-pill.other { background:#f2f3f5; border-color:var(--line); color:var(--text3); }
.eff-pill.idle { color:var(--text3); cursor:pointer; }
.eff-pill.cur { box-shadow:0 0 0 2px var(--accent); font-weight:600; }
.fold-btn { width:22px; height:22px; border:1px solid var(--line); background:#fff; border-radius:5px; cursor:pointer; font-size:11px; color:var(--text2); line-height:1; flex-shrink:0; }
.fold-btn:hover { border-color:#c9cdd4; }
.agg-model { font-family:var(--mono); font-size:12px; background:var(--bg); border:1px solid var(--line); border-radius:5px; padding:2px 8px; cursor:pointer; color:var(--text2); }
.agg-model:hover { border-color:var(--accent); color:var(--accent); }
.m-row.disabled { opacity:.5; }
.m-badge.off { background:#f2f3f5; color:var(--text3); }
/* ── toast ── */
#toast {
  position:fixed; top:18px; left:50%; transform:translateX(-50%) translateY(-8px);
  background:#1d2129; color:#fff; border-radius:8px; padding:9px 18px; font-size:13px;
  box-shadow:0 8px 24px rgba(0,0,0,.25); opacity:0; pointer-events:none;
  transition:opacity .25s, transform .25s; z-index:300; max-width:70vw;
}
#toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
#toast.err { background:var(--fail); }
.spacer { flex:1; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; font-weight:500; color:var(--text3); font-size:12px; padding:8px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:7px 14px; border-bottom:1px solid #f2f3f5; vertical-align:middle; }
tr:last-child td { border-bottom:none; }
.k-cell { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:12px; }
.k-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
.k-dot.ok { background:var(--ok); } .k-dot.warn { background:var(--warn); } .k-dot.fail { background:var(--fail); } .k-dot.idle { background:#c9cdd4; }
.num { font-variant-numeric:tabular-nums; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .fail { color:var(--fail); } .dim { color:var(--text3); }
.w-input { width:56px; border:1px solid var(--line); border-radius:4px; padding:2px 6px; font-size:12px; }
.add-row { display:flex; gap:8px; padding:10px 14px; border-top:1px solid var(--line); }
.empty { padding:16px 14px; color:var(--text3); font-size:13px; }
/* ── settings grid ── */
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px 18px; }
.f { display:flex; flex-direction:column; gap:4px; }
.f label { font-size:12px; color:var(--text2); }
.f input { border:1px solid var(--line); border-radius:6px; padding:6px 10px; font-size:13px; outline:none; }
.f input:focus { border-color:var(--accent); }
details.adv { margin-top:12px; }
details.adv summary { cursor:pointer; font-size:12px; color:var(--text2); user-select:none; }
details.adv .adv-inner { margin-top:10px; display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px 18px; }
/* ── logs ── */
.log { background:#fafbfc; border:1px solid var(--line); border-radius:8px; padding:10px 12px; height:240px; overflow-y:auto; font-family:var(--mono); font-size:12px; line-height:1.9; }
.log-line.l-ok { color:var(--ok); } .log-line.l-warn { color:var(--warn); } .log-line.l-fail { color:var(--fail); } .log-line.l-mgr { color:var(--accent); } .log-line.l-dim { color:var(--text3); }
/* ── buttons / inputs ── */
.btn { border:1px solid var(--line); background:#fff; color:var(--text); border-radius:6px; padding:5px 12px; font-size:12px; cursor:pointer; transition:all .15s; }
.btn:hover { border-color:#c9cdd4; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.primary:hover { opacity:.85; }
.btn.danger { color:var(--fail); border-color:#ffe0db; background:#fff; }
.btn.danger:hover { background:var(--fail-bg); }
.btn.sm { padding:3px 10px; font-size:12px; }
.inp { border:1px solid var(--line); border-radius:6px; padding:6px 10px; font-size:13px; outline:none; }
.inp:focus { border-color:var(--accent); }
/* ── modal ── */
.ov { position:fixed; inset:0; background:rgba(29,33,41,.45); display:none; align-items:center; justify-content:center; z-index:50; }
.ov.show { display:flex; }
.modal { background:#fff; border-radius:12px; padding:20px 22px; width:440px; max-width:92vw; box-shadow:0 12px 40px rgba(0,0,0,.15); }
.modal h3 { font-size:16px; margin-bottom:16px; }
.mf { margin-bottom:12px; }
.mf label { display:block; font-size:12px; color:var(--text2); margin-bottom:4px; }
.mf input, .mf textarea { width:100%; }
textarea.inp { font-family:var(--mono); resize:vertical; }
.m-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
@media (max-width:720px){ .mode-group { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <div class="top">
    <div class="brand"><span class="logo"></span>密钥池网关</div>
    <div class="pills" id="statusPills"></div>
  </div>

  <section class="card">
    <div class="card-h"><h2>运行模式</h2><span class="hint" id="modeDesc"></span></div>
    <div class="mode-group" id="modeGroup">
      <label class="mode-opt" id="mo-normal" onclick="pickMode(this,'normal')"><input type="radio" name="mode" value="normal"><b>普通</b><span>单 key 顺序请求，失败自动换 key 重试，最稳</span></label>
      <label class="mode-opt" id="mo-smart" onclick="pickMode(this,'smart')"><input type="radio" name="mode" value="smart"><b>Smart</b><span>顺序重试 + 429 自动冷却：被限流的 key 冻结，其他 key 顶上</span></label>
      <label class="mode-opt" id="mo-pro" onclick="pickMode(this,'pro')"><input type="radio" name="mode" value="pro"><b>Pro</b><span>全部 key 并发 1 轮，最快 200 胜出，其余关闭</span></label>
      <label class="mode-opt" id="mo-promax" onclick="pickMode(this,'promax')"><input type="radio" name="mode" value="promax"><b>Pro Max</b><span>全部 key 多轮错峰竞争（keys×轮次），赢家通吃</span></label>
    </div>
    <div class="params" id="smartParams" style="display:none">
      <span class="lbl">Smart 参数</span>
      <span class="lbl">429 冻结时长 (s)</span><input class="inp" id="cooldown429" type="number" min="1" max="600" style="width:80px" onchange="saveCooldown()">
      <span class="hint">某 key 返回 429 后冻结 N 秒不再使用，自动换其他 key；全部冻结则等待最短剩余后重试</span>
    </div>
    <div class="params" id="promaxParams" style="display:none">
      <span class="lbl">Pro Max 参数</span>
      <span class="lbl">轮次</span><input class="inp" id="raceRounds" type="number" min="1" max="20" style="width:70px" onchange="saveRaceParams()">
      <span class="lbl">轮次间隔 (ms)</span><input class="inp" id="roundDelay" type="number" min="0" max="30000" style="width:90px" onchange="saveRaceParams()">
      <span class="hint">间隔 0 = 全部同时发出（同刻 N×keys 并发，可能被上游限流）</span>
    </div>
  </section>

  <section class="card">
    <div class="card-h"><h2>模型提供商</h2><button class="btn primary sm" onclick="openProviderModal(null)">＋ 添加提供商</button></div>
    <div id="providers"></div>
  </section>

  <section class="card">
    <div class="card-h"><h2>Agent 接入</h2><span class="hint">任意 OpenAI 兼容客户端指向代理即可（含密钥池轮询/重试/模式策略）</span></div>
    <div id="agentList"></div>
  </section>

  <section class="card">
    <div class="card-h"><h2>模型与思考</h2><button class="btn sm" onclick="copyModelList()">复制模型列表（提供商/模型名）</button><span class="hint">🟢支持 🔵200未触发思考 🟡限流重测 🔴上游明确不支持 ⚪错误与思考无关 · 点档位即强制覆盖</span></div>
    <div id="modelCards"></div>
  </section>

  <section class="card">
    <div class="card-h"><h2>重试设置</h2><button class="btn primary sm" onclick="saveSettings()">保存设置</button></div>
    <div class="grid">
      <div class="f"><label>最大重试次数</label><input id="maxRetries" type="number" min="1" max="99999"></div>
      <div class="f"><label>重试间隔 (ms)</label><input id="retryDelay" type="number" min="0" max="60000"></div>
      <div class="f"><label>单请求超时 (ms)</label><input id="requestTimeout" type="number" min="1000" max="300000"></div>
      <div class="f"><label>总重试上限 (ms)</label><input id="overallTimeout" type="number" min="5000" max="3600000"></div>
      <div class="f"><label>连续失败熔断 (次)</label><input id="circuitBreaker" type="number" min="1" max="99999"></div>
      <div class="f"><label>代理端口</label><input id="proxyPort" type="number" disabled></div>
      <div class="f"><label>管理端口</label><input id="managePort" type="number" disabled></div>
    </div>
    <div class="config-row" style="margin-top:14px">
      <span class="config-label">接入密钥（客户端 Bearer 必须一致，留空 = 不校验）</span>
      <input class="input" id="accessKey" style="width:240px" placeholder="留空 = 不校验" autocomplete="off">
      <button class="btn btn-config" onclick="saveAccessKey()">保存密钥</button>
    </div>
    <details class="adv"><summary>高级参数（Pro / Pro Max）</summary>
      <div class="adv-inner">
        <div class="f"><label>Pro 最小重试间隔 (ms)</label><input id="raceMinRetryDelay" type="number" min="0" max="10000"></div>
        <div class="f"><label>Pro 每腿熔断 (次)</label><input id="raceCircuitBreaker" type="number" min="1" max="99999"></div>
      </div>
    </details>
  </section>

  <section class="card">
    <div class="card-h"><h2>实时日志</h2><span class="hint">重启后清空 · 每 3 秒自动刷新</span></div>
    <div class="log" id="logBox"></div>
  </section>
</main>

<div class="ov" id="providerModal">
  <div class="modal">
    <h3 id="pmTitle">添加提供商</h3>
    <div class="mf"><label>ID（小写字母开头，创建后不可改）</label><input class="inp" id="pmId" placeholder="myapi"></div>
    <div class="mf"><label>名称</label><input class="inp" id="pmName" placeholder="My API"></div>
    <div class="mf"><label>路径前缀（客户端访问 /前缀/v1/...）</label><input class="inp" id="pmPrefix" placeholder="/my"></div>
    <div class="mf"><label>Base URL（官方根域，不带 /v1）</label><input class="inp" id="pmTarget" placeholder="https://api.example.com"></div>
    <div class="mf"><label>密钥（可选，每行一个，支持 权重:密钥）</label><textarea class="inp" id="pmKeys" rows="3" placeholder="sk-xxx"></textarea></div>
    <div class="m-actions"><button class="btn" onclick="closeProviderModal()">取消</button><button class="btn primary" onclick="saveProvider()">保存</button></div>
  </div>
</div>

<div id="toast"></div>
<script>
const API = '';
let statusData = null;
let pmEditingId = null;
const MODE_DESC = {
  normal: '单 key 顺序重试，最稳',
  smart: '顺序重试 + 429 自动冷却',
  pro: '全 key 并发一轮，最快 200 胜出',
  promax: '全 key 多轮错峰竞争'
};

async function loadStatus() {
  try {
    const r = await fetch(API + '/api/status');
    statusData = await r.json();
    render();
  } catch (e) {
    document.getElementById('statusPills').innerHTML = '<span class="pill"><span class="dot" style="background:var(--fail)"></span>连接失败</span>';
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = (s === undefined || s === null) ? '' : String(s);
  return d.innerHTML;
}

function dotClass(last, fr) {
  if (last === 200 || last === '200') return 'ok';
  if (last === 'TIMEOUT' || last === 'ERR') return 'fail';
  if (last === 429 || last === '429') return 'warn';
  if (fr > 0.5) return 'fail';
  if (fr > 0.2) return 'warn';
  return 'idle';
}

function render() {
  const d = statusData;
  if (!d) return;
  const pills = document.getElementById('statusPills');
  let tk = 0, tok = 0, tf = 0;
  for (const pid in d.providers) {
    for (const k of d.providers[pid].keys) { tk++; tok += k.success; tf += k.fail; }
  }
  const modeName = { normal: '普通', smart: 'Smart', pro: 'Pro', promax: 'Pro Max' }[d.mode] || '普通';
  pills.innerHTML =
    '<span class="pill"><span class="dot" style="background:var(--ok)"></span>代理 :' + d.proxyPort + '</span>' +
    '<span class="pill"><b>' + modeName + '</b></span>' +
    '<span class="pill">密钥 <b>' + tk + '</b></span>' +
    '<span class="pill"><b class="ok">' + tok + '</b> 成功</span>' +
    '<span class="pill"><b class="' + (tf > 0 ? 'warn' : '') + '">' + tf + '</b> 失败</span>';

  document.getElementById('modeDesc').textContent = MODE_DESC[d.mode] || '';
  for (const m of ['normal', 'smart', 'pro', 'promax']) {
    const el = document.getElementById('mo-' + m);
    if (el) el.className = 'mode-opt' + (d.mode === m ? ' sel' : '');
  }
  document.getElementById('smartParams').style.display = (d.mode === 'smart') ? 'flex' : 'none';
  document.getElementById('promaxParams').style.display = (d.mode === 'promax') ? 'flex' : 'none';

  const ae = document.activeElement;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && el !== ae) el.value = val; };
  setVal('cooldown429', d.cooldown429 || 30);
  setVal('raceRounds', d.raceRounds || 3);
  setVal('roundDelay', d.roundDelay || 0);

  renderProviders(d, ae);
  renderAgent(d);
  renderModelCards(d);
  renderSettings(d, ae);

  const logBox = document.getElementById('logBox');
  logBox.innerHTML = (d.recentLogs || []).map(l => {
    let cls = 'l-dim';
    if (l.includes('[200]') || l.includes('[RACE WIN]')) cls = 'l-ok';
    else if (l.includes('[429]')) cls = 'l-warn';
    else if (l.includes('[500]') || l.includes('[502]') || l.includes('[503]') || l.includes('[504]') || l.includes('[TIMEOUT]') || l.includes('[ERR]') || l.includes('[EXHAUSTED]')) cls = 'l-fail';
    else if (l.includes('[MGR]')) cls = 'l-mgr';
    return '<div class="log-line ' + cls + '">' + esc(l) + '</div>';
  }).join('');
  logBox.scrollTop = logBox.scrollHeight;
  document.getElementById('logCount') && (document.getElementById('logCount').textContent = (d.recentLogs || []).length + ' 条');
}

function renderProviders(d, ae) {
  let html = '';
  const hasProv = Object.keys(d.providers).length > 0;
  for (const pid in d.providers) {
    const p = d.providers[pid];
    const modeCls = { normal: 'normal', smart: 'smart', pro: 'pro', promax: 'promax' }[p.mode] || 'normal';
    const modeTxt = { normal: '普通', smart: 'Smart', pro: 'Pro', promax: 'Pro Max' }[p.mode] || '跟随全局';
    const folded = collapsedUI['keys|' + pid] !== false;   // default: folded
    let rows = '';
    let sumOk = 0, sumFail = 0;
    if (!p.keys.length) {
      rows = '<tr><td colspan="8" class="empty">暂无密钥 — 在下方添加</td></tr>';
    }
    for (let i = 0; i < p.keys.length; i++) {
      const k = p.keys[i];
      const fr = (k.success + k.fail) > 0 ? (k.fail / (k.success + k.fail)) : 0;
      let dc = dotClass(k.lastStatus, fr);
      const cooling = (k.cooldown || 0) > 0;
      if (cooling) dc = 'warn';
      const lastTxt = (k.lastStatus === '-' || k.lastStatus === undefined) ? '-' : String(k.lastStatus);
      sumOk += k.success; sumFail += k.fail;
      rows += '<tr>' +
        '<td><span class="k-cell"><span class="k-dot ' + dc + '"></span>' + esc(k.key) +
          (cooling ? ' <span class="cool-tag">冷却 ' + k.cooldown + 's</span>' : '') + '</span></td>' +
        '<td><input class="w-input" type="number" min="1" max="999" id="w-' + pid + '-' + i + '" value="' + (k.weight || 1) + '" onchange="setWeight(\\\'' + pid + '\\\',' + i + ',this.value)"></td>' +
        '<td class="num ok">' + k.success + '</td>' +
        '<td class="num ' + (k.fail > 0 ? 'warn' : 'dim') + '">' + k.fail + '</td>' +
        '<td class="num ' + dc + '">' + esc(lastTxt) + '</td>' +
        '<td class="num dim">' + (k.avgLatency ? k.avgLatency + 'ms' : '-') + '</td>' +
        '<td class="num">' + (k.tps ? fmtTps(k.tps) : '<span class="dim">-</span>') + '</td>' +
        '<td><button class="btn danger sm" onclick="delKey(\\\'' + pid + '\\\',' + i + ')">删除</button></td>' +
        '</tr>';
    }
    const host = (p.targetUrl || '').replace(/^https?:\\/\\//, '');
    html += '<div class="prov">' +
      '<div class="p-head">' +
        '<button class="fold-btn" onclick="toggleCollapse(\\\'keys|' + pid + '\\\')" title="展开/收起密钥列表">' + (folded ? '▸' : '▾') + '</button>' +
        '<span class="p-name">' + esc(p.name) + '</span>' +
        (p.prefix ? '<span class="p-prefix">' + esc(p.prefix) + '</span>' : '') +
        '<span class="p-mode ' + modeCls + '">' + modeTxt + '</span>' +
        '<span class="p-url">' + esc(host) + '</span>' +
        '<span class="p-url">' + p.keys.length + ' key · <span class="ok">' + sumOk + '</span>/<span class="' + (sumFail ? 'warn' : 'dim') + '">' + sumFail + '</span></span>' +
        '<span class="spacer"></span>' +
        '<button class="btn sm" onclick="openProviderModal(\\\'' + pid + '\\\')">编辑</button>' +
        '<button class="btn danger sm" onclick="delProvider(\\\'' + pid + '\\\')">删除</button>' +
      '</div>' +
      '<div style="display:' + (folded ? 'none' : 'block') + '">' +
      '<table><thead><tr><th>密钥</th><th>权重</th><th>成功</th><th>失败</th><th>最近</th><th>延迟</th><th>Token/秒</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="add-row">' +
        '<input class="inp" style="flex:1" id="newkey-' + pid + '" placeholder="粘贴 API 密钥...">' +
        '<input class="inp" id="newweight-' + pid + '" type="number" min="1" max="999" value="1" style="width:70px" placeholder="权重">' +
        '<button class="btn primary sm" onclick="addKey(\\\'' + pid + '\\\')">添加</button>' +
      '</div>' +
      '</div>' +
    '</div>';
  }
  if (!hasProv) html = '<div class="empty">还没有提供商 — 点击右上角「添加提供商」</div>';
  document.getElementById('providers').innerHTML = html;
}

function fmtTps(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M/s';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k/s';
  return n + '/s';
}

function toggleCollapse(key) {
  collapsedUI[key] = (collapsedUI[key] === false);   // toggle (default folded)
  renderProviders(statusData);
  renderModelCards(statusData);
}

function renderAgent(d) {
  const host = location.hostname || '127.0.0.1';
  const base = 'http://' + host + ':' + d.proxyPort;   // no /v1 — proxy handles path shaping
  const ak = d.accessKey || '';
  const akHtml = ak
    ? '<span class="m-id" style="font-family:var(--mono)">' + esc(ak) + '</span> <button class="btn sm" onclick="copyText(\\\'' + esc(ak) + '\\\')">复制</button>'
    : '<span class="dim">未设置（不校验客户端密钥）— 在「重试设置」中设置后启用</span>';
  const html =
    '<div class="prov"><div class="p-head">' +
      '<span class="p-name">统一接入入口</span>' +
      '<span class="p-url">' + esc(base) + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="btn sm" onclick="copyText(\\\'' + base + '\\\')">复制地址</button>' +
    '</div>' +
    '<div class="add-row" style="display:block">' +
      '<div style="margin-bottom:6px"><span class="hint">接入密钥（客户端 Authorization Bearer 需与此一致）：</span>' + akHtml + '</div>' +
      '<div class="hint">模型名格式：<b>提供商/模型名</b>（如 sensenova/glm-5.2）；完整列表见下方「模型与思考」，每行有复制按钮。</div>' +
    '</div></div>';
  document.getElementById('agentList').innerHTML = html;
}

// ─── Models & reasoning effort UI ───
const modelsUI = {};      // pid -> 'loading' | [ids]
const probeUI = {};       // 'pid|model' -> 'loading' | results{}
const collapsedUI = {};   // 'keys|pid' / 'models|pid' -> false = expanded (default folded)
const allProbe = {};      // pid -> provider-wide probe job mirror {running,total,done,current,results}

async function probeAllStart(pid) {
  try {
    const r = await fetch(API + '/api/probe/all/' + encodeURIComponent(pid), { method: 'POST' });
    const j = await r.json();
    if (!r.ok) { alert(j.error || '启动失败'); return; }
  } catch (e) { alert('启动失败: ' + e.message); return; }
  if (!allProbe[pid]) allProbe[pid] = { running: true, total: 0, done: 0, results: {} };
  allProbe[pid].running = true;
  collapsedUI['models|' + pid] = false;   // auto-expand to show progress
  const timer = setInterval(async () => {
    try {
      const r = await fetch(API + '/api/probe/status/' + encodeURIComponent(pid));
      const j = await r.json();
      allProbe[pid] = j;
      renderModelCards(statusData);
      if (!j.running) {
        clearInterval(timer);
        loadStatus();
      }
    } catch (e) { /* keep polling */ }
  }, 2500);
  renderModelCards(statusData);
}

async function loadModels(pid, force) {
  if (modelsUI[pid] === 'loading') return;
  if (force || !modelsUI[pid]) {
    modelsUI[pid] = 'loading';
    renderModelCards(statusData);
    try {
      const r = await fetch(API + '/api/models/' + encodeURIComponent(pid) + (force ? '?refresh=1' : ''));
      const j = await r.json();
      modelsUI[pid] = j.ids || [];
    } catch (e) {
      modelsUI[pid] = [];
    }
    renderModelCards(statusData);
  }
}

function refreshModels(pid) { modelsUI[pid] = null; loadModels(pid, true); }

async function probeEffort(pid, model) {
  const key = pid + '|' + model;
  probeUI[key] = 'loading';
  renderModelCards(statusData);
  try {
    const r = await fetch(API + '/api/probe/effort/' + encodeURIComponent(pid), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
    const j = await r.json();
    probeUI[key] = j.results || { error: (j.error || 'unknown') };
  } catch (e) {
    probeUI[key] = { error: e.message };
  }
  renderModelCards(statusData);
}

async function setOverride(pid, model, effort) {
  await fetch(API + '/api/override/' + encodeURIComponent(pid), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, effort }) });
  loadStatus();
}

async function toggleModelDisabled(pid, model, disabled) {
  await fetch(API + '/api/model/' + encodeURIComponent(pid) + '/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, disabled }) });
  showToast(disabled ? '已禁用 ' + pid + '/' + model + '（列表隐藏 + 请求拒绝）' : '已启用 ' + pid + '/' + model);
  loadStatus();
}

function pillCls(res, eff) {
  if (!res) return 'idle';
  if (res.http === 200) {
    if (eff === 'none') return res.hasReasoning ? 'warn' : 'ok';
    return res.hasReasoning ? 'ok' : 'info';
  }
  if (res.http === 429) return 'warn';                    // rate-limited mid-probe: retest
  if (res.related) return 'fail';                          // error body explicitly rejects this effort
  return 'other';                                          // unrelated error (params/quota/...) — NOT evidence
}

function renderModelCards(d) {
  if (!d) return;
  const EFF = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  let html = '';
  for (const pid in d.providers) {
    const p = d.providers[pid];
    const ovs = p.modelOverrides || {};
    const ids = modelsUI[pid];
    const folded = collapsedUI['models|' + pid] !== false;   // default: folded
    const job = allProbe[pid];
    const jobActive = job && (job.running || (job.total > 0 && job.done < job.total && !job.error && job.done > 0));
    // Disabled count must be computed for EVERY render path (head uses it)
    const offCount = Array.isArray(ids) ? ids.filter(m => p.disabledModels && p.disabledModels[m]).length : 0;
    let rows = '';
    if (ids === 'loading') {
      rows = '<div class="empty">模型列表加载中…</div>';
    } else if (Array.isArray(ids) && ids.length) {
      for (const mid of ids) {
        const key = pid + '|' + mid;
        const ov = ovs[mid];
        const off = !!(d.providers[pid].disabledModels && d.providers[pid].disabledModels[mid]);
        // Job results (one-click test) take precedence over single-model probes
        const pr = (job && job.results && job.results[mid]) ? job.results[mid] : probeUI[key];
        let effRow = '';
        if (pr) {
          let pills = '<span class="eff-pill idle" onclick="setOverride(\\\'' + pid + '\\\',\\\'' + mid + '\\\',null)" title="清除强制，跟随客户端">跟随客户端</span>';
          for (const eff of EFF) {
            const res = (pr && pr.error) ? null : (pr ? pr[eff] : null);
            let cls = 'idle', title = '';
            if (pr && pr.error) { cls = 'fail'; title = pr.error; }
            else if (res) {
              cls = pillCls(res, eff);
              title = 'HTTP ' + res.http + ' · ' + res.ms + 'ms' + (res.hasReasoning ? ' · 思考已发生' : '') + (res.snippet ? ' · ' + res.snippet : '');
            }
            const cur = (ov === eff) ? ' cur' : '';
            // Every effort pill is clickable — probe results are advisory only;
            // the user decides whether to force a level regardless of the probe.
            const click = ' onclick="setOverride(\\\'' + pid + '\\\',\\\'' + mid + '\\\',\\\'' + eff + '\\\')"';
            pills += '<span class="eff-pill ' + cls + cur + '"' + click + ' title="' + esc(title) + '">' + eff + '</span>';
          }
          effRow = '<div class="eff-row">' + pills + '</div>';
        }
        rows += '<div class="m-row' + (off ? ' disabled' : '') + '">' +
          '<span class="m-id">' + esc(mid) + '</span>' +
          (off ? '<span class="m-badge off">已禁用</span>' : (ov ? '<span class="m-badge">强制 ' + esc(ov) + '</span>' : '')) +
          '<span class="spacer"></span>' +
          '<button class="btn sm" onclick="copyText(\\\'' + pid + '/' + mid + '\\\')" title="复制为 ' + esc(pid + '/' + mid) + '">复制</button>' +
          '<button class="btn sm" onclick="toggleModelDisabled(\\\'' + pid + '\\\',\\\'' + mid + '\\\',' + (!off) + ')">' + (off ? '启用' : '禁用') + '</button>' +
          '<button class="btn sm" onclick="probeEffort(\\\'' + pid + '\\\',\\\'' + mid + '\\\')"' + (pr === 'loading' ? ' disabled' : '') + '>' + (pr === 'loading' ? '测试中…' : '测试') + '</button>' +
        '</div>' + effRow;
      }
    } else if (Array.isArray(ids)) {
      rows = '<div class="empty">上游未返回模型</div>';
    } else {
      rows = '<div class="empty">点击「加载模型」拉取上游列表</div>';
    }
    const jobTxt = job && job.total ? ' · 测试 ' + job.done + '/' + job.total + (job.current ? '（' + esc(job.current) + '）' : '') + (job.running ? '' : ' ✓') : '';
    html += '<div class="prov">' +
      '<div class="p-head">' +
        '<button class="fold-btn" onclick="toggleCollapse(\\\'models|' + pid + '\\\')" title="展开/收起模型列表">' + (folded ? '▸' : '▾') + '</button>' +
        '<span class="p-name">' + esc(p.name) + '</span>' +
        (p.prefix ? '<span class="p-prefix">' + esc(p.prefix) + '</span>' : '') +
        '<span class="p-url">' + (Array.isArray(ids) ? ids.length + ' 个模型' + (offCount ? '（禁用 ' + offCount + '）' : '') : '') + '</span>' +
        '<span class="p-url">' + (Object.keys(ovs).length ? '已强制 ' + Object.keys(ovs).length : '') + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn primary sm" onclick="probeAllStart(\\\'' + pid + '\\\')"' + (jobActive ? ' disabled' : '') + '>' + (jobActive ? '测试中 ' + (job ? job.done + '/' + job.total : '') : '一键测试') + '</button>' +
        '<button class="btn sm" onclick="loadModels(\\\'' + pid + '\\\',false)">加载模型</button>' +
        '<button class="btn sm" onclick="refreshModels(\\\'' + pid + '\\\')">强制刷新</button>' +
      '</div>' +
      '<div style="display:' + (folded ? 'none' : 'block') + '">' + rows + '</div>' +
    '</div>';
  }
  document.getElementById('modelCards').innerHTML = html;
  // 自动加载未拉取过的列表
  for (const pid in d.providers) {
    if (!modelsUI[pid]) loadModels(pid, false);
  }
}

function renderSettings(d, ae) {
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && el !== ae) el.value = val; };
  setVal('maxRetries', d.maxRetries);
  setVal('retryDelay', d.retryDelay || 0);
  setVal('requestTimeout', d.requestTimeout || 30000);
  setVal('overallTimeout', d.overallTimeout || 120000);
  setVal('circuitBreaker', d.circuitBreaker || 8);
  setVal('accessKey', d.accessKey || '');
  setVal('raceMinRetryDelay', d.raceMinRetryDelay || 500);
  setVal('raceCircuitBreaker', d.raceCircuitBreaker || 5);
  setVal('proxyPort', d.proxyPort);
  setVal('managePort', d.managePort);
}

function pickMode(el, m) {
  for (const x of ['normal', 'smart', 'pro', 'promax']) {
    const e = document.getElementById('mo-' + x);
    if (e) e.className = 'mode-opt' + (x === m ? ' sel' : '');
  }
  fetch(API + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) });
  setTimeout(loadStatus, 300);
}

async function saveCooldown() {
  const cooldown429 = parseInt(document.getElementById('cooldown429').value) || 30;
  await fetch(API + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cooldown429 }) });
  loadStatus();
}

// ─── In-page toast (auto-dismiss), replaces alert-style popups ───
let toastTimer = null;
function showToast(msg, isErr) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    showToast('已复制: ' + (txt.length > 60 ? txt.slice(0, 60) + '…' : txt));
  } catch (e) {
    showToast('复制失败: ' + e.message, true);
  }
}

// Copy all models as "provider/model" lines (the agreed agent-facing format)
async function copyModelList() {
  const lines = [];
  for (const pid in modelsUI) {
    if (Array.isArray(modelsUI[pid])) {
      for (const mid of modelsUI[pid]) lines.push(pid + '/' + mid);
    }
  }
  if (!lines.length) { showToast('模型列表尚未加载，请先在下方加载模型', true); return; }
  try {
    await navigator.clipboard.writeText(lines.join('\\n'));
    showToast('已复制 ' + lines.length + ' 个模型名（提供商/模型名 格式）');
  } catch (e) {
    showToast('复制失败: ' + e.message, true);
  }
}

async function saveAccessKey() {
  const accessKey = document.getElementById('accessKey').value.trim();
  await fetch(API + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
  showToast(accessKey ? '接入密钥已保存，客户端鉴权已启用' : '接入密钥已清空，客户端鉴权已关闭');
  loadStatus();
}

async function saveRaceParams() {
  const raceRounds = parseInt(document.getElementById('raceRounds').value) || 3;
  const roundDelay = parseInt(document.getElementById('roundDelay').value) || 0;
  await fetch(API + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raceRounds, roundDelay }) });
  loadStatus();
}

async function saveSettings() {
  const g = (id) => parseInt(document.getElementById(id).value);
  const body = {
    maxRetries: g('maxRetries') || 10,
    retryDelay: g('retryDelay') || 0,
    requestTimeout: g('requestTimeout') || 30000,
    overallTimeout: g('overallTimeout') || 120000,
    circuitBreaker: g('circuitBreaker') || 8,
    raceMinRetryDelay: g('raceMinRetryDelay') || 500,
    raceCircuitBreaker: g('raceCircuitBreaker') || 5
  };
  await fetch(API + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  loadStatus();
}

async function addKey(pid) {
  const input = document.getElementById('newkey-' + pid);
  const key = input.value.trim();
  if (!key) return;
  const wi = document.getElementById('newweight-' + pid);
  const weight = wi ? parseInt(wi.value) : 1;
  await fetch(API + '/api/keys/' + pid, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, weight }) });
  input.value = '';
  loadStatus();
}

async function setWeight(pid, index, weight) {
  const w = Math.max(1, parseInt(weight) || 1);
  await fetch(API + '/api/keys/' + pid + '/' + index + '/weight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ weight: w }) });
  loadStatus();
}

async function delKey(pid, index) {
  if (!confirm('确定删除该密钥？')) return;
  await fetch(API + '/api/keys/' + pid + '/' + index, { method: 'DELETE' });
  loadStatus();
}

function openProviderModal(pid) {
  pmEditingId = pid;
  document.getElementById('pmTitle').textContent = pid ? '编辑提供商' : '添加提供商';
  const idEl = document.getElementById('pmId');
  if (pid && statusData && statusData.providers[pid]) {
    const p = statusData.providers[pid];
    document.getElementById('pmName').value = p.name || '';
    document.getElementById('pmPrefix').value = p.prefix || '';
    document.getElementById('pmTarget').value = p.targetUrl || '';
    document.getElementById('pmKeys').value = '';
    idEl.value = pid; idEl.disabled = true; idEl.style.opacity = .55;
  } else {
    document.getElementById('pmName').value = '';
    document.getElementById('pmPrefix').value = '';
    document.getElementById('pmTarget').value = '';
    document.getElementById('pmKeys').value = '';
    idEl.value = ''; idEl.disabled = false; idEl.style.opacity = 1;
  }
  document.getElementById('providerModal').classList.add('show');
}

function closeProviderModal() {
  document.getElementById('providerModal').classList.remove('show');
}

async function saveProvider() {
  const id = document.getElementById('pmId').value.trim();
  const name = document.getElementById('pmName').value.trim();
  const prefix = document.getElementById('pmPrefix').value.trim();
  const targetUrl = document.getElementById('pmTarget').value.trim();
  const keysText = document.getElementById('pmKeys').value.trim();
  const keys = [];
  if (keysText) {
    for (const line of keysText.split(/\\r?\\n/)) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^(\\d+):(.+)$/);
      if (m) keys.push({ key: m[2].trim(), weight: parseInt(m[1]) });
      else keys.push(t);
    }
  }
  const body = { name, prefix, targetUrl, keys };
  const url = pmEditingId ? API + '/api/providers/' + encodeURIComponent(pmEditingId) : API + '/api/providers';
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) { showToast('保存失败: ' + (j.error || r.status), true); return; }
  closeProviderModal();
  loadStatus();
}

async function delProvider(pid) {
  if (!confirm('删除提供商「' + pid + '」？其全部密钥将从磁盘删除！')) return;
  if (!confirm('再次确认：删除后该前缀路由立即失效，不可恢复。删除？')) return;
  const r = await fetch(API + '/api/providers/' + encodeURIComponent(pid), { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) { showToast('删除失败: ' + (j.error || r.status), true); return; }
  loadStatus();
}

loadStatus();
setInterval(loadStatus, 3000);
</script>
</body>
</html>
`;

// ─── Process-level safety net ───
// The gateway must stay alive: a stray callback error or an unhandled
// rejection gets logged (with stack) instead of silently killing the process.
process.on('uncaughtException', (e) => {
  log('UNCAUGHT-EXCEPTION: ' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (r) => {
  log('UNHANDLED-REJECTION: ' + ((r && (r.stack || r.message)) || r));
});

// ─── Start servers ───
function start() {
  reloadConfig();
  const proxyPort = config.port || 9119;
  const managePort = config.managePort || 9120;

  const proxyServer = http.createServer((req, res) => {
    handleProxy(req, res).catch((e) => {
      // A single bad request must never kill the gateway process.
      log('PROXY-ERROR: ' + ((e && e.stack) || e));
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error: ' + e.message }));
        }
      } catch (_) { /* socket already gone */ }
    });
  });
  proxyServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log('INFO: 端口 ' + proxyPort + ' 已被占用 —— 已有实例在运行，服务不受影响，本次启动退出');
      process.exit(0);
    }
    log('FATAL: Proxy server error: ' + e.message);
    process.exit(1);
  });
  proxyServer.listen(proxyPort, '127.0.0.1', () => {
    log('Proxy server started on 127.0.0.1:' + proxyPort);
    log('  retryDelay=' + (config.retryDelay || 0) + 'ms requestTimeout=' + (config.requestTimeout || 30000) + 'ms maxRetries=' + (config.maxRetries || 10));
    for (const pid in config.providers) {
      const p = config.providers[pid];
      const n = (p.keys || []).length;
      log('  ' + p.name + ': ' + n + ' key(s)');
    }
  });

  const manageServer = http.createServer((req, res) => {
    handleManage(req, res).catch((e) => {
      log('MGR-ERROR: ' + ((e && e.stack) || e));
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error: ' + e.message }));
        }
      } catch (_) { /* socket already gone */ }
    });
  });
  manageServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log('INFO: 管理端口 ' + managePort + ' 已被占用 —— 已有实例在运行，服务不受影响，本次启动退出');
      process.exit(0);
    }
    log('FATAL: Manage server error: ' + e.message);
  });
  manageServer.listen(managePort, '127.0.0.1', () => {
    log('Management UI started on http://127.0.0.1:' + managePort);
  });

  process.on('SIGINT', () => {
    log('Shutting down...');
    proxyServer.close();
    manageServer.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down...');
    proxyServer.close();
    manageServer.close();
    process.exit(0);
  });
}

start();
