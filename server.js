'use strict';

/**
 * 短信验证码管理与操作审计控制台 —— 单进程、零第三方依赖。
 *
 * 为什么零依赖：部署环境只提供「一个 HTTP 端口」，不提供额外服务；
 * 不引入 express 等包可以让安装阶段完全不依赖网络与原生编译。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const authLib = require('./lib/auth');
const { extractCode } = require('./lib/smscode');
const feishu = require('./lib/feishu');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ_OFFSET = 8 * 60 * 60 * 1000; // 业务时区固定为北京时间
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'sms_sess';
const MAX_BODY = 128 * 1024;

const db = store.init();

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function dayKey(iso) {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  return new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);
}

function todayKey() {
  return dayKey(nowIso());
}

function sendJson(res, status, data, headers) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text, contentType) {
  const trimmed = (text || '').trim();
  if (!trimmed) return {};
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed;
    } catch (err) {
      // 落到表单解析
    }
  }
  if (ct.includes('urlencoded') || trimmed.includes('=')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(trimmed)) {
      if (out[k] === undefined) out[k] = v;
    }
    if (Object.keys(out).length) return out;
  }
  return { _raw: trimmed };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + host;
}

function isSecure(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket && req.socket.encrypted);
}

/**
 * 线上网关的规则：
 * - 每个请求都要带 sharecode，且网关在校验后会把它从转发请求里去掉；
 * - 回源 Host 是沙箱内网域名，不是用户看到的公网域名。
 * 所以公网域名 + sharecode 由浏览器通过 /api/session-context 上报后存下来，
 * 生成 webhook 地址和飞书卡片链接时优先使用。
 */
function publicBase(req) {
  const base = db.settings.publicBase || baseUrl(req);
  return String(base).replace(/\/+$/, '');
}

function entryUrlFor(req, shareCode) {
  const code = shareCode || db.settings.shareCode || '';
  return publicBase(req) + '/app' + (code ? '?sharecode=' + encodeURIComponent(code) : '');
}

function webhookUrlFor(req, shareCode) {
  const code = shareCode || db.settings.shareCode || '';
  let out = publicBase(req) + '/api/webhook/sms?token=' + db.settings.webhookToken;
  if (code) out += '&sharecode=' + encodeURIComponent(code);
  return out;
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const payload = authLib.readSession(token, db.settings.sessionSecret);
  if (!payload) return null;
  const user = db.users.find((u) => u.id === payload.uid);
  if (!user || !user.active) return null;
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    active: user.active,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || ''
  };
}

const loginAttempts = new Map();

function limitKey(req, username) {
  return clientIp(req) + '|' + String(username || '').toLowerCase();
}

function loginAllowed(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return true;
  if (Date.now() > rec.resetAt) {
    loginAttempts.delete(key);
    return true;
  }
  return rec.count < 8;
}

function markLoginFail(key) {
  const rec = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 5 * 60 * 1000 };
  rec.count += 1;
  rec.resetAt = Date.now() + 5 * 60 * 1000;
  loginAttempts.set(key, rec);
}

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

function audit(entry) {
  const user = entry.user || null;
  const rec = {
    id: store.newId('a'),
    ts: nowIso(),
    userId: user ? user.id : '',
    username: user ? user.username : (entry.username || ''),
    name: user ? user.name : (entry.name || ''),
    action: entry.action,
    smsId: entry.smsId || '',
    phone: entry.phone || '',
    code: entry.code || '',
    purpose: entry.purpose || '',
    content: entry.content || '',
    ip: entry.ip || '',
    ua: (entry.ua || '').slice(0, 300),
    extra: entry.extra || ''
  };
  db.audit.push(rec);
  store.save('audit');
  return rec;
}

/* ------------------------------------------------------------------ */
/* 短信入库                                                            */
/* ------------------------------------------------------------------ */

const PHONE_KEYS = ['from', 'phone', 'sender', 'mobile', 'address', 'originatingAddress',
  'originationAddress', 'number', 'tel', 'phoneNumber', 'mobiles'];
