'use strict';

/**
 * 短信验证码提取。
 *
 * 思路：不做单一正则硬匹配，而是先抓出所有「4~8 位数字」候选，
 * 再根据上下文（是否紧邻"验证码/校验码/OTP"等关键词、是否紧邻"尾号/余额/订单"等干扰词、
 * 数字长度、前后标点）给每个候选打分，取分数最高者。
 *
 * 这样可以覆盖国内各类短信写法：
 *   您的验证码为 123456，5分钟内有效
 *   【京东】验证码：5678。请勿泄露
 *   123456 是您的登录验证码
 *   Your verification code is 654321
 *   动态密码 A1B2C3，请勿转发
 */

// 强关键词（出现即几乎可以确定是验证码）
const STRONG_KEYWORDS = [
  '验证码', '校验码', '确认码', '动态码', '动态密码', '激活码', '授权码',
  '安全码', '登录码', '短信密码', '一次性密码', '提取码', '取件码', '识别码',
  '验证代码', '动态验证码', '短信验证码'
];

// 弱关键词（需要配合位置判断）
const WEAK_KEYWORDS = ['口令', '密码', 'code', 'pin', 'otp', 'passcode'];

// 干扰关键词：出现说明这个数字大概率不是验证码
const NEGATIVE_KEYWORDS = [
  '尾号', '卡号', '账号', '帐号', '账户', '订单号', '订单', '单号', '编号', '工号',
  '手机号', '手机', '电话', '热线', '号码', '来电', '金额', '余额', '积分', '流量',
  '剩余', '可用', '消费', '扣款', '还款', '账单', '到期', '缴费', '楼层', '房间',
  '房号', '座位', '单笔', '满', '立减', '优惠', '元'
];

const EN_KEYWORD_RE = /(verification\s*code|verify\s*code|security\s*code|one[\s-]?time\s*(?:code|password|pin)|passcode|otp|code)/i;

const SUFFIX_CODE_RE = /^\s*(?:是|为)?\s*(?:您的|你的|您)?\s*(?:登录|注册|付款|支付|动态|短信)?\s*(?:验证码|校验码|动态码|动态密码|确认码|安全码|登录码|口令)/;

const BAD_TAIL_CHARS = '年月日号时分秒元折%℃米克升';

function normalize(raw) {
  return String(raw == null ? '' : raw)
    // 全角数字 -> 半角
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 全角冒号/括号统一，便于上下文判断
    .replace(/[\uFF1A]/g, ':')
    // 零宽字符、BOM
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 不换行空格
    .replace(/[\u00A0\u3000]/g, ' ')
    .trim();
}

function nearestKeyword(before) {
  let best = null;
  const lower = before.toLowerCase();

  for (const kw of STRONG_KEYWORDS) {
    let idx = before.lastIndexOf(kw);
    while (idx !== -1) {
      const distance = before.length - (idx + kw.length);
      if (!best || distance < best.distance) best = { word: kw, distance, strong: true };
      break;
    }
  }

  for (const kw of WEAK_KEYWORDS) {
    const idx = lower.lastIndexOf(kw.toLowerCase());
    if (idx !== -1) {
      const distance = lower.length - (idx + kw.length);
      if (!best || distance < best.distance) best = { word: kw, distance, strong: false };
    }
  }

  if (EN_KEYWORD_RE.test(before)) {
    const m = before.match(EN_KEYWORD_RE);
    if (m) {
      const idx = before.toLowerCase().lastIndexOf(m[0].toLowerCase());
      if (idx !== -1) {
        const distance = before.length - (idx + m[0].length);
        if (!best || distance < best.distance) best = { word: m[0], distance, strong: true };
      }
    }
  }

  return best;
}

function nearestNegative(before) {
  let best = null;
  for (const kw of NEGATIVE_KEYWORDS) {
    const idx = before.lastIndexOf(kw);
    if (idx !== -1) {
      const distance = before.length - (idx + kw.length);
      if (!best || distance < best.distance) best = { word: kw, distance };
    }
  }
  return best;
}

function lengthBonus(value) {
  const map = { 4: 6, 5: 8, 6: 14, 7: 6, 8: 5 };
  return map[value.length] || 0;
}

