const { EventEmitter } = require('events');

class EmailChannel extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = 'email';
    this.type = 'channel';

    this._imapConfig = config.imap || {};
    this._smtpConfig = config.smtp || {};
    this._pollingInterval = config.pollingInterval || 60000;
    this._maxRetries = config.maxRetries || 3;
    this._connected = false;
    this._pollingTimer = null;
    this._lastUid = config.lastUid || 0;
    this._imapClient = null;
    this._smtpClient = null;
  }

  get isConfigured() {
    return !!(this._imapConfig.host && this._imapConfig.user && this._imapConfig.password) &&
           !!(this._smtpConfig.host && this._smtpConfig.user && this._smtpConfig.password);
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('Email 未配置: 需要 imap.host/user/password 和 smtp.host/user/password');
    }

    try {
      this._imapClient = this._createImapClient();
      this._smtpClient = this._createSmtpClient();
      this._connected = true;
      this.emit('connected');
    } catch (e) {
      this._connected = false;
      throw new Error(`Email 连接失败: ${e.message}`);
    }
  }

  async disconnect() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
    if (this._imapClient) {
      try { await this._imapClient.end(); } catch { console.warn('[email/index.js] failed to end IMAP connection gracefully'); }
      this._imapClient = null;
    }
    this._smtpClient = null;
    this._connected = false;
    this.emit('disconnected');
  }

  async startPolling(handler) {
    if (!this._connected) await this.connect();

    this._pollingTimer = setInterval(async () => {
      try {
        const emails = await this.fetchUnread();
        for (const email of emails) {
          const message = this._emailToMessage(email);
          await handler(message);
          this.emit('message', message);
        }
      } catch (e) {
        this.emit('error', { phase: 'polling', error: e.message });
      }
    }, this._pollingInterval);

    this.emit('polling_started', { interval: this._pollingInterval });
  }

  async send(to, content, options = {}) {
    if (!this._smtpClient && !this._connected) {
      throw new Error('Email 未连接');
    }

    const mailOptions = {
      from: this._smtpConfig.user,
      to,
      subject: options.subject || 'CrabPaw 通知',
      text: content,
      html: options.html || null,
      attachments: options.attachments || [],
    };

    return this._sendMail(mailOptions);
  }

  async sendMarkdown(to, options) {
    return this.send(to, options.text || options.content || '', {
      subject: options.subject || 'CrabPaw 通知',
      html: options.html || this._markdownToHtml(options.content || ''),
    });
  }

  async fetchUnread(limit = 20) {
    if (!this._imapClient && !this._connected) {
      throw new Error('Email 未连接');
    }
    return this._fetchUnreadEmails(limit);
  }

  async fetchByUid(uid) {
    if (!this._imapClient && !this._connected) {
      throw new Error('Email 未连接');
    }
    return this._fetchEmailByUid(uid);
  }

  async search(criteria, limit = 20) {
    if (!this._imapClient && !this._connected) {
      throw new Error('Email 未连接');
    }
    return this._searchEmails(criteria, limit);
  }

  parsePayload(data) {
    return {
      id: data.uid || data.id || `email_${Date.now()}`,
      from: data.from || '',
      to: data.to || '',
      subject: data.subject || '',
      content: data.text || data.html || '',
      date: data.date || new Date().toISOString(),
      attachments: data.attachments || [],
      channel: 'email',
    };
  }

  _emailToMessage(email) {
    return {
      id: `email_${email.uid || Date.now()}`,
      channel: 'email',
      userId: email.from,
      content: email.text || email.html || '',
      subject: email.subject || '',
      from: email.from,
      to: email.to,
      date: email.date,
      attachments: email.attachments || [],
      metadata: {
        uid: email.uid,
        flags: email.flags || [],
      },
    };
  }

  _createImapClient() {
    const Imap = require('imap');
    return new Imap({
      user: this._imapConfig.user,
      password: this._imapConfig.password,
      host: this._imapConfig.host,
      port: this._imapConfig.port || 993,
      tls: this._imapConfig.tls !== false,
      tlsOptions: this._imapConfig.tlsOptions || { rejectUnauthorized: false },
      connTimeout: this._imapConfig.timeout || 30000,
      authTimeout: this._imapConfig.authTimeout || 10000,
    });
  }

  _createSmtpClient() {
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
      host: this._smtpConfig.host,
      port: this._smtpConfig.port || 465,
      secure: this._smtpConfig.secure !== false,
      auth: {
        user: this._smtpConfig.user,
        pass: this._smtpConfig.password,
      },
    });
  }

  async _fetchUnreadEmails(limit) {
    return new Promise((resolve, reject) => {
      const imap = this._createImapClient();
      const emails = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, _box) => {
          if (err) { imap.end(); return reject(err); }

          imap.search(['UNSEEN'], (searchErr, results) => {
            if (searchErr) { imap.end(); return reject(searchErr); }
            if (!results || results.length === 0) { imap.end(); return resolve([]); }

            const limitedResults = results.slice(-limit);
            const fetch = imap.fetch(limitedResults, { bodies: '', struct: true });

            fetch.on('message', (msg) => {
              const email = { uid: 0, from: '', to: '', subject: '', text: '', date: '' };
              msg.on('body', (stream) => {
                let buffer = '';
                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                stream.once('end', () => {
                  const simple = require('mailparser').simpleParser;
                  simple(buffer).then((parsed) => {
                    email.from = parsed.from?.text || '';
                    email.to = parsed.to?.text || '';
                    email.subject = parsed.subject || '';
                    email.text = parsed.text || '';
                    email.html = parsed.html || '';
                    email.date = parsed.date?.toISOString() || '';
                    email.attachments = (parsed.attachments || []).map(a => ({
                      filename: a.filename,
                      contentType: a.contentType,
                      size: a.size,
                    }));
                  }).catch(e => console.debug('[email] Send failed:', e?.message));
                });
              });
              msg.once('attributes', (attrs) => {
                email.uid = attrs.uid;
                email.flags = attrs.flags || [];
              });
              emails.push(email);
            });

            fetch.once('error', (fetchErr) => { imap.end(); reject(fetchErr); });
            fetch.once('end', () => { imap.end(); resolve(emails); });
          });
        });
      });

      imap.once('error', (err) => reject(err));
      imap.connect();
    });
  }

  async _fetchEmailByUid(uid) {
    return new Promise((resolve, reject) => {
      const imap = this._createImapClient();
      let email = null;

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { imap.end(); return reject(err); }

          const fetch = imap.fetch([uid], { bodies: '' });
          fetch.on('message', (msg) => {
            email = { uid, from: '', to: '', subject: '', text: '', date: '' };
            msg.on('body', (stream) => {
              let buffer = '';
              stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
              stream.once('end', () => {
                const simple = require('mailparser').simpleParser;
                simple(buffer).then((parsed) => {
                  email.from = parsed.from?.text || '';
                  email.to = parsed.to?.text || '';
                  email.subject = parsed.subject || '';
                  email.text = parsed.text || '';
                  email.html = parsed.html || '';
                  email.date = parsed.date?.toISOString() || '';
                }).catch(e => console.debug('[email] Send failed:', e?.message));
              });
            });
          });
          fetch.once('end', () => { imap.end(); resolve(email); });
          fetch.once('error', (fetchErr) => { imap.end(); reject(fetchErr); });
        });
      });

      imap.once('error', (err) => reject(err));
      imap.connect();
    });
  }

  async _searchEmails(criteria, limit) {
    return new Promise((resolve, reject) => {
      const imap = this._createImapClient();
      const emails = [];

      const searchCriteria = [];
      if (criteria.from) searchCriteria.push(['FROM', criteria.from]);
      if (criteria.to) searchCriteria.push(['TO', criteria.to]);
      if (criteria.subject) searchCriteria.push(['SUBJECT', criteria.subject]);
      if (criteria.since) searchCriteria.push(['SINCE', criteria.since]);
      if (criteria.before) searchCriteria.push(['BEFORE', criteria.before]);
      if (searchCriteria.length === 0) searchCriteria.push(['ALL']);

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) { imap.end(); return reject(err); }

          imap.search(searchCriteria, (searchErr, results) => {
            if (searchErr) { imap.end(); return reject(searchErr); }
            if (!results || results.length === 0) { imap.end(); return resolve([]); }

            const limitedResults = results.slice(-limit);
            const fetch = imap.fetch(limitedResults, { bodies: '' });

            fetch.on('message', (msg) => {
              const email = { uid: 0, from: '', subject: '', text: '', date: '' };
              msg.on('body', (stream) => {
                let buffer = '';
                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                stream.once('end', () => {
                  const simple = require('mailparser').simpleParser;
                  simple(buffer).then((parsed) => {
                    email.from = parsed.from?.text || '';
                    email.subject = parsed.subject || '';
                    email.text = (parsed.text || '').slice(0, 500);
                    email.date = parsed.date?.toISOString() || '';
                  }).catch(e => console.debug('[email] Send failed:', e?.message));
                });
              });
              msg.once('attributes', (attrs) => { email.uid = attrs.uid; });
              emails.push(email);
            });

            fetch.once('end', () => { imap.end(); resolve(emails); });
            fetch.once('error', (fetchErr) => { imap.end(); reject(fetchErr); });
          });
        });
      });

      imap.once('error', (err) => reject(err));
      imap.connect();
    });
  }

  async _sendMail(mailOptions) {
    if (!this._smtpClient) {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        host: this._smtpConfig.host,
        port: this._smtpConfig.port || 465,
        secure: this._smtpConfig.secure !== false,
        auth: { user: this._smtpConfig.user, pass: this._smtpConfig.password },
      });
      const result = await transport.sendMail(mailOptions);
      transport.close();
      return result;
    }
    return this._smtpClient.sendMail(mailOptions);
  }

  _markdownToHtml(markdown) {
    if (!markdown) return '';
    return markdown
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/\n/g, '<br>');
  }
}

function createChannel(config) {
  return new EmailChannel(config);
}

module.exports = {
  EmailChannel,
  createChannel,
};