const CONTENT_KEYS = ['content', 'msg', 'message', 'text', 'body', 'sms', 'smsContent',
  'org_content', 'content_text', 'shortMessage'];
const TIME_KEYS = ['receive_time', 'receiveTime', 'receivedAt', 'time', 'timestamp', 'date', 'datetime'];
const DEVICE_KEYS = ['device_mark', 'deviceMark', 'device', 'deviceName', 'device_name'];
const SLOT_KEYS = ['card_slot', 'cardSlot', 'sim', 'slot', 'title'];

function coerceValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.length ? coerceValue(v[0]) : '';
    return '';
  }
  return String(v).trim();
}

function pickField(obj, keys) {
  for (const key of keys) {
    const val = coerceValue(obj[key]);
    if (val !== '') return val;
  }
  return '';
}

function flattenInbound(body, query) {
  let payload = body;
  if (Array.isArray(payload)) payload = payload[0];
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try { payload = JSON.parse(text); } catch (err) { payload = { content: text }; }
    } else {
      payload = { content: text };
    }
  }
  if (!payload || typeof payload !== 'object') payload = {};

  const sources = [query || {}, payload];
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    sources.push(payload.data);
  }

  const flat = {};
  for (const src of sources) {
    for (const key of Object.keys(src)) {
      if (key === 'token' || key === 'sharecode') continue;
      if (flat[key] !== undefined) continue;
      const val = coerceValue(src[key]);
      if (val !== '') flat[key] = val;
    }
  }
  return flat;
}

function parseInboundTime(raw) {
  const value = String(raw || '').trim();
  if (!value) return nowIso();
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
  if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  // 手机发来的本地时间（北京时间），显式补时区，避免服务器在 UTC 时整体偏移 8 小时
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(value)) {
    const normalized = value.replace(/\//g, '-').replace(' ', 'T');
    const iso = normalized.length === 16 ? normalized + ':00' : normalized;
    return new Date(iso + '+08:00').toISOString();
  }
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)) {
    return new Date(value.replace(/\//g, '-') + 'T00:00:00+08:00').toISOString();
  }
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  return nowIso();
}

function findDuplicate(phone, content, receiveAt) {
  const target = new Date(receiveAt).getTime();
  const list = db.sms;
  for (let i = list.length - 1; i >= 0 && i > list.length - 300; i -= 1) {
    const item = list[i];
    if (item.deletedAt) continue;
    if (item.phone !== phone || item.content !== content) continue;
    const ts = new Date(item.receiveAt).getTime();
    if (Number.isNaN(ts) || Number.isNaN(target)) continue;
    if (Math.abs(ts - target) <= 5 * 60 * 1000) return item;
  }
  return null;
}

function insertSms(flat, meta) {
  const phone = pickField(flat, PHONE_KEYS) || '未知号码';
  let content = pickField(flat, CONTENT_KEYS);
  if (!content) content = coerceValue(flat._raw);
  const receiveAt = parseInboundTime(pickField(flat, TIME_KEYS));
  const device = pickField(flat, DEVICE_KEYS);
  const slot = pickField(flat, SLOT_KEYS);

  if (!content) throw new Error('短信内容为空，请检查手机端 webParams 是否映射了 [content]');

  const duplicate = findDuplicate(phone, content, receiveAt);
  if (duplicate) return { record: duplicate, duplicate: true };

  const parsed = extractCode(content, db.settings.codeRegex);

  const record = {
    id: store.newId('s'),
    phone,
    content,
    code: parsed.code,
    confidence: parsed.confidence,
    device,
    slot,
    receiveAt,
    receiveAtRaw: pickField(flat, TIME_KEYS),
    createdAt: nowIso(),
    ip: meta.ip || '',
    ua: (meta.ua || '').slice(0, 300),
    deletedAt: null,
    deletedBy: ''
  };

  db.sms.push(record);
  store.save('sms');

  if (db.settings.feishu && db.settings.feishu.enabled && db.settings.feishu.url) {
    const smsForPush = Object.assign({}, record, {
      receiveTimeText: new Date(record.receiveAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false
      })
    });
    feishu.sendSms(smsForPush, db.settings.feishu, meta.entryUrl)
      .then(() => {
        db.settings.feishu.lastError = '';
        db.settings.feishu.lastPushAt = nowIso();
        store.save('settings');
      })
      .catch((err) => {
        console.error('[feishu] 推送失败: ' + err.message);
        db.settings.feishu.lastError = err.message;
        db.settings.feishu.lastErrorAt = nowIso();
        store.save('settings');
      });
  }

  return { record, duplicate: false };
}

