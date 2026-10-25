'use strict';

const crypto = require('crypto');

/**
 * 飞书自定义群机器人推送。
 * 文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * 开启"签名校验"时，sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, data = ""))
 */

function sign(secret, timestamp) {
  return crypto
    .createHmac('sha256', String(timestamp) + '\n' + secret)
    .update('')
    .digest('base64');
}

function buildCard(sms, options) {
  const showCode = options.includeCode !== false && sms.code;
  const showContent = options.includeContent !== false;

  const elements = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: '**来源号码**\n' + (sms.phone || '未知') } },
        { is_short: true, text: { tag: 'lark_md', content: '**接收时间**\n' + (sms.receiveTimeText || '-') } }
      ]
    }
  ];

  if (showCode) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**验证码**\n`' + sms.code + '`' }
    });
  }

  if (showContent) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: sms.content || '' }
    });
  }

  if (options.entryUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开短信管理后台' },
          type: 'primary',
          url: options.entryUrl
        }
      ]
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: sms.code ? 'blue' : 'grey',
      title: { tag: 'plain_text', content: sms.code ? '收到一条新验证码短信' : '收到一条新短信' }
    },
    elements
  };
}

async function post(url, payload) {
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) { data = null; }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));
    if (data) {
      const code = data.code !== undefined ? data.code : (data.StatusCode !== undefined ? data.StatusCode : 0);
      if (Number(code) !== 0) {
        throw new Error((data.msg || data.StatusMessage || '飞书返回错误') + ' (code=' + code + ')');
      }
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function sendSms(sms, feishu, entryUrl) {
  if (!feishu || !feishu.enabled) return { skipped: true };
  if (!feishu.url) throw new Error('未配置飞书机器人 Webhook 地址');

  const payload = {
    msg_type: 'interactive',
    card: buildCard(sms, { includeCode: feishu.includeCode, includeContent: feishu.includeContent, entryUrl })
  };

  if (feishu.secret) {
    const ts = Math.floor(Date.now() / 1000);
    payload.timestamp = String(ts);
    payload.sign = sign(feishu.secret, ts);
  }

  await post(feishu.url, payload);
  return { skipped: false };
}

async function sendTest(feishu, entryUrl) {
  const sample = {
    phone: '138****0000',
    code: '123456',
    content: '【测试】这是一条来自短信管理后台的测试消息，收到即代表飞书推送配置成功。',
    receiveTimeText: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  };
  const payload = {
    msg_type: 'interactive',
    card: buildCard(sample, { includeCode: true, includeContent: true, entryUrl })
  };
  if (feishu.secret) {
    const ts = Math.floor(Date.now() / 1000);
    payload.timestamp = String(ts);
    payload.sign = sign(feishu.secret, ts);
  }
  await post(feishu.url, payload);
  return true;
}

module.exports = { sendSms, sendTest };
