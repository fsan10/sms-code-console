# 短信验证码管理控制台

接收手机转发的短信、自动提取验证码、复制留痕的内部工具。零第三方依赖，一个 `node server.js` 就能跑。

配合 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 的 Webhook 通道使用：手机收到短信 → POST 到本服务 → 自动识别验证码 → 后台列表里一键复制。

## 功能

- **短信接收**：兼容 SmsForwarder 的 JSON / 表单 / GET 三种报文形态，字段名宽容映射（`from`/`phone`、`content`/`msg`、`receive_time`/`timestamp`、`device_mark` 等），5 分钟内重复投递自动去重。
- **验证码识别**：候选打分制，而非单条正则。综合关键词距离、数字长度、负向词（尾号、余额、订单、金额等）、日期与金额过滤，识别不确定时标注「低置信度」。
- **复制留痕**：点击验证码弹出备注框，**用途必填**（服务端强制校验），确认才写入剪贴板，并同步落一条审计记录。
- **操作审计**：登录、退出、登录失败、复制（含用途）、删除、设置变更、账号变更，全部记录时间 / 操作人 / 号码 / 验证码 / 备注 / IP / UA，支持多条件筛选与 CSV 导出。
- **成员管理**：账号密码登录（scrypt 加盐），管理员 / 成员两种角色，可重置密码、停用账号。
- **飞书推送**：新短信实时推送到飞书自定义群机器人，支持签名校验，可选择是否携带验证码与短信全文。

## 快速开始

```bash
# 需要一个 Node.js 18+ 环境
node server.js
```

默认监听 `PORT`（未设置时 3000），数据写入 `~/.sms-console/`（可用 `SMS_DATA_DIR` 覆盖）。

首次启动会自动创建管理员账号：

```
账号：admin
密码：Admin@123456
```

> 请第一时间在「系统设置 → 修改我的密码」里改掉。

## 手机端配置

后台「系统设置」页会显示完整可复制的 Webhook 地址。在 SmsForwarder 中：

1. 「发送通道」→ 右上角 `+` → 选择 **Webhook**
2. WebServer 填后台给出的地址，请求方式选 **POST**
3. webParams 填：

```json
{"phone":"[from]","content":"[content]","receive_time":"[receive_time]","device":"[device_mark]"}
```

4. 「成功标识」填 `"code": 0`
5. 「转发规则」里新增规则并绑定该通道

若 SmsForwarder 版本低于 3.0.5，需要把 `content` 改成 `msg`；webParams 完全留空也能用，此时会以表单形式提交 `from` / `content` / `timestamp`。

> Webhook 地址里带 `token`，拿到地址就能往里写短信，不要外传。泄露后在设置页点「重置 Token」即可作废旧地址。

## 飞书推送

飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，把 Webhook 地址填进后台，开启签名校验的话把密钥一并填上。保存后可以发一条测试消息确认。

## 目录结构

```
server.js              路由、鉴权、webhook 接收、审计（无框架）
lib/store.js           JSON 文件存储，原子写
lib/auth.js            scrypt 密码哈希 + HMAC 签名会话
lib/smscode.js         验证码提取与打分
lib/feishu.js          飞书机器人推送（含签名）
public/                登录页 + 控制台（原生 HTML/CSS/JS）
test/smscode.test.js   识别规则用例
```

## 设计取舍

- **不用 express 等框架**：部署环境常常只给一个 HTTP 端口、没有外部数据库，零依赖能让安装阶段完全不依赖网络和原生编译。
- **不用 MySQL/Redis**：数据量在「内部小工具」这个量级，JSON 文件 + 内存索引足够，写入走 `tmp + rename` 保证原子性。数据目录默认放在用户主目录而非项目内，这样重新发布代码不会把历史记录冲掉。
- **不做前后端分离**：单进程直接吐页面与接口，少一层部署复杂度。

## 注意

- 短信内容属于敏感数据，请勿把 `data/` 目录或导出的 CSV 提交进仓库（`.gitignore` 已排除）。
- 审计日志是追加写入、不提供删除入口。需要长期留存的话，定期用审计页的「导出 CSV」备份。
