// eslint-disable-next-line no-unused-vars -- SYNC_STATUS 从 require 解构但未使用
const { DataSourceAdapter, DATA_SOURCE_TYPES, SYNC_STATUS } = require('./base-adapter');

const QQ_MAIL_IMAP_DEFAULTS = {
  host: 'imap.qq.com',
  port: 993,
  tls: true,
};

const QQ_MAIL_SMTP_DEFAULTS = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
};

class QQMailDataSource extends DataSourceAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      name: 'qqmail',
      type: DATA_SOURCE_TYPES.EMAIL,
      platform: 'qq',
    });
    this._imapConfig = {
      ...QQ_MAIL_IMAP_DEFAULTS,
      ...(opts.imap || {}),
    };
    this._smtpConfig = {
      ...QQ_MAIL_SMTP_DEFAULTS,
      ...(opts.smtp || {}),
    };
    this._authCode = opts.authCode || opts.password || '';
    this._emailAddress = opts.email || opts.user || '';
    this._folders = opts.folders || ['INBOX'];
    this._limit = opts.limit || 50;
    this._lastUid = opts.lastUid || 0;
    this._imapClient = null;
    this._connected = false;
  }

  get isConfigured() {
    return !!(this._emailAddress && this._authCode && this._imapConfig.host);
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('QQ邮箱未配置: 需要 email 和 authCode(授权码)');
    }

    try {
      this._imapClient = this._createImapClient();
      this._connected = true;
      this.emit('connected');
    } catch (e) {
      this._connected = false;
      throw new Error(`QQ邮箱连接失败: ${e.message}`);
    }
  }

  async disconnect() {
    if (this._imapClient) {
      try { await this._imapClient.end(); } catch { console.warn('[qqmail-adapter.js] failed to end IMAP connection gracefully'); }
      this._imapClient = null;
    }
    this._connected = false;
    this.stopSync();
    this.emit('disconnected');
  }

  async fetch(options = {}) {
    if (!this._connected && !this._imapClient) {
      await this.connect();
    }

    const folders = options.folders || this._folders;
    const limit = options.limit || this._limit;
    const allEmails = [];

    for (const folder of folders) {
      const emails = await this._fetchFromFolder(folder, limit);
      allEmails.push(...emails);
    }

    return allEmails;
  }

  normalize(rawEmail) {
    const from = rawEmail.from || '';
    const fromName = typeof from === 'object' ? (from.name || from.address || '') : from;
    const fromAddr = typeof from === 'object' ? (from.address || from.name || '') : from;
    const subject = rawEmail.subject || '(无主题)';
    const text = rawEmail.text || rawEmail.html || '';
    const date = rawEmail.date || new Date().toISOString();
    const uid = rawEmail.uid || 0;

    const content = `[邮件] 来自: ${fromName} <${fromAddr}>\n主题: ${subject}\n\n${text}`;

    return {
      id: `qqmail_${uid}_${Date.now()}`,
      content,
      timestamp: new Date(date).getTime(),
      entities: this._extractEntities(fromName, subject, text),
      topics: this._extractTopics(subject, text),
      metadata: {
        uid,
        from: fromAddr,
        fromName,
        subject,
        date,
        to: rawEmail.to || '',
        cc: rawEmail.cc || '',
        attachments: (rawEmail.attachments || []).map(a => ({
          filename: a.filename || a.fileName || '',
          size: a.size || 0,
          contentType: a.contentType || '',
        })),
        folder: rawEmail.folder || 'INBOX',
        flags: rawEmail.flags || [],
      },
    };
  }

  async _fetchFromFolder(folder, limit) {
    return new Promise((resolve, reject) => {
      const Imap = require('imap');
      const imap = new Imap({
        user: this._emailAddress,
        password: this._authCode,
        host: this._imapConfig.host,
        port: this._imapConfig.port,
        tls: this._imapConfig.tls,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 30000,
        authTimeout: 10000,
      });

      const emails = [];

      imap.once('ready', () => {
        imap.openBox(folder, false, (err) => {
          if (err) { imap.end(); return reject(err); }

          const searchCriteria = this._lastUid ? ['UID', `${this._lastUid + 1}:*`] : ['UNSEEN'];

          imap.search(searchCriteria, (searchErr, results) => {
            if (searchErr) { imap.end(); return reject(searchErr); }
            if (!results || results.length === 0) { imap.end(); return resolve([]); }

            const limited = results.slice(-limit);
            const fetch = imap.fetch(limited, { bodies: '', struct: true });

            fetch.on('message', (msg) => {
              const email = { uid: 0, from: '', to: '', subject: '', text: '', date: '', folder };
              msg.on('body', (stream) => {
                let buffer = '';
                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                stream.once('end', () => {
                  try {
                    const simple = require('mailparser').simpleParser;
                    simple(buffer, (parseErr, parsed) => {
                      if (!parseErr && parsed) {
                        email.from = parsed.from || '';
                        email.to = parsed.to || '';
                        email.subject = parsed.subject || '';
                        email.text = parsed.text || '';
                        email.html = parsed.html || '';
                        email.date = parsed.date ? parsed.date.toISOString() : '';
                        email.attachments = parsed.attachments || [];
                      }
                    });
                  } catch {
                    console.warn('[qqmail-adapter.js] failed to parse email part');
                  }
                });
              });
              msg.once('attributes', (attrs) => {
                email.uid = attrs.uid || 0;
                email.flags = attrs.flags || [];
              });
              emails.push(email);
            });

            fetch.once('error', (fetchErr) => {
              imap.end();
              reject(fetchErr);
            });

            fetch.once('end', () => {
              imap.end();
              resolve(emails);
            });
          });
        });
      });

      imap.once('error', (err) => {
        reject(err);
      });

      imap.once('end', () => {});

      imap.connect();
    });
  }

  _createImapClient() {
    const Imap = require('imap');
    return new Imap({
      user: this._emailAddress,
      password: this._authCode,
      host: this._imapConfig.host,
      port: this._imapConfig.port,
      tls: this._imapConfig.tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000,
      authTimeout: 10000,
    });
  }

  _extractEntities(from, subject, text) {
    const entities = [];
    if (from && typeof from === 'string') {
      entities.push({ type: 'person', name: from, source: 'email_from' });
    }
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
    const emails = (text || '').match(emailRegex) || [];
    for (const email of emails) {
      entities.push({ type: 'email', name: email, source: 'email_body' });
    }
    return entities;
  }

  _extractTopics(subject, _text) {
    const topics = [];
    if (subject) topics.push(subject.slice(0, 50));
    return topics;
  }
}

module.exports = { QQMailDataSource, QQ_MAIL_IMAP_DEFAULTS, QQ_MAIL_SMTP_DEFAULTS };
