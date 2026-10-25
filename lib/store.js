'use strict';

/**
 * 极简 JSON 文件存储。
 * 部署沙箱只提供单个 HTTP 端口（无外部数据库），因此数据落盘在同目录 data/ 下。
 * 写入采用 write-tmp + rename 的原子方式，避免进程中断写出半截文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * 数据目录优先级：
 * 1. SMS_DATA_DIR 环境变量（便于本地测试隔离）
 * 2. 用户主目录下的 .sms-console —— 放在项目目录之外，
 *    重新发布（源码会被整包覆盖）时不会把历史短信与审计记录冲掉
 * 3. 项目内 data/ 兜底（主目录不可写时）
 */
function resolveDataDir() {
  if (process.env.SMS_DATA_DIR) return path.resolve(process.env.SMS_DATA_DIR);
  const candidates = [
    path.join(os.homedir(), '.sms-console'),
    path.join(__dirname, '..', 'data')
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (err) {
      // 试下一个
    }
  }
  return candidates[candidates.length - 1];
}

const DATA_DIR = resolveDataDir();

const cache = new Map();

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function load(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  let value = fallback;
  try {
    const txt = fs.readFileSync(filePath(name), 'utf8');
    if (txt && txt.trim()) value = JSON.parse(txt);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] 读取失败 ' + name + ': ' + err.message);
    }
  }
  cache.set(name, value);
  return value;
}

function save(name) {
  if (!cache.has(name)) return;
  ensureDir();
  const target = filePath(name);
  const tmp = target + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache.get(name)), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[store] 写入失败 ' + name + ': ' + err.message);
  }
}

/** 短、可排序、无碰撞风险的业务 ID */
function newId(prefix) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return (prefix ? prefix + '_' : '') + ts + rand;
}

const DEFAULT_SETTINGS = {
  siteName: '短信验证码管理平台',
  webhookToken: '',
  shareCode: '',
  publicBase: '',
  sessionSecret: '',
  codeRegex: '',
  retentionDays: 0,
  feishu: {
    enabled: false,
    url: '',
    secret: '',
    includeCode: true,
    includeContent: true
  },
  createdAt: ''
};

function init() {
  ensureDir();
  load('sms', []);
  load('audit', []);
  load('users', []);

  const settings = load('settings', {});
  let dirty = false;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[key] === undefined) {
      settings[key] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]));
      dirty = true;
    }
  }
  if (!settings.webhookToken) {
    settings.webhookToken = crypto.randomBytes(16).toString('hex');
    dirty = true;
  }
  if (!settings.sessionSecret) {
    settings.sessionSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (!settings.createdAt) {
    settings.createdAt = new Date().toISOString();
    dirty = true;
  }
  if (dirty) save('settings');

  return {
    sms: cache.get('sms'),
    audit: cache.get('audit'),
    users: cache.get('users'),
    settings
  };
}

module.exports = {
  DATA_DIR,
  init,
  load,
  save,
  newId,
  get sms() { return load('sms', []); },
  get audit() { return load('audit', []); },
  get users() { return load('users', []); },
  get settings() { return load('settings', {}); }
};