function isDateOrAmount(value, prevChar, nextChar, before, after) {
  if (BAD_TAIL_CHARS.includes(nextChar)) return true;
  if ('¥￥$'.includes(prevChar)) return true;
  if (/^\s*(?:元|块|折|%|分钟|分|秒|小时|天|个月|年|个工作日)/.test(after)) return true;
  // 时间 12:30 / 11:23:45
  if (value.length <= 4 && /^\s*:\s*\d{2}/.test(after)) return true;
  // 日期 2026-10-25 / 2026/10/25 / 2026.10.25
  if (/^\s*[-/.]\s*\d{1,2}(\s*[-/.]\s*\d{1,2})?/.test(after) && value.length === 4) return true;
  if (/[-/.]$/.test(before) && /^\s*[-/.]/.test(after)) return true;
  // 常见年份
  if (value.length === 4 && /^(19|20)\d{2}$/.test(value) && /年/.test(after)) return true;
  return false;
}

function scoreCandidate(value, before, after) {
  let score = 0;

  const kw = nearestKeyword(before);
  if (kw) {
    score += (kw.strong ? 100 : 45) - Math.min(kw.distance, 24);
  }

  // "验证码为：123456" / "code is 123456"
  if (/(?:是|为|is|:)\s*[:：]?\s*$/i.test(before)) score += 22;

  // "123456 是您的验证码"
  if (SUFFIX_CODE_RE.test(after)) score += 80;

  const neg = nearestNegative(before);
  if (neg && (!kw || neg.distance < kw.distance)) {
    score -= 95 + Math.min(neg.distance, 20);
  }

  score += lengthBonus(value);
  return score;
}

function extractLettersDigits(content) {
  const results = [];
  const re = /(?<![A-Za-z0-9])([A-Z0-9]{4,8})(?![A-Za-z0-9])/g;
  let m;
  while ((m = re.exec(content))) {
    const value = m[1];
    if (/^\d+$/.test(value)) continue; // 纯数字已在上面处理
    if (!/\d/.test(value) || !/[A-Z]/.test(value)) continue;
    const before = content.slice(Math.max(0, m.index - 24), m.index);
    const kw = nearestKeyword(before);
    if (!kw) continue;
    results.push({ code: value, score: (kw.strong ? 100 : 45) - Math.min(kw.distance, 24) + 10 });
  }
  return results;
}

/**
 * @param {string} raw 短信原文
 * @param {string} [customRegex] 后台可配置的自定义正则（第 1 个分组优先）
 * @returns {{code: string, confidence: 'high'|'low'|'custom'|'none', candidates: number}}
 */
function extractCode(raw, customRegex) {
  const content = normalize(raw);
  if (!content) return { code: '', confidence: 'none', candidates: 0 };

  if (customRegex) {
    try {
      const re = new RegExp(customRegex, 'i');
      const m = re.exec(content);
      if (m) {
        const value = String(m[1] != null ? m[1] : m[0]).trim();
        if (value) return { code: value, confidence: 'custom', candidates: 1 };
      }
    } catch (err) {
      // 自定义正则非法时静默回落到内置规则
    }
  }

  const candidates = [];
  const digitRe = /\d{4,8}/g;
  let m;
  while ((m = digitRe.exec(content))) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    const prevChar = content[start - 1] || '';
    const nextChar = content[end] || '';
    if (/\d/.test(prevChar) || /\d/.test(nextChar)) continue;

    const before = content.slice(Math.max(0, start - 26), start);
    const after = content.slice(end, end + 16);
    if (isDateOrAmount(value, prevChar, nextChar, before, after)) continue;

    candidates.push({ code: value, score: scoreCandidate(value, before, after) });
  }

  candidates.push(...extractLettersDigits(content));

  if (!candidates.length) return { code: '', confidence: 'none', candidates: 0 };

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best.score > 30) {
    return { code: best.code, confidence: 'high', candidates: candidates.length };
  }

  // 没有关键词命中时的兜底：短信很短且只有一个数字候选，才认为是验证码
  if (candidates.length === 1 && content.length <= 60) {
    return { code: best.code, confidence: 'low', candidates: 1 };
  }

  return { code: '', confidence: 'none', candidates: candidates.length };
}

module.exports = { extractCode, normalize };
