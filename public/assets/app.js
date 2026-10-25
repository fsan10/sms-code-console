'use strict';

(function () {
  /* ============================== 状态 ============================== */

  var state = {
    user: null,
    view: 'sms',
    sms: {
      items: [], total: 0, page: 1, size: 20,
      q: '', range: 'all', onlyCode: false,
      stats: { total: 0, today: 0, withCode: 0 }
    },
    audit: {
      items: [], total: 0, page: 1, size: 30,
      q: '', action: '', username: '', from: '', to: '',
      operators: [], actions: []
    },
    users: [],
    settings: null,
    expanded: {}
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* 分享链接带的 sharecode 必须跟着每个请求走，否则平台网关会返回 403 */
  var SHARE = (new URLSearchParams(location.search)).get('sharecode') || sessionStorage.getItem('sms_share') || '';
  if (SHARE) sessionStorage.setItem('sms_share', SHARE);

  function withShare(url) {
    if (!SHARE) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'sharecode=' + encodeURIComponent(SHARE);
  }

  /* ============================== 工具 ============================== */

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var DTF = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  function dateParts(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    var out = {};
    DTF.formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }

  function fmtDateTime(iso) {
    var p = dateParts(iso);
    if (!p) return '-';
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }

  function fmtClock(iso) {
    var p = dateParts(iso);
    if (!p) return '-';
    return p.hour + ':' + p.minute;
  }

  function fmtDay(iso) {
    var p = dateParts(iso);
    if (!p) return '-';
    var key = p.year + '-' + p.month + '-' + p.day;
    var now = dateParts(new Date().toISOString());
    var today = now.year + '-' + now.month + '-' + now.day;
    var y = new Date(Date.now() - 86400000).toISOString();
    var yp = dateParts(y);
    var yest = yp.year + '-' + yp.month + '-' + yp.day;
    if (key === today) return '今天';
    if (key === yest) return '昨天';
    return p.month + '-' + p.day;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function toast(message, type) {
    var wrap = $('#toastWrap');
    var el = document.createElement('div');
    el.className = 'toast ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : type === 'warn' ? 'warn' : '');
    el.textContent = message;
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 220);
    }, type === 'err' ? 4200 : 2600);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(String(text)).then(function () { return true; }).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = String(text);
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    };
    if (opts.body !== undefined) init.body = opts.body;
    return fetch(withShare(path), init).then(function (res) {
      if (res.status === 401) {
        location.replace(withShare('/'));
        throw new Error('登录已失效');
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
        return data;
      });
    });
  }

  /* ============================== 弹窗 ============================== */

  function openModal(opts) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="max-width:' + (opts.width || 440) + 'px">' +
        '<div class="modal-head"><h3>' + escapeHtml(opts.title || '') + '</h3>' +
        '<button class="modal-close" aria-label="关闭">&times;</button></div>' +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        '<div class="modal-foot">' + (opts.footer || '') + '</div>' +
      '</div>';
    document.body.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add('show'); });

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('show');
      setTimeout(function () { mask.remove(); }, 180);
      document.removeEventListener('keydown', onKey);
      if (typeof opts.onClose === 'function') opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    document.addEventListener('keydown', onKey);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    $('.modal-close', mask).addEventListener('click', close);

    return { mask: mask, close: close, body: $('.modal-body', mask), foot: $('.modal-foot', mask) };
  }

  function confirmModal(title, text, confirmLabel) {
    return new Promise(function (resolve) {
      var m = openModal({
        title: title,
        width: 420,
        body: '<p style="margin:0 0 4px;color:#46536b;font-size:13.5px;line-height:1.8;word-break:break-all">' +
          escapeHtml(text) + '</p>',
        footer: '<button class="btn btn-ghost" data-act="cancel">取消</button>' +
          '<button class="btn btn-danger" data-act="ok">' + escapeHtml(confirmLabel || '确认删除') + '</button>',
        onClose: function () { resolve(false); }
      });
      $('[data-act="cancel"]', m.foot).onclick = function () { m.close(); };
      $('[data-act="ok"]', m.foot).onclick = function () { resolve(true); m.close(); };
    });
  }

  var PURPOSE_CHIPS = ['客户注册', '客户登录', '后台登录', '账号绑定', '支付验证', '内部测试'];

  function purposeModal(sms) {
    return new Promise(function (resolve) {
      var body =
        '<div class="modal-code">' +
          '<div class="lbl">即将复制的验证码</div>' +
          '<div class="val">' + escapeHtml(sms.code) + '</div>' +
          '<div class="meta">' + escapeHtml(sms.phone) + ' · ' + fmtDateTime(sms.receiveAt) + '</div>' +
        '</div>' +
        '<p class="sms-quote">' + escapeHtml(sms.content) + '</p>' +
        '<div class="field">' +
          '<label>验证码用途 <span style="color:#dd4545">*</span>（必填，会记入审计日志）</label>' +
          '<textarea class="textarea" id="purposeInput" maxlength="200" ' +
            'placeholder="例如：帮客户张先生注册商城账号"></textarea>' +
          '<div class="chip-row">' +
            PURPOSE_CHIPS.map(function (c) {
              return '<button type="button" class="chip" data-chip="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="err-text" id="purposeErr"></div>' +
        '</div>';

      var m = openModal({
        title: '复制验证码前请填写用途',
        width: 470,
        body: body,
        footer: '<button class="btn btn-ghost" data-act="cancel">取消</button>' +
          '<button class="btn btn-primary" data-act="ok">确认并复制</button>',
        onClose: function () { resolve(null); }
      });

      var input = $('#purposeInput', m.body);
      var err = $('#purposeErr', m.body);
      setTimeout(function () { input.focus(); }, 60);

      $$('.chip', m.body).forEach(function (chip) {
        chip.onclick = function () {
          var text = chip.getAttribute('data-chip');
          input.value = input.value.trim() ? input.value.trim() + ' - ' + text : text;
          input.focus();
        };
      });

      function submit() {
        var value = input.value.trim();
        if (value.length < 2) {
          err.textContent = '请填写验证码用途（至少 2 个字），否则无法复制';
          input.focus();
          return;
        }
        resolve(value);
        m.close();
      }

      $('[data-act="cancel"]', m.foot).onclick = function () { m.close(); };
      $('[data-act="ok"]', m.foot).onclick = submit;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      });
    });
  }

  /* ============================== 顶栏 / 导航 ============================== */

  var VIEW_META = {
    sms: { title: '短信列表', sub: '手机端转发的验证码短信都会实时出现在这里' },
    audit: { title: '操作审计', sub: '谁在什么时间进入后台、复制了哪条短信、用途是什么，全部留档' },
    users: { title: '成员管理', sub: '为同事分配账号，默认只能查看与复制，不具备管理权限' },
    settings: { title: '系统设置', sub: '手机端接入配置、飞书推送、验证码识别规则' }
  };

  function renderChrome() {
    var user = state.user;
    if (!user) return;
    $('#avatar').textContent = (user.name || user.username || '?').slice(0, 1).toUpperCase();
    $('#userName').textContent = user.name || user.username;
    $('#userRole').textContent = user.role === 'admin' ? '管理员' : '成员';

    $$('.admin-only').forEach(function (el) {
      el.classList.toggle('hidden', user.role !== 'admin');
    });

    var meta = VIEW_META[state.view] || VIEW_META.sms;
    $('#pageTitle').textContent = meta.title;
    $('#pageSub').textContent = meta.sub;
  }

  function setView(view, skipHash) {
    if (state.view === view) {
      renderChrome();
      renderView();
      return;
    }
    state.view = view;
    if (!skipHash) {
      try {
        history.replaceState(null, '', location.pathname + location.search + '#' + view);
      } catch (e) { /* ignore */ }
    }
    $$('.nav-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });
    renderChrome();
    renderView();
  }

  function renderTopbarActions() {
    var box = $('#topbarActions');
    var user = state.user;
    if (!user) return;
    if (state.view === 'sms') {
      box.innerHTML = '<button class="btn btn-ghost btn-sm" id="btnRefresh">刷新</button>' +
        (user.role === 'admin' ? '<button class="btn btn-soft btn-sm" id="btnGoSettings">手机端接入</button>' : '');
      $('#btnRefresh').onclick = function () { loadSms(); toast('已刷新'); };
      if ($('#btnGoSettings')) $('#btnGoSettings').onclick = function () { setView('settings'); };
    } else if (state.view === 'users') {
      box.innerHTML = '<button class="btn btn-primary btn-sm" id="btnNewUser">新增成员</button>';
      $('#btnNewUser').onclick = openUserModal;
    } else if (state.view === 'audit') {
      box.innerHTML = '<button class="btn btn-ghost btn-sm" id="btnAuditExport">导出 CSV</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnAuditRefresh">刷新</button>';
      $('#btnAuditRefresh').onclick = function () { loadAudit(); };
      $('#btnAuditExport').onclick = function () {
        var a = state.audit;
        var qs = '/api/audit?export=1' +
          '&action=' + encodeURIComponent(a.action) +
          '&username=' + encodeURIComponent(a.username) +
          '&q=' + encodeURIComponent(a.q) +
          '&from=' + encodeURIComponent(a.from) +
          '&to=' + encodeURIComponent(a.to);
        var link = document.createElement('a');
        link.href = withShare(qs);
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast('正在导出当前筛选条件下的审计记录', 'ok');
      };
    } else {
      box.innerHTML = '';
    }
  }

  function renderView() {
    renderTopbarActions();
    if (state.view === 'sms') renderSmsShell();
    else if (state.view === 'audit') renderAuditShell();
    else if (state.view === 'users') renderUsersShell();
    else if (state.view === 'settings') renderSettingsShell();
  }

  /* ============================== 短信列表 ============================== */

  function renderSmsShell() {
    var s = state.sms;
    $('#view').innerHTML =
      (state.user.mustChangePassword
        ? '<div class="banner"><span>你正在使用初始密码，建议立即修改。</span><span class="spacer"></span>' +
          '<button class="btn btn-ghost btn-sm" id="bannerPwd">去修改</button></div>'
        : '') +
      '<div class="stats">' +
        '<div class="stat"><div class="label">今日收到</div><div class="value" id="statToday">—</div></div>' +
        '<div class="stat"><div class="label">累计短信</div><div class="value" id="statTotal">—</div></div>' +
        '<div class="stat"><div class="label">含验证码</div><div class="value" id="statCode">—</div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="search-box">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
            '<input class="input" id="smsSearch" placeholder="搜索短信内容 / 号码 / 验证码" value="' + escapeHtml(s.q) + '">' +
          '</div>' +
          '<select class="select select-sm" id="smsRange">' +
            '<option value="all">全部时间</option>' +
            '<option value="today">今天</option>' +
            '<option value="7d">近 7 天</option>' +
            '<option value="30d">近 30 天</option>' +
          '</select>' +
          '<label class="check"><input type="checkbox" id="smsOnlyCode"> 仅看有验证码</label>' +
          '<div class="spacer"></div>' +
          '<span class="muted" id="smsUpdated" style="font-size:12px"></span>' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="grid">' +
            '<thead><tr>' +
              '<th style="width:96px">时间</th>' +
              '<th style="width:130px">来源</th>' +
              '<th>短信内容</th>' +
              '<th style="width:170px">验证码</th>' +
              '<th style="width:150px;text-align:right">操作</th>' +
            '</tr></thead>' +
            '<tbody id="smsBody"></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="pager">' +
          '<span id="smsCount"></span>' +
          '<div class="pager-actions">' +
            '<button class="btn btn-ghost btn-sm" id="smsPrev">上一页</button>' +
            '<button class="btn btn-ghost btn-sm" id="smsNext">下一页</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    if ($('#bannerPwd')) $('#bannerPwd').onclick = openPasswordModal;

    $('#smsRange').value = s.range;
    $('#smsOnlyCode').checked = s.onlyCode;

    $('#smsSearch').addEventListener('input', debounce(function (e) {
      state.sms.q = e.target.value.trim();
      state.sms.page = 1;
      loadSms();
    }, 320));

    $('#smsRange').addEventListener('change', function (e) {
      state.sms.range = e.target.value;
      state.sms.page = 1;
      loadSms();
    });

    $('#smsOnlyCode').addEventListener('change', function (e) {
      state.sms.onlyCode = e.target.checked;
      state.sms.page = 1;
      loadSms();
    });

    $('#smsPrev').onclick = function () {
      if (state.sms.page > 1) { state.sms.page -= 1; loadSms(); }
    };
    $('#smsNext').onclick = function () {
      var maxPage = Math.max(1, Math.ceil(state.sms.total / state.sms.size));
      if (state.sms.page < maxPage) { state.sms.page += 1; loadSms(); }
    };

    $('#smsBody').addEventListener('click', function (e) {
      var copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) { beginCopy(copyBtn.getAttribute('data-copy')); return; }
      var delBtn = e.target.closest('[data-del]');
      if (delBtn) { beginDelete(delBtn.getAttribute('data-del')); return; }
      var expandBtn = e.target.closest('[data-expand]');
      if (expandBtn) {
        var id = expandBtn.getAttribute('data-expand');
        state.expanded[id] = !state.expanded[id];
        renderSmsTable();
      }
    });

    loadSms();
  }

  function renderSmsTable() {
    var s = state.sms;
    var body = $('#smsBody');
    if (!body) return;

    if (!s.items.length) {
      body.innerHTML = '<tr><td colspan="5">' +
        '<div class="empty"><div class="ico">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>' +
        '</div><h3>' + (s.q || s.onlyCode || s.range !== 'all' ? '没有匹配的短信' : '还没有收到短信') + '</h3>' +
        '<p>' + (s.q || s.onlyCode || s.range !== 'all' ? '换个搜索条件试试' : '在手机端配置好 Webhook 后，转发的短信会出现在这里') + '</p></div>' +
        '</td></tr>';
    } else {
      body.innerHTML = s.items.map(function (item) {
        var expanded = Boolean(state.expanded[item.id]);
        var codeCell;
        if (item.code) {
          codeCell = '<button class="code-pill" data-copy="' + item.id + '" title="点击复制">' +
            escapeHtml(item.code) +
            '<svg class="copy-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
            '</button>' +
            (item.confidence === 'low' ? '<span class="code-low">低置信度，请核对</span>' : '');
        } else {
          codeCell = '<span class="code-none">未识别</span>';
        }

        return '<tr data-id="' + item.id + '">' +
          '<td class="col-time"><div class="t">' + fmtClock(item.receiveAt) + '</div>' +
            '<div class="d">' + fmtDay(item.receiveAt) + '</div></td>' +
          '<td><span class="phone">' + escapeHtml(item.phone) + '</span>' +
            (item.device ? '<span class="device">' + escapeHtml(item.device) + '</span>' : '') + '</td>' +
          '<td><div class="sms-text' + (expanded ? ' open' : '') + '">' + escapeHtml(item.content) + '</div>' +
            '<button class="link-btn" data-expand="' + item.id + '">' + (expanded ? '收起' : '展开全文') + '</button></td>' +
          '<td>' + codeCell + '</td>' +
          '<td><div class="row-actions">' +
            (item.code
              ? '<button class="btn btn-soft btn-sm" data-copy="' + item.id + '">复制验证码</button>'
              : '') +
            '<button class="btn btn-danger btn-sm" data-del="' + item.id + '">删除</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    $('#statToday').textContent = s.stats.today;
    $('#statTotal').textContent = s.stats.total;
    $('#statCode').textContent = s.stats.withCode;

    var maxPage = Math.max(1, Math.ceil(s.total / s.size));
    $('#smsCount').textContent = s.total
      ? '共 ' + s.total + ' 条 · 第 ' + s.page + ' / ' + maxPage + ' 页'
      : '共 0 条';
    $('#smsPrev').disabled = s.page <= 1;
    $('#smsNext').disabled = s.page >= maxPage;
    $('#smsUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function loadSms() {
    var s = state.sms;
    var qs = '/api/sms?page=' + s.page + '&size=' + s.size +
      '&q=' + encodeURIComponent(s.q) +
      '&range=' + encodeURIComponent(s.range) +
      '&onlyCode=' + (s.onlyCode ? '1' : '0');
    return api(qs).then(function (data) {
      s.items = data.items;
      s.total = data.total;
      s.stats = data.stats;
      renderSmsTable();
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  function beginCopy(id) {
    var item = state.sms.items.filter(function (x) { return x.id === id; })[0];
    if (!item || !item.code) return;
    purposeModal(item).then(function (purpose) {
      if (!purpose) return;
      return api('/api/copy', {
        method: 'POST',
        body: JSON.stringify({ smsId: id, purpose: purpose })
      }).then(function (res) {
        return copyText(res.code).then(function (ok) {
          if (ok) toast('已复制验证码 ' + res.code, 'ok');
          else toast('已记录，但浏览器拒绝写入剪贴板，请手动复制', 'warn');
        });
      });
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  function beginDelete(id) {
    var item = state.sms.items.filter(function (x) { return x.id === id; })[0];
    if (!item) return;
    confirmModal('删除这条短信？', item.content.slice(0, 120)).then(function (ok) {
      if (!ok) return;
      return api('/api/sms/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] })
      }).then(function (res) {
        toast('已删除 ' + res.removed + ' 条', 'ok');
        loadSms();
      });
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  /* ============================== 审计日志 ============================== */

  var ACTION_META = {
    login: ['登录后台', 'badge-green'],
    logout: ['退出登录', 'badge-gray'],
    login_failed: ['登录失败', 'badge-red'],
    copy: ['复制验证码', 'badge-blue'],
    delete: ['删除短信', 'badge-amber'],
    recode: ['重新识别', 'badge-gray'],
    settings_update: ['修改设置', 'badge-gray'],
    user_create: ['新建成员', 'badge-gray'],
    user_update: ['更新成员', 'badge-gray'],
    password_change: ['修改密码', 'badge-amber'],
    feishu_test: ['飞书测试', 'badge-gray'],
    webhook_test: ['测试接收', 'badge-gray'],
    webhook_rejected: ['Webhook 校验失败', 'badge-red']
  };

  function actionBadge(action) {
    var meta = ACTION_META[action] || [action, 'badge-gray'];
    return '<span class="badge ' + meta[1] + '">' + escapeHtml(meta[0]) + '</span>';
  }

  function renderAuditShell() {
    var a = state.audit;
    var opts = a.actions.map(function (x) {
      return '<option value="' + escapeHtml(x) + '">' + escapeHtml((ACTION_META[x] || [x])[0]) + '</option>';
    }).join('');
    var userOpts = a.operators.map(function (x) {
      return '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>';
    }).join('');

    $('#view').innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="search-box">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
            '<input class="input" id="auditSearch" placeholder="搜索备注 / 短信内容 / 操作人" value="' + escapeHtml(a.q) + '">' +
          '</div>' +
          '<select class="select select-sm" id="auditAction"><option value="">全部操作</option>' + opts + '</select>' +
          '<select class="select select-sm" id="auditUser"><option value="">全部成员</option>' + userOpts + '</select>' +
          '<input type="date" class="input" id="auditFrom" style="width:148px;padding:7px 10px;font-size:13px" value="' + escapeHtml(a.from) + '">' +
          '<span class="muted" style="font-size:12.5px">至</span>' +
          '<input type="date" class="input" id="auditTo" style="width:148px;padding:7px 10px;font-size:13px" value="' + escapeHtml(a.to) + '">' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="grid">' +
            '<thead><tr>' +
              '<th style="width:132px">时间</th>' +
              '<th style="width:120px">操作人</th>' +
              '<th style="width:118px">操作</th>' +
              '<th style="width:110px">相关号码</th>' +
              '<th style="width:110px">验证码</th>' +
              '<th>备注 / 用途</th>' +
              '<th style="width:118px">来源 IP</th>' +
            '</tr></thead>' +
            '<tbody id="auditBody"></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="pager">' +
          '<span id="auditCount"></span>' +
          '<div class="pager-actions">' +
            '<button class="btn btn-ghost btn-sm" id="auditPrev">上一页</button>' +
            '<button class="btn btn-ghost btn-sm" id="auditNext">下一页</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    $('#auditAction').value = a.action;
    $('#auditUser').value = a.username;

    $('#auditSearch').addEventListener('input', debounce(function (e) {
      state.audit.q = e.target.value.trim();
      state.audit.page = 1;
      loadAudit();
    }, 320));
    $('#auditAction').addEventListener('change', function (e) {
      state.audit.action = e.target.value;
      state.audit.page = 1;
      loadAudit();
    });
    $('#auditUser').addEventListener('change', function (e) {
      state.audit.username = e.target.value;
      state.audit.page = 1;
      loadAudit();
    });
    $('#auditFrom').addEventListener('change', function (e) {
      state.audit.from = e.target.value;
      state.audit.page = 1;
      loadAudit();
    });
    $('#auditTo').addEventListener('change', function (e) {
      state.audit.to = e.target.value;
      state.audit.page = 1;
      loadAudit();
    });
    $('#auditPrev').onclick = function () {
      if (state.audit.page > 1) { state.audit.page -= 1; loadAudit(); }
    };
    $('#auditNext').onclick = function () {
      var maxPage = Math.max(1, Math.ceil(state.audit.total / state.audit.size));
      if (state.audit.page < maxPage) { state.audit.page += 1; loadAudit(); }
    };

    loadAudit();
  }

  function renderAuditTable() {
    var a = state.audit;
    var body = $('#auditBody');
    if (!body) return;

    if (!a.items.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty">' +
        '<div class="ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></div>' +
        '<h3>暂无记录</h3><p>有成员登录或复制验证码后，这里会出现日志</p></div></td></tr>';
    } else {
      body.innerHTML = a.items.map(function (r) {
        var who = r.name || r.username || '—';
        return '<tr>' +
          '<td class="col-time"><div class="t">' + fmtDateTime(r.ts) + '</div></td>' +
          '<td><strong>' + escapeHtml(who) + '</strong>' +
            (r.username && r.name ? '<span class="device">' + escapeHtml(r.username) + '</span>' : '') + '</td>' +
          '<td>' + actionBadge(r.action) + '</td>' +
          '<td>' + (r.phone ? '<span class="phone">' + escapeHtml(r.phone) + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (r.code ? '<span class="mono" style="font-weight:700;color:#1b47c4">' + escapeHtml(r.code) + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td><div class="sms-text" style="max-width:360px">' + escapeHtml(r.purpose || r.extra || '—') + '</div></td>' +
          '<td class="mono muted">' + escapeHtml(r.ip || '—') + '</td>' +
        '</tr>';
      }).join('');
    }

    var maxPage = Math.max(1, Math.ceil(a.total / a.size));
    $('#auditCount').textContent = '共 ' + a.total + ' 条 · 第 ' + a.page + ' / ' + maxPage + ' 页';
    $('#auditPrev').disabled = a.page <= 1;
    $('#auditNext').disabled = a.page >= maxPage;
  }

  function loadAudit() {
    var a = state.audit;
    var qs = '/api/audit?page=' + a.page + '&size=' + a.size +
      '&action=' + encodeURIComponent(a.action) +
      '&username=' + encodeURIComponent(a.username) +
      '&q=' + encodeURIComponent(a.q) +
      '&from=' + encodeURIComponent(a.from) +
      '&to=' + encodeURIComponent(a.to);
    return api(qs).then(function (data) {
      var first = a.operators.length === 0;
      a.items = data.items;
      a.total = data.total;
      a.operators = data.operators;
      a.actions = data.actions;
      if (first && (data.operators.length || data.actions.length)) {
        // 首次加载后补齐筛选下拉，避免重建导致筛选状态丢失
        var selAction = $('#auditAction');
        var selUser = $('#auditUser');
        if (selAction) {
          selAction.innerHTML = '<option value="">全部操作</option>' + data.actions.map(function (x) {
            return '<option value="' + escapeHtml(x) + '">' + escapeHtml((ACTION_META[x] || [x])[0]) + '</option>';
          }).join('');
          selAction.value = a.action;
        }
        if (selUser) {
          selUser.innerHTML = '<option value="">全部成员</option>' + data.operators.map(function (x) {
            return '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>';
          }).join('');
          selUser.value = a.username;
        }
      }
      renderAuditTable();
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  /* ============================== 成员管理 ============================== */

  function renderUsersShell() {
    $('#view').innerHTML =
      '<div class="card">' +
        '<div class="table-wrap">' +
          '<table class="grid">' +
            '<thead><tr>' +
              '<th style="width:150px">账号</th>' +
              '<th style="width:130px">姓名</th>' +
              '<th style="width:100px">角色</th>' +
              '<th style="width:90px">状态</th>' +
              '<th style="width:150px">最近登录</th>' +
              '<th style="width:150px">创建时间</th>' +
              '<th style="text-align:right">操作</th>' +
            '</tr></thead>' +
            '<tbody id="userBody"><tr><td colspan="7"><div class="empty"><p>加载中…</p></div></td></tr></tbody>' +
          '</table>' +
        '</div>' +
      '</div>';
    loadUsers();
  }

  function renderUsersTable() {
    var body = $('#userBody');
    if (!body) return;
    if (!state.users.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty"><h3>还没有成员</h3></div></td></tr>';
      return;
    }
    body.innerHTML = state.users.map(function (u) {
      var isSelf = state.user && u.id === state.user.id;
      return '<tr>' +
        '<td><strong>' + escapeHtml(u.username) + '</strong></td>' +
        '<td>' + escapeHtml(u.name) + '</td>' +
        '<td>' + (u.role === 'admin'
          ? '<span class="badge badge-blue">管理员</span>'
          : '<span class="badge badge-gray">成员</span>') + '</td>' +
        '<td>' + (u.active
          ? '<span class="badge badge-green">正常</span>'
          : '<span class="badge badge-red">已停用</span>') + '</td>' +
        '<td class="muted">' + (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '—') + '</td>' +
        '<td class="muted">' + fmtDateTime(u.createdAt) + '</td>' +
        '<td><div class="row-actions">' +
          '<button class="btn btn-ghost btn-sm" data-reset="' + u.id + '">重置密码</button>' +
          (isSelf ? '' : '<button class="btn btn-ghost btn-sm" data-toggle="' + u.id + '">' +
            (u.active ? '停用' : '启用') + '</button>') +
        '</div></td>' +
      '</tr>';
    }).join('');

    body.onclick = function (e) {
      var reset = e.target.closest('[data-reset]');
      if (reset) { openResetModal(reset.getAttribute('data-reset')); return; }
      var toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        var u = state.users.filter(function (x) { return x.id === toggle.getAttribute('data-toggle'); })[0];
        if (!u) return;
        api('/api/users/' + u.id, {
          method: 'PATCH',
          body: JSON.stringify({ active: !u.active })
        }).then(function () {
          toast(u.active ? '已停用该账号' : '已启用该账号', 'ok');
          loadUsers();
        }).catch(function (err) { toast(err.message, 'err'); });
      }
    };
  }

  function loadUsers() {
    return api('/api/users').then(function (data) {
      state.users = data.items;
      renderUsersTable();
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  function openUserModal() {
    var m = openModal({
      title: '新增成员',
      width: 450,
      body:
        '<div class="form-grid">' +
          '<div class="field"><label>登录账号</label>' +
            '<input class="input" id="newUsername" placeholder="3-32 位字母、数字或 _ . -"></div>' +
          '<div class="field"><label>姓名</label>' +
            '<input class="input" id="newName" placeholder="方便审计日志里辨认"></div>' +
          '<div class="field"><label>初始密码</label>' +
            '<input class="input" id="newPassword" type="text" value="' + randomPassword() + '">' +
            '<p class="help">至少 8 位。请把账号密码发给同事，登录后可自行修改。</p></div>' +
          '<div class="field"><label>角色</label>' +
            '<select class="select" id="newRole">' +
              '<option value="staff">成员（查看 / 复制 / 删除）</option>' +
              '<option value="admin">管理员（含成员与设置管理）</option>' +
            '</select></div>' +
          '<div class="err-text" id="newUserErr"></div>' +
        '</div>',
      footer: '<button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">创建</button>'
    });

    $('[data-act="cancel"]', m.foot).onclick = function () { m.close(); };
    $('[data-act="ok"]', m.foot).onclick = function () {
      var btn = $('[data-act="ok"]', m.foot);
      btn.disabled = true;
      var payload = {
        username: $('#newUsername', m.body).value.trim(),
        name: $('#newName', m.body).value.trim(),
        password: $('#newPassword', m.body).value,
        role: $('#newRole', m.body).value
      };
      api('/api/users', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
        m.close();
        toast('已创建成员 ' + payload.username, 'ok');
        loadUsers();
      }).catch(function (err) {
        $('#newUserErr', m.body).textContent = err.message;
        btn.disabled = false;
      });
    };
  }

  function openResetModal(id) {
    var u = state.users.filter(function (x) { return x.id === id; })[0];
    if (!u) return;
    var pwd = randomPassword();
    var m = openModal({
      title: '重置 ' + u.username + ' 的密码',
      width: 430,
      body:
        '<div class="field"><label>新密码</label>' +
          '<input class="input" id="resetPwd" type="text" value="' + pwd + '">' +
          '<p class="help">设置后请告知本人；该操作会记入审计日志。</p></div>' +
        '<div class="err-text" id="resetErr"></div>',
      footer: '<button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">确认重置</button>'
    });
    $('[data-act="cancel"]', m.foot).onclick = function () { m.close(); };
    $('[data-act="ok"]', m.foot).onclick = function () {
      api('/api/users/' + u.id, {
        method: 'PATCH',
        body: JSON.stringify({ password: $('#resetPwd', m.body).value })
      }).then(function () {
        m.close();
        toast('已重置密码', 'ok');
        loadUsers();
      }).catch(function (err) {
        $('#resetErr', m.body).textContent = err.message;
      });
    };
  }

  function randomPassword() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    var out = '';
    var buf = new Uint32Array(12);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 12; i += 1) out += chars[buf[i] % chars.length];
    return out;
  }

  /* ============================== 系统设置 ============================== */

  function renderSettingsShell() {
    if (state.user.role !== 'admin') {
      $('#view').innerHTML = '<div class="card"><div class="empty"><h3>无权限</h3><p>仅管理员可访问系统设置</p></div></div>';
      return;
    }
    $('#view').innerHTML = '<div class="card"><div class="empty"><p>加载中…</p></div></div>';
    loadSettings();
  }

  function renderSettings() {
    if (state.view !== 'settings') return;
    var s = state.settings;
    var f = s.feishu || {};
    var params = '{"phone":"[from]","content":"[content]","receive_time":"[receive_time]","device":"[device_mark]"}';

    $('#view').innerHTML =
      /* 手机端接入 */
      '<div class="card">' +
        '<div class="card-head">' +
          '<div><h2>手机端接收配置</h2><p class="hint">在 SmsForwarder 中新增「Webhook」通道，把地址与模板填进去即可</p></div>' +
          '<span class="badge badge-green">接收中</span>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="field">' +
            '<label>Webhook 地址</label>' +
            '<div class="url-box">' +
              '<input class="input" id="webhookUrl" readonly value="' + escapeHtml(s.webhookUrl) + '">' +
              '<button class="btn btn-ghost btn-sm" id="btnCopyWebhook">复制</button>' +
            '</div>' +
            '<p class="help">地址里带着密钥 token，拿到地址的人就能往里写短信，请勿外传。</p>' +
          '</div>' +
          '<div class="form-row" style="margin-top:14px">' +
            '<button class="btn btn-ghost btn-sm" id="btnTestWebhook">插入一条测试短信</button>' +
            '<button class="btn btn-danger btn-sm" id="btnResetToken">重置 Token</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnRecode">按当前规则重新识别全部</button>' +
          '</div>' +
          '<div style="height:1px;background:#e5e9f2;margin:18px 0"></div>' +
          '<h3 style="font-size:13.5px;margin-bottom:8px">配置步骤</h3>' +
          '<ol class="steps">' +
            '<li>手机安装 <strong>SmsForwarder</strong> → 「发送通道」→ 右上角 <strong>+</strong> → 选择 <strong>Webhook</strong></li>' +
            '<li>WebServer 填上面的地址，请求方式选 <strong>POST</strong></li>' +
            '<li>webParams 填下面这段 JSON（把号码、内容、时间、设备名一起传过来）</li>' +
            '<li>「成功标识」填 <code>"code": 0</code>，只有响应里含这段才算投递成功</li>' +
            '<li>「转发规则」里新增规则并绑定这个通道，选择要转发的短信（建议只转发含“验证码”的内容）</li>' +
          '</ol>' +
          '<pre class="code-block" id="paramsBlock">' + escapeHtml(params) +
            '<button class="copy-mini" data-copy-text="' + escapeHtml(params) + '">复制</button></pre>' +
          '<p class="help">若 SmsForwarder 版本低于 3.0.5，需要把 <code>content</code> 改成 <code>msg</code>；' +
            '把 webParams 完全留空也能用，此时会以表单形式提交 from / content / timestamp。</p>' +
        '</div>' +
      '</div>' +

      /* 飞书 */
      '<div class="card">' +
        '<div class="card-head">' +
          '<div><h2>飞书推送</h2><p class="hint">收到新短信时，实时推送到飞书群机器人</p></div>' +
        '</div>' +
        '<div class="card-body">' +
          '<label class="switch"><input type="checkbox" id="fsEnabled"' + (f.enabled ? ' checked' : '') + '>' +
            '<span class="track"></span><span class="txt">启用飞书推送</span></label>' +
          '<div class="form-grid two" style="margin-top:14px">' +
            '<div class="field"><label>机器人 Webhook 地址</label>' +
              '<input class="input" id="fsUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." value="' + escapeHtml(f.url || '') + '">' +
              '<p class="help">飞书群 → 设置 → 群机器人 → 添加「自定义机器人」</p></div>' +
            '<div class="field"><label>签名密钥（可选）</label>' +
              '<input class="input" id="fsSecret" placeholder="若机器人开启了签名校验，填这里" value="' + escapeHtml(f.secret || '') + '">' +
              '<p class="help">开启签名校验更安全，不填则按无签名发送</p></div>' +
          '</div>' +
          '<div class="form-row" style="margin-top:6px">' +
            '<label class="check"><input type="checkbox" id="fsCode"' + (f.includeCode === false ? '' : ' checked') + '> 推送内容包含验证码</label>' +
            '<label class="check"><input type="checkbox" id="fsContent"' + (f.includeContent === false ? '' : ' checked') + '> 推送内容包含短信全文</label>' +
          '</div>' +
          '<div class="form-row" style="margin-top:14px">' +
            '<button class="btn btn-primary btn-sm" id="btnSaveFeishu">保存</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnTestFeishu">发送测试消息</button>' +
            (f.lastError
              ? '<span class="badge badge-red">上次推送失败：' + escapeHtml(f.lastError) + '</span>'
              : (f.lastPushAt ? '<span class="badge badge-green">上次推送 ' + fmtDateTime(f.lastPushAt) + '</span>' : '')) +
          '</div>' +
        '</div>' +
      '</div>' +

      /* 识别规则 */
      '<div class="card">' +
        '<div class="card-head"><div><h2>验证码识别规则</h2>' +
          '<p class="hint">内置规则已覆盖常见写法；如需定制，可填写自定义正则（第 1 个捕获组为验证码）</p></div></div>' +
        '<div class="card-body">' +
          '<div class="field"><label>自定义正则（留空表示使用内置规则）</label>' +
            '<input class="input mono" id="codeRegex" placeholder="例如：(?<=验证码为)\\d{6}" value="' + escapeHtml(s.codeRegex || '') + '"></div>' +
          '<div class="form-row" style="margin-top:14px">' +
            '<button class="btn btn-primary btn-sm" id="btnSaveRegex">保存规则</button>' +
            '<span class="help" style="margin:0">保存后点上方「按当前规则重新识别全部」可回溯历史短信</span>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* 修改密码 */
      '<div class="card">' +
        '<div class="card-head"><div><h2>修改我的密码</h2></div></div>' +
        '<div class="card-body">' +
          '<div class="form-grid two">' +
            '<div class="field"><label>当前密码</label><input class="input" id="oldPwd" type="password" autocomplete="current-password"></div>' +
            '<div class="field"><label>新密码（至少 8 位）</label><input class="input" id="newPwd" type="password" autocomplete="new-password"></div>' +
          '</div>' +
          '<div class="form-row" style="margin-top:14px"><button class="btn btn-primary btn-sm" id="btnChangePwd">保存新密码</button></div>' +
        '</div>' +
      '</div>';

    $('#btnCopyWebhook').onclick = function () {
      copyText(s.webhookUrl).then(function (ok) {
        toast(ok ? 'Webhook 地址已复制' : '复制失败，请手动选中复制', ok ? 'ok' : 'warn');
      });
    };

    $('#btnResetToken').onclick = function () {
      confirmModal('重置 Webhook Token？', '重置后旧地址立即失效，需要在手机端重新填写新地址。', '确认重置')
        .then(function (ok) {
          if (!ok) return;
          return api('/api/settings', {
            method: 'PUT',
            body: JSON.stringify({ regenerateToken: true })
          }).then(function (data) {
            state.settings = data.settings;
            renderSettings();
            toast('Token 已重置，请更新手机端配置', 'ok');
          });
        }).catch(function (err) { toast(err.message, 'err'); });
    };

    $('#btnTestWebhook').onclick = function () {
      api('/api/webhook/test', { method: 'POST', body: '{}' }).then(function () {
        toast('已插入一条测试短信', 'ok');
        setView('sms');
      }).catch(function (err) { toast(err.message, 'err'); });
    };

    $('#btnRecode').onclick = function () {
      api('/api/sms/recode', { method: 'POST', body: '{}' }).then(function (res) {
        toast('重新识别完成，更新 ' + res.changed + ' 条', 'ok');
      }).catch(function (err) { toast(err.message, 'err'); });
    };

    $$('[data-copy-text]').forEach(function (btn) {
      btn.onclick = function () {
        copyText(btn.getAttribute('data-copy-text')).then(function () {
          toast('已复制', 'ok');
        });
      };
    });

    $('#btnSaveFeishu').onclick = function () {
      var payload = {
        feishu: {
          enabled: $('#fsEnabled').checked,
          url: $('#fsUrl').value.trim(),
          secret: $('#fsSecret').value.trim(),
          includeCode: $('#fsCode').checked,
          includeContent: $('#fsContent').checked
        }
      };
      api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }).then(function (data) {
        state.settings = data.settings;
        toast('飞书推送配置已保存', 'ok');
      }).catch(function (err) { toast(err.message, 'err'); });
    };

    $('#btnTestFeishu').onclick = function () {
      var btn = $('#btnTestFeishu');
      btn.disabled = true;
      api('/api/settings/feishu-test', {
        method: 'POST',
        body: JSON.stringify({ url: $('#fsUrl').value.trim(), secret: $('#fsSecret').value.trim() })
      }).then(function () {
        toast('测试消息已发送，请查看飞书群', 'ok');
      }).catch(function (err) {
        toast(err.message, 'err');
      }).then(function () {
        btn.disabled = false;
      });
    };

    $('#btnSaveRegex').onclick = function () {
      api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ codeRegex: $('#codeRegex').value })
      }).then(function (data) {
        state.settings = data.settings;
        toast('识别规则已保存', 'ok');
      }).catch(function (err) { toast(err.message, 'err'); });
    };

    $('#btnChangePwd').onclick = function () {
      api('/api/password', {
        method: 'POST',
        body: JSON.stringify({
          oldPassword: $('#oldPwd').value,
          newPassword: $('#newPwd').value
        })
      }).then(function () {
        toast('密码已修改', 'ok');
        state.user.mustChangePassword = false;
        $('#oldPwd').value = '';
        $('#newPwd').value = '';
      }).catch(function (err) { toast(err.message, 'err'); });
    };
  }

  function loadSettings() {
    return api('/api/settings').then(function (data) {
      state.settings = data.settings;
      renderSettings();
    }).catch(function (err) {
      if (err.message !== '登录已失效') toast(err.message, 'err');
    });
  }

  /* ============================== 修改密码弹窗 ============================== */

  function openPasswordModal() {
    var m = openModal({
      title: '修改密码',
      width: 420,
      body:
        '<div class="form-grid">' +
          '<div class="field"><label>当前密码</label><input class="input" id="mpOld" type="password" autocomplete="current-password"></div>' +
          '<div class="field"><label>新密码（至少 8 位）</label><input class="input" id="mpNew" type="password" autocomplete="new-password"></div>' +
          '<div class="err-text" id="mpErr"></div>' +
        '</div>',
      footer: '<button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">保存</button>'
    });
    setTimeout(function () { $('#mpOld', m.body).focus(); }, 60);
    $('[data-act="cancel"]', m.foot).onclick = function () { m.close(); };
    $('[data-act="ok"]', m.foot).onclick = function () {
      api('/api/password', {
        method: 'POST',
        body: JSON.stringify({
          oldPassword: $('#mpOld', m.body).value,
          newPassword: $('#mpNew', m.body).value
        })
      }).then(function () {
        m.close();
        state.user.mustChangePassword = false;
        toast('密码已修改', 'ok');
        renderChrome();
        renderView();
      }).catch(function (err) {
        $('#mpErr', m.body).textContent = err.message;
      });
    };
  }

  /* ============================== 启动 ============================== */

  function bindShell() {
    $$('.nav-item').forEach(function (el) {
      el.onclick = function () { setView(el.getAttribute('data-view')); };
    });
    $('#logoutBtn').onclick = function () {
      api('/api/logout', { method: 'POST', body: '{}' }).then(function () {
        location.replace(withShare('/'));
      }).catch(function () { location.replace(withShare('/')); });
    };
    $('#changePwdBtn').onclick = openPasswordModal;
  }

  function boot() {
    api('/api/me').then(function (data) {
      state.user = data.user;
      document.title = data.settings.siteName || '短信验证码管理平台';
      var hash = (location.hash || '').replace('#', '');
      var allowed = ['sms', 'audit', 'users', 'settings'];
      if (allowed.indexOf(hash) === -1) hash = 'sms';
      if (hash === 'users' || hash === 'settings') {
        if (state.user.role !== 'admin') hash = 'sms';
      }
      state.view = hash;
      $$('.nav-item').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-view') === hash);
      });
      bindShell();
      renderChrome();
      // 先上报公网域名与 sharecode，再渲染各视图，保证 webhook 地址是公网可访问的完整地址
      return api('/api/session-context', {
        method: 'POST',
        body: JSON.stringify({ origin: location.origin, sharecode: SHARE })
      }).catch(function () { /* 上报失败不阻塞界面 */ }).then(function () {
        renderView();
        // 每 30 秒静默刷新一次短信列表
        setInterval(function () {
          if (document.hidden) return;
          if (state.view !== 'sms') return;
          if (state.sms.page !== 1) return;
          loadSms();
        }, 30000);
      });
    }).catch(function () {
      location.replace(withShare('/'));
    });
  }

  boot();
})();
