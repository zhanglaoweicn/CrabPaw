/**
 * Email Tools - 邮件收发工具
 *
 * 支持 IMAP 收件（读取/搜索）和 SMTP 发件。
 * 使用 Node.js 内置 net/tls 模块，无需额外依赖。
 *
 * 注册工具: email_list, email_read, email_search, email_send
 */

const net = require('net');
const tls = require('tls');
const { registry } = require('./registry');

// ============================================================
// IMAP 客户端（轻量实现）
// ============================================================

class ImapClient {
  constructor(config) {
    this.host = config.host || 'imap.gmail.com';
    this.port = config.port || 993;
    this.user = config.user;
    this.pass = config.pass;
    this.tls = config.tls !== false;
    this.socket = null;
    this.buffer = '';
    this.tagCounter = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('IMAP 连接超时')), 15000);
      try {
        if (this.tls) {
          this.socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => {
            clearTimeout(timeout);
            this._readUntil('* OK').then(() => this._cmd(`LOGIN ${this.user} ${this.pass}`))
              .then(() => resolve(this))
              .catch(reject);
          });
        } else {
          this.socket = net.connect({ host: this.host, port: this.port }, () => {
            clearTimeout(timeout);
            this._readUntil('* OK').then(() => this._cmd(`LOGIN ${this.user} ${this.pass}`))
              .then(() => resolve(this))
              .catch(reject);
          });
        }
        this.socket.on('error', (e) => { clearTimeout(timeout); reject(e); });
        this.socket.on('data', (data) => { this.buffer += data.toString(); });
      } catch (e) { clearTimeout(timeout); reject(e); }
    });
  }

  async _cmd(command) {
    const tag = `A${++this.tagCounter}`;
    this.socket.write(`${tag} ${command}\r\n`);
    return this._readUntil(`${tag} OK`, `${tag} NO`, `${tag} BAD`);
  }

  async _readUntil(...markers) {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (const m of markers) {
          if (this.buffer.includes(m)) {
            const result = this.buffer;
            this.buffer = '';
            if (m.includes('NO') || m.includes('BAD')) {
              reject(new Error(`IMAP 错误: ${result.substring(result.lastIndexOf('\n', result.indexOf(m))).trim()}`));
            } else {
              resolve(result);
            }
            return;
          }
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  async listMailboxes() {
    const result = await this._cmd('LIST "" "*"');
    const lines = result.split('\r\n');
    return lines.filter(l => l.includes('LIST')).map(l => {
      const m = l.match(/"([^"]+)"\s*$/);
      return m ? m[1] : l;
    });
  }

  async selectFolder(folder = 'INBOX') {
    return this._cmd(`SELECT "${folder}"`);
  }

  async search(criteria = 'ALL', limit = 20) {
    const result = await this._cmd(`SEARCH ${criteria}`);
    const match = result.match(/\* SEARCH ([\d\s]+)/);
    if (!match) return [];
    const ids = match[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    return ids.slice(-limit);
  }

  async fetchHeaders(ids) {
    if (!ids || ids.length === 0) return [];
    const idStr = Array.isArray(ids) ? ids.join(',') : ids;
    const result = await this._cmd(`FETCH ${idStr} (FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`);
    const emails = [];
    const blocks = result.split(/\* \d+ FETCH/).filter(b => b.includes('SUBJECT'));
    for (const block of blocks) {
      emails.push({
        subject: (block.match(/SUBJECT:\s*(.+)/i) || ['', '(无主题)'])[1].trim(),
        from: (block.match(/FROM:\s*(.+)/i) || ['', '未知'])[1].trim(),
        date: (block.match(/DATE:\s*(.+)/i) || ['', ''])[1].trim(),
      });
    }
    return emails;
  }

  async fetchBody(id) {
    const result = await this._cmd(`FETCH ${id} (BODY[TEXT])`);
    const match = result.match(/\* \d+ FETCH[\s\S]*?\r\n\r\n([\s\S]*?)\r\n\)/);
    return match ? match[1].trim() : result;
  }

  async close() {
    try { await this._cmd('LOGOUT'); } catch (_) { console.warn('Failed to send LOGOUT command during close'); }
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }
}

// ============================================================
// SMTP 客户端（轻量实现）
// ============================================================

class SmtpClient {
  constructor(config) {
    this.host = config.host || 'smtp.gmail.com';
    this.port = config.port || 465;
    this.user = config.user;
    this.pass = config.pass;
  }

