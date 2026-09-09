function getLocalISODate() {
  if (process.env.CRABPAW_OVERRIDE_DATE) {
    return process.env.CRABPAW_OVERRIDE_DATE;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

let sessionStartDate = null;

function getSessionStartDate() {
  if (!sessionStartDate) {
    sessionStartDate = getLocalISODate();
  }
  return sessionStartDate;
}

function getLocalMonthYear() {
  const date = process.env.CRABPAW_OVERRIDE_DATE
    ? new Date(process.env.CRABPAW_OVERRIDE_DATE)
    : new Date();
  return date.toLocaleString('zh-CN', { month: 'long', year: 'numeric' });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num) {
  return num.toLocaleString('zh-CN');
}

function formatCost(usd) {
  return `$${usd.toFixed(4)}`;
}

module.exports = {
  getLocalISODate,
  getSessionStartDate,
  getLocalMonthYear,
  formatDuration,
  formatBytes,
  formatNumber,
  formatCost
};