/* ------------------------------------------------------------------ */
/* 初始化默认管理员                                                     */
/* ------------------------------------------------------------------ */

function seed() {
  if (db.users.length === 0) {
    const { salt, hash } = authLib.hashPassword('Admin@123456');
    db.users.push({
      id: store.newId('u'),
      username: 'admin',
      name: '系统管理员',
      role: 'admin',
      salt,
      hash,
      active: true,
      mustChangePassword: true,
      createdAt: nowIso(),
      lastLoginAt: ''
    });
    store.save('users');
    console.log('[init] 已创建默认账号 admin / Admin@123456');
  }
}
seed();

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveFile(res, relPath, cache) {
  const target = path.join(PUBLIC_DIR, relPath);
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  /* ---------- 页面 ---------- */
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const user = currentUser(req);
    if (user) {
      res.writeHead(302, { Location: '/app' });
      res.end();
      return;
    }
    serveFile(res, 'index.html', false);
    return;
  }

  if (method === 'GET' && (pathname === '/app' || pathname === '/app.html')) {
    const user = currentUser(req);
    if (!user) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    serveFile(res, 'app.html', false);
    return;
  }

  if (method === 'GET' && pathname.startsWith('/assets/')) {
    serveFile(res, pathname.slice(1), true);
    return;
  }

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  /* ---------- 短信 webhook（手机端调用，无需登录） ---------- */
  if (pathname === '/api/webhook/sms' && (method === 'POST' || method === 'GET' || method === 'PUT')) {
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    const token = query.token || req.headers['x-webhook-token'] || '';
    if (!authLib.safeEqual(token, db.settings.webhookToken)) {
      audit({
        action: 'webhook_rejected',
        username: '未知来源',
        ip: clientIp(req),
        ua: req.headers['user-agent'] || '',
        extra: 'token 校验失败'
      });
      sendJson(res, 401, { code: 401, msg: 'invalid token' });
      return;
    }

    let body = {};
    if (method !== 'GET') {
      const text = await readBody(req);
      body = parseBody(text, req.headers['content-type']);
    }

    // 手机端配置的地址里带着 sharecode，顺手记下来用于生成后台链接
    if (query.sharecode && query.sharecode !== db.settings.shareCode) {
      db.settings.shareCode = String(query.sharecode);
      store.save('settings');
    }

    const flat = flattenInbound(body, query);

    try {
      const result = insertSms(flat, {
        ip: clientIp(req),
        ua: req.headers['user-agent'] || '',
        entryUrl: entryUrlFor(req, query.sharecode)
      });
      sendJson(res, 200, {
        code: 0,
        msg: 'ok',
        id: result.record.id,
        duplicate: result.duplicate,
        hasCode: Boolean(result.record.code)
      });
    } catch (err) {
      console.error('[webhook] 入库失败: ' + err.message);
      sendJson(res, 400, { code: 400, msg: err.message });
    }
    return;
  }

  /* ---------- 登录 ---------- */
  if (pathname === '/api/login' && method === 'POST') {
    const body = parseBody(await readBody(req), req.headers['content-type']);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    const ua = req.headers['user-agent'] || '';

    const key = limitKey(req, username);
    if (!loginAllowed(key)) {
      sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
      return;
    }

    const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !user.active || !authLib.verifyPassword(password, user.salt, user.hash)) {
      markLoginFail(key);
      audit({
        action: 'login_failed',
        username,
        ip,
        ua,
        extra: user ? '密码错误' : '账号不存在'
      });
      sendJson(res, 401, { error: '账号或密码错误' });
      return;
    }

    loginAttempts.delete(key);

    const token = authLib.signSession(
      { uid: user.id, exp: Date.now() + SESSION_TTL },
      db.settings.sessionSecret
    );
    const cookie = [
      COOKIE_NAME + '=' + encodeURIComponent(token),
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + Math.floor(SESSION_TTL / 1000)
    ];
    if (isSecure(req)) cookie.push('Secure');

    audit({ user, action: 'login', ip, ua });

    user.lastLoginAt = nowIso();
    store.save('users');

    sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'Set-Cookie': cookie.join('; ') });
    return;
  }

  /* ---------- 以下接口均需登录 ---------- */
  const user = currentUser(req);
  if (pathname.startsWith('/api/')) {
    if (!user) {
      sendJson(res, 401, { error: '未登录或登录已失效' });
      return;
    }

    const ip = clientIp(req);
    const ua = req.headers['user-agent'] || '';

    if (pathname === '/api/session-context' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const origin = String(body.origin || '').trim().replace(/\/+$/, '');
      const share = String(body.sharecode || '').trim();
      let changed = false;
      if (/^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?$/.test(origin) && origin !== db.settings.publicBase) {
        db.settings.publicBase = origin;
        changed = true;
      }
      if (share && share !== db.settings.shareCode) {
        db.settings.shareCode = share;
        changed = true;
      }
      if (changed) store.save('settings');
      sendJson(res, 200, { ok: true, publicBase: db.settings.publicBase, hasShare: Boolean(db.settings.shareCode) });
      return;
    }

    if (pathname === '/api/me' && method === 'GET') {
      sendJson(res, 200, {
        user: publicUser(user),
        settings: {
          siteName: db.settings.siteName,
          webhookToken: user.role === 'admin' ? db.settings.webhookToken : '',
          webhookUrl: user.role === 'admin'
            ? webhookUrlFor(req, url.searchParams.get('sharecode'))
            : ''
        }
      });
      return;
    }

    if (pathname === '/api/logout' && method === 'POST') {
      audit({ user, action: 'logout', ip, ua });
      sendJson(res, 200, { ok: true }, {
        'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
      });
      return;
    }

    if (pathname === '/api/sms' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const range = url.searchParams.get('range') || 'all';
      const onlyCode = url.searchParams.get('onlyCode') === '1';
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const size = Math.min(100, Math.max(5, parseInt(url.searchParams.get('size') || '20', 10) || 20));

      const today = todayKey();
      const cutoffMap = { today: 0, '7d': 6, '30d': 29 };
      let cutoff = '';
      if (Object.prototype.hasOwnProperty.call(cutoffMap, range)) {
        const d = new Date(Date.now() + TZ_OFFSET);
        d.setUTCDate(d.getUTCDate() - cutoffMap[range]);
        cutoff = d.toISOString().slice(0, 10);
      }

      const alive = db.sms.filter((item) => !item.deletedAt);

      let filtered = alive;
      if (q) {
        filtered = filtered.filter((item) =>
          (item.content || '').toLowerCase().includes(q) ||
          (item.phone || '').toLowerCase().includes(q) ||
          (item.code || '').toLowerCase().includes(q));
      }
      if (onlyCode) filtered = filtered.filter((item) => Boolean(item.code));
      if (cutoff) filtered = filtered.filter((item) => dayKey(item.receiveAt) >= cutoff);

      filtered = filtered.slice().sort((a, b) => new Date(b.receiveAt) - new Date(a.receiveAt));

      const total = filtered.length;
      const start = (page - 1) * size;
      const items = filtered.slice(start, start + size).map((item) => ({
        id: item.id,
        phone: item.phone,
        content: item.content,
        code: item.code,
        confidence: item.confidence,
        device: item.device,
        slot: item.slot,
        receiveAt: item.receiveAt,
        createdAt: item.createdAt
      }));

      sendJson(res, 200, {
        items,
        total,
        page,
        size,
        stats: {
          total: alive.length,
          today: alive.filter((item) => dayKey(item.receiveAt) === today).length,
          withCode: alive.filter((item) => Boolean(item.code)).length
        }
      });
      return;
    }

    if (pathname === '/api/sms/delete' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length) {
        sendJson(res, 400, { error: '请选择要删除的短信' });
        return;
      }
      let removed = 0;
      for (const item of db.sms) {
        if (!ids.includes(item.id) || item.deletedAt) continue;
        item.deletedAt = nowIso();
        item.deletedBy = user.username;
        removed += 1;
        audit({
          user, action: 'delete', smsId: item.id, phone: item.phone,
          code: item.code, content: item.content, ip, ua,
          extra: '删除短信'
        });
      }
      store.save('sms');
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    if (pathname === '/api/sms/recode' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const ids = Array.isArray(body.ids) && body.ids.length
        ? body.ids.map(String)
        : db.sms.filter((i) => !i.deletedAt).map((i) => i.id);
      let changed = 0;
      for (const item of db.sms) {
        if (!ids.includes(item.id)) continue;
        const parsed = extractCode(item.content, db.settings.codeRegex);
        if (parsed.code !== item.code) {
          item.code = parsed.code;
          item.confidence = parsed.confidence;
          changed += 1;
        }
      }
      store.save('sms');
      audit({ user, action: 'recode', ip, ua, extra: '重新识别验证码，更新 ' + changed + ' 条' });
      sendJson(res, 200, { ok: true, changed });
      return;
    }

    if (pathname === '/api/copy' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const smsId = String(body.smsId || '');
      const purpose = String(body.purpose || '').trim();
      if (purpose.length < 2) {
        sendJson(res, 400, { error: '请填写验证码用途（至少 2 个字）' });
        return;
      }
      const item = db.sms.find((s) => s.id === smsId && !s.deletedAt);
      if (!item) {
        sendJson(res, 404, { error: '短信不存在或已删除' });
        return;
      }
      if (!item.code) {
        sendJson(res, 400, { error: '这条短信没有识别出验证码' });
        return;
      }
      const rec = audit({
        user, action: 'copy', smsId: item.id, phone: item.phone,
        code: item.code, content: item.content, purpose, ip, ua,
        extra: '复制验证码'
      });
      sendJson(res, 200, { ok: true, code: item.code, auditId: rec.id });
      return;
    }

    if (pathname === '/api/audit' && method === 'GET') {
      const action = url.searchParams.get('action') || '';
      const username = url.searchParams.get('username') || '';
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const size = Math.min(200, Math.max(10, parseInt(url.searchParams.get('size') || '30', 10) || 30));

      const visible = user.role === 'admin'
        ? db.audit
        : db.audit.filter((r) => r.userId === user.id);
      let list = visible;
      if (action) list = list.filter((r) => r.action === action);
      if (username) list = list.filter((r) => r.username === username);
      if (from) list = list.filter((r) => dayKey(r.ts) >= from);
      if (to) list = list.filter((r) => dayKey(r.ts) <= to);
      if (q) {
        list = list.filter((r) =>
          (r.purpose || '').toLowerCase().includes(q) ||
          (r.content || '').toLowerCase().includes(q) ||
          (r.phone || '').toLowerCase().includes(q) ||
          (r.code || '').toLowerCase().includes(q) ||
          (r.username || '').toLowerCase().includes(q) ||
          (r.name || '').toLowerCase().includes(q));
      }

      list = list.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
      const total = list.length;

      if (url.searchParams.get('export') === '1') {
        const headers = ['时间', '操作人账号', '姓名', '操作', '相关号码', '验证码', '备注/用途', '短信内容', '来源IP', '浏览器'];
        const rows = list.slice(0, 20000).map((r) => [
          new Date(new Date(r.ts).getTime() + TZ_OFFSET).toISOString().replace('T', ' ').slice(0, 19),
          r.username, r.name, r.action, r.phone, r.code, r.purpose, r.content, r.ip, r.ua
        ]);
        const csv = '\uFEFF' + [headers].concat(rows)
          .map((row) => row.map((cell) => '"' + String(cell === undefined || cell === null ? '' : cell).replace(/"/g, '""') + '"').join(','))
          .join('\r\n');
        const buf = Buffer.from(csv, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="audit-' + todayKey() + '.csv"',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store'
        });
        res.end(buf);
        audit({ user, action: 'audit_export', ip, ua, extra: '导出审计日志 ' + rows.length + ' 条' });
        return;
      }

      const start = (page - 1) * size;

      const operators = Array.from(new Set(visible.map((r) => r.username).filter(Boolean))).sort();

      sendJson(res, 200, {
        items: list.slice(start, start + size),
        total,
        page,
        size,
        operators,
        actions: Array.from(new Set(visible.map((r) => r.action).filter(Boolean))).sort()
      });
      return;
    }

    /* ---------- 用户管理（仅管理员） ---------- */
    if (pathname === '/api/users' && method === 'GET') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可查看' });
        return;
      }
      sendJson(res, 200, { items: db.users.map(publicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
      return;
    }

    if (pathname === '/api/users' && method === 'POST') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可操作' });
        return;
      }
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const username = String(body.username || '').trim();
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'staff';

      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
        sendJson(res, 400, { error: '账号需为 3-32 位字母、数字或 _ . -' });
        return;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: '密码至少 8 位' });
        return;
      }
      if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        sendJson(res, 409, { error: '该账号已存在' });
        return;
      }

      const { salt, hash } = authLib.hashPassword(password);
      const record = {
        id: store.newId('u'),
        username,
        name: name || username,
        role,
        salt,
        hash,
        active: true,
        mustChangePassword: true,
        createdAt: nowIso(),
        lastLoginAt: ''
      };
      db.users.push(record);
      store.save('users');
      audit({ user, action: 'user_create', ip, ua, extra: '新建账号 ' + username + '（' + role + '）' });
      sendJson(res, 200, { ok: true, user: publicUser(record) });
      return;
    }

    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可操作' });
        return;
      }
      const target = db.users.find((u) => u.id === userMatch[1]);
      if (!target) {
        sendJson(res, 404, { error: '账号不存在' });
        return;
      }
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const notes = [];

      if (typeof body.name === 'string' && body.name.trim()) {
        target.name = body.name.trim();
        notes.push('姓名');
      }
      if (body.role === 'admin' || body.role === 'staff') {
        if (target.id === user.id && body.role !== 'admin') {
          sendJson(res, 400, { error: '不能取消自己的管理员权限' });
          return;
        }
        target.role = body.role;
        notes.push('角色→' + body.role);
      }
      if (typeof body.active === 'boolean') {
        if (target.id === user.id && !body.active) {
          sendJson(res, 400, { error: '不能停用自己的账号' });
          return;
        }
        target.active = body.active;
        notes.push(body.active ? '启用' : '停用');
      }
      if (typeof body.password === 'string' && body.password) {
        if (body.password.length < 8) {
          sendJson(res, 400, { error: '密码至少 8 位' });
          return;
        }
        const { salt, hash } = authLib.hashPassword(body.password);
        target.salt = salt;
        target.hash = hash;
        target.mustChangePassword = false;
        notes.push('重置密码');
      }

      store.save('users');
      audit({
        user, action: 'user_update', ip, ua,
        extra: '更新账号 ' + target.username + '：' + (notes.join('、') || '无变更')
      });
      sendJson(res, 200, { ok: true, user: publicUser(target) });
      return;
    }

    /* ---------- 修改自己的密码 ---------- */
    if (pathname === '/api/password' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!authLib.verifyPassword(oldPassword, user.salt, user.hash)) {
        sendJson(res, 400, { error: '当前密码不正确' });
        return;
      }
      if (newPassword.length < 8) {
        sendJson(res, 400, { error: '新密码至少 8 位' });
        return;
      }
      const { salt, hash } = authLib.hashPassword(newPassword);
      user.salt = salt;
      user.hash = hash;
      user.mustChangePassword = false;
      store.save('users');
      audit({ user, action: 'password_change', ip, ua, extra: '修改自己的密码' });
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- 系统设置 ---------- */
    if (pathname === '/api/settings' && method === 'GET') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可查看' });
        return;
      }
      sendJson(res, 200, {
        settings: {
          siteName: db.settings.siteName,
          webhookToken: db.settings.webhookToken,
          webhookUrl: webhookUrlFor(req, url.searchParams.get('sharecode')),
          codeRegex: db.settings.codeRegex,
          feishu: db.settings.feishu
        }
      });
      return;
    }

    if (pathname === '/api/settings' && method === 'PUT') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可操作' });
        return;
      }
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const notes = [];

      if (typeof body.siteName === 'string' && body.siteName.trim()) {
        db.settings.siteName = body.siteName.trim().slice(0, 40);
        notes.push('站点名称');
      }
      if (typeof body.codeRegex === 'string') {
        const pattern = body.codeRegex.trim();
        if (pattern) {
          try {
            new RegExp(pattern);
          } catch (err) {
            sendJson(res, 400, { error: '自定义正则不合法：' + err.message });
            return;
          }
        }
        db.settings.codeRegex = pattern;
        notes.push('识别规则');
      }
      if (body.feishu && typeof body.feishu === 'object') {
        const f = body.feishu;
        if (typeof f.enabled === 'boolean') db.settings.feishu.enabled = f.enabled;
        if (typeof f.url === 'string') db.settings.feishu.url = f.url.trim();
        if (typeof f.secret === 'string') db.settings.feishu.secret = f.secret.trim();
        if (typeof f.includeCode === 'boolean') db.settings.feishu.includeCode = f.includeCode;
        if (typeof f.includeContent === 'boolean') db.settings.feishu.includeContent = f.includeContent;
        notes.push('飞书推送');
      }
      if (body.regenerateToken === true) {
        db.settings.webhookToken = require('crypto').randomBytes(16).toString('hex');
        notes.push('重置 Webhook Token');
      }

      store.save('settings');
      audit({ user, action: 'settings_update', ip, ua, extra: '更新设置：' + (notes.join('、') || '无变更') });
      sendJson(res, 200, {
        ok: true,
        settings: {
          siteName: db.settings.siteName,
          webhookToken: db.settings.webhookToken,
          webhookUrl: webhookUrlFor(req, url.searchParams.get('sharecode')),
          codeRegex: db.settings.codeRegex,
          feishu: db.settings.feishu
        }
      });
      return;
    }

    if (pathname === '/api/settings/feishu-test' && method === 'POST') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '仅管理员可操作' });
        return;
      }
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const target = {
        enabled: true,
        url: String(body.url || db.settings.feishu.url || '').trim(),
        secret: String(body.secret !== undefined ? body.secret : db.settings.feishu.secret || '').trim(),
        includeCode: true,
        includeContent: true
      };
      if (!target.url) {
        sendJson(res, 400, { error: '请先填写飞书机器人 Webhook 地址' });
        return;
      }
      try {
        await feishu.sendTest(target, entryUrlFor(req, url.searchParams.get('sharecode')));
        audit({ user, action: 'feishu_test', ip, ua, extra: '发送飞书测试消息成功' });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        audit({ user, action: 'feishu_test', ip, ua, extra: '发送飞书测试消息失败：' + err.message });
        sendJson(res, 400, { error: '发送失败：' + err.message });
      }
      return;
    }

    if (pathname === '/api/webhook/test' && method === 'POST') {
      const sample = {
        from: '10086',
        content: '【联调测试】您的验证码为 246810，5分钟内有效，请勿泄露。',
        receive_time: new Date(Date.now() + TZ_OFFSET).toISOString().replace('T', ' ').slice(0, 19),
        device_mark: '测试设备'
      };
      const result = insertSms(sample, { ip, ua, entryUrl: entryUrlFor(req, url.searchParams.get('sharecode')) });
      audit({ user, action: 'webhook_test', ip, ua, extra: '插入一条测试短信' });
      sendJson(res, 200, { ok: true, id: result.record.id, duplicate: result.duplicate });
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[server] ' + (err && err.stack ? err.stack : err));
    if (!res.headersSent) {
      sendJson(res, 500, { error: '服务器内部错误：' + (err && err.message ? err.message : '未知错误') });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('[server] 短信管理后台已启动: http://' + HOST + ':' + PORT);
  console.log('[server] 数据目录: ' + store.DATA_DIR);
});