  async send({ from, to, subject, text, html }) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP 发送超时')), 30000);
      try {
        const socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => {
          let buf = '';
          const readUntil = (code) => new Promise((r, rj) => {
            const check = () => {
              if (buf.includes(`${code} `) || buf.includes(`${code}\r`)) {
                const result = buf; buf = '';
                if (code >= 500) rj(new Error(`SMTP ${result.trim()}`)); else r(result);
                return;
              }
              setTimeout(check, 50);
            };
            check();
          });

          const cmd = (s) => new Promise((r) => { socket.write(s + '\r\n'); r(); });

          socket.on('data', (d) => { buf += d.toString(); });

          (async () => {
            try {
              await readUntil(220); // greeting
              await cmd(`EHLO crabpaw`); await readUntil(250);
              await cmd('AUTH LOGIN');
              await readUntil(334);
              await cmd(Buffer.from(this.user).toString('base64'));
              await readUntil(334);
              await cmd(Buffer.from(this.pass).toString('base64'));
              await readUntil(235);
              await cmd(`MAIL FROM:<${from || this.user}>`); await readUntil(250);
              await cmd(`RCPT TO:<${to}>`); await readUntil(250);
              await cmd('DATA'); await readUntil(354);

              const body = [
                `From: ${from || this.user}`,
                `To: ${to}`,
                `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
                'MIME-Version: 1.0',
                'Content-Type: ' + (html ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8'),
                '',
                html || text || '',
                '.',
              ].join('\r\n');
              await cmd(body);
              await readUntil(250);
              await cmd('QUIT');
              clearTimeout(timeout);
              socket.end();
              resolve({ success: true, message: '邮件发送成功' });
            } catch (e) {
              clearTimeout(timeout);
              socket.end();
              reject(e);
            }
          })();
        });
        socket.on('error', (e) => { clearTimeout(timeout); reject(e); });
      } catch (e) { clearTimeout(timeout); reject(e); }
    });
  }
}

// ============================================================
// 凭证管理（从配置中读取）
// ============================================================

function getEmailConfig() {
  const configPath = require('path').join(require('../core/config').DATA_DIR, 'email-config.json');
  try {
    if (require('fs').existsSync(configPath)) {
      return JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    }
  } catch (_) { console.warn('Failed to load email config from ' + configPath); }
  return null;
}

// ============================================================
// 工具注册
// ============================================================

registry.register({
  name: 'email_list',
  toolset: 'email',
  category: 'email',
  description: '列出收件箱中的邮件。返回邮件主题、发件人、日期。需要先配置邮箱账号。',
  whenNotToUse: ["未配置邮箱 IMAP 凭证时不要使用","不要用于读取单封邮件正文，改用 email_read"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: '邮箱文件夹，默认 INBOX' },
      limit: { type: 'number', description: '返回数量，默认 20' },
      filter: { type: 'string', description: '过滤条件：unseen(未读), from:xxx, subject:xxx' },
    },
  },
  async handler(params) {
    const config = getEmailConfig();
    if (!config) {
      return { success: false, error: '未配置邮箱。请在 data/email-config.json 中配置 IMAP 账号信息。格式: {"imap":{"host":"imap.gmail.com","port":993,"user":"xxx@gmail.com","pass":"app-password"}}' };
    }
    const client = new ImapClient(config.imap);
    try {
      await client.connect();
      await client.selectFolder(params.folder || 'INBOX');
      let criteria = 'ALL';
      if (params.filter === 'unseen') criteria = 'UNSEEN';
      else if (params.filter) criteria = params.filter;
      const ids = await client.search(criteria, params.limit || 20);
      const emails = await client.fetchHeaders(ids);
      return { success: true, count: emails.length, emails };
    } finally {
      await client.close();
    }
  }
});

registry.register({
  name: 'email_read',
  toolset: 'email',
  category: 'email',
  description: '读取指定邮件的完整内容。需要先通过 email_list 获取邮件序号。',
  whenNotToUse: ["未配置邮箱 IMAP 凭证时不要使用","不要用于批量列出邮件，改用 email_list"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: '邮件序号（从 email_list 结果中获取）' },
    },
    required: ['id'],
  },
  async handler(params) {
    const config = getEmailConfig();
    if (!config) {
      return { success: false, error: '未配置邮箱' };
    }
    const client = new ImapClient(config.imap);
    try {
      await client.connect();
      await client.selectFolder('INBOX');
      const body = await client.fetchBody(params.id);
      return { success: true, id: params.id, body: body.substring(0, 8000) };
    } finally {
      await client.close();
    }
  }
});

registry.register({
  name: 'email_search',
  toolset: 'email',
  category: 'email',
  description: '按关键词搜索邮件。',
  whenNotToUse: ['未配置邮箱 IMAP 凭证时不要使用', '不要用于遍历全部邮件，改用 email_list'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（搜索主题和发件人）' },
      limit: { type: 'number', description: '返回数量，默认 10' },
    },
    required: ['query'],
  },
  async handler(params) {
    const config = getEmailConfig();
    if (!config) {
      return { success: false, error: '未配置邮箱' };
    }
    const client = new ImapClient(config.imap);
    try {
      await client.connect();
      await client.selectFolder('INBOX');
      const ids = await client.search(`SUBJECT "${params.query}"`, params.limit || 10);
      const emails = await client.fetchHeaders(ids);
      return { success: true, query: params.query, count: emails.length, emails };
    } finally {
      await client.close();
    }
  }
});

registry.register({
  name: 'email_send',
  toolset: 'email',
  category: 'email',
  description: '发送邮件。需要先配置 SMTP 账号。',
  whenNotToUse: ["未配置 SMTP 凭证时不要使用","未确认收件人和内容前不要发送（外发不可撤回）"],

  riskLevel: 'high',

  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '收件人邮箱' },
      subject: { type: 'string', description: '邮件主题' },
      text: { type: 'string', description: '纯文本正文' },
      html: { type: 'string', description: 'HTML 正文（可选）' },
    },
    required: ['to', 'subject', 'text'],
  },
  async handler(params) {
    const config = getEmailConfig();
    if (!config) {
      return { success: false, error: '未配置邮箱。请在 data/email-config.json 中配置 SMTP 账号信息。' };
    }
    const client = new SmtpClient(config.smtp || { host: 'smtp.gmail.com', port: 465, user: config.imap.user, pass: config.imap.pass });
    return client.send({
      from: config.smtp?.user || config.imap?.user,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
  }
});

module.exports = { ImapClient, SmtpClient, getEmailConfig };
