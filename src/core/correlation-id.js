const crypto = require('crypto');

const CORRELATION_ID_TTL = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;

const _store = new Map();

function generateCorrelationId() {
  return crypto.randomBytes(6).toString('hex');
}

function setCorrelationId(id) {
  _store.set('current', { id, createdAt: Date.now() });
  return id;
}

function getCorrelationId() {
  const entry = _store.get('current');
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CORRELATION_ID_TTL) {
    _store.delete('current');
    return null;
  }
  return entry.id;
}

function clearCorrelationId() {
  _store.delete('current');
}

function runWithContext(id, fn) {
  const previous = _store.get('current');
  setCorrelationId(id);
  try {
    return fn();
  } finally {
    if (previous) {
      _store.set('current', previous);
    } else {
      _store.delete('current');
    }
  }
}

setInterval(() => {
  const entry = _store.get('current');
  if (entry && Date.now() - entry.createdAt > CORRELATION_ID_TTL) {
    _store.delete('current');
  }
}, CLEANUP_INTERVAL).unref();

module.exports = {
  generateCorrelationId,
  setCorrelationId,
  getCorrelationId,
  clearCorrelationId,
  runWithContext,
};