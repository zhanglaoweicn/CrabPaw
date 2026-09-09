const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDataDir } = require("./config");

class Dashboard {
  constructor(metricsPipeline) {
    this._metrics = metricsPipeline;
    this._lastSnapshot = null;
  }

  getSnapshot() {
    return this._metrics ? this._metrics.getSnapshot() : {};
  }

  exportOTel() {
    return this._metrics ? this._metrics.exportOpenTelemetry() : {};
  }

  renderHTML() {
    const snap = this.getSnapshot();
    const llmSR = snap.llm?.calls?.total
      ? ((snap.llm.calls.success / snap.llm.calls.total) * 100).toFixed(1)
      : "N/A";
    const toolSR = snap.tools?.calls?.total
      ? ((snap.tools.calls.success / snap.tools.calls.total) * 100).toFixed(1)
      : "N/A";
    const uptime = Math.floor((snap.uptime || 0) / 1000);
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>CrabPaw Harness Dashboard</title>'
      + '<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:20px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}'
      + 'h1{color:#58a6ff;margin:0 0 4px;display:flex;align-items:center;gap:12px}.status-dot{width:10px;height:10px;border-radius:50%;background:#238636;display:inline-block;animation:pulse 2s infinite}'
      + '@keyframes pulse{0%{opacity:1}50%{opacity:0.4}100%{opacity:1}}h3{color:#8b949e;margin:0 0 12px;font-weight:400}.countdown{color:#484f58;font-size:12px;margin-left:auto}'
      + '.metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}.metric{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;transition:border-color .3s}'
      + '.metric:hover{border-color:#58a6ff}.metric-value{font-size:24px;font-weight:700;color:#58a6ff}.metric-value.good{color:#3fb950}.metric-value.warn{color:#d29922}.metric-value.bad{color:#f85149}'
      + '.metric-label{font-size:12px;color:#8b949e}.bar{height:4px;background:#21262d;border-radius:2px;margin-top:6px;overflow:hidden}.bar-fill{height:100%;border-radius:2px;transition:width 1s ease}'
      + '.good{background:#238636}.warn{background:#d29922}.bad{background:#f85149}'
      + '.status-banner{padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:13px}.status-banner.ok{background:#23863622;border:1px solid #238636;color:#3fb950}'
      + '.status-banner.warn{background:#d2992222;border:1px solid #d29922;color:#d29922}.status-banner.degraded{background:#f8514922;border:1px solid #f85149;color:#f85149}</style></head><body>'
      + this._statusBanner(llmSR, toolSR)
      + '<div class="card"><h1><span class="status-dot"></span>CrabPaw Harness<span class="countdown">auto-refresh 5s</span></h1><h3>Uptime: ' + uptime + 's | ' + (snap.timestamp ? 'Snapshot: ' + new Date(snap.timestamp).toISOString() : 'No data yet') + '</h3></div>'
      + '<div class="metric-grid">'
      + this._metricCard("LLM Calls", snap.llm?.calls?.total || 0, "total", snap.llm?.calls?.success || 0)
      + this._metricCard("LLM Success", llmSR + "%", (snap.llm?.calls?.success || 0) + " / " + (snap.llm?.calls?.total || 0), this._barClass(llmSR))
      + this._metricCard("LLM P95", snap.llm?.latency?.p95 ? snap.llm.latency.p95 + "ms" : "—", "p95 latency")
      + this._metricCard("Tool Calls", snap.tools?.calls?.total || 0, "total", snap.tools?.calls?.success || 0)
      + this._metricCard("Tool Success", toolSR + "%", (snap.tools?.calls?.success || 0) + " / " + (snap.tools?.calls?.total || 0), this._barClass(toolSR))
      + this._metricCard("Tool P95", snap.tools?.latency?.p95 ? snap.tools.latency.p95 + "ms" : "—", "p95 latency")
      + this._metricCard("Tokens Used", (snap.tokens?.total || 0).toLocaleString(), "all models")
      + this._metricCard("Sessions Active", snap.sessions?.active || 0, "active / " + (snap.sessions?.completed || 0) + " done")
      + '</div>'
      + '<div class="card"><h3>Errors by Category</h3>' + this._errorList(snap.errors || {}) + '</div>'
      + '<div class="card"><h3>Tokens by Model</h3>' + this._modelList(snap.tokens?.byModel || {}) + '</div>'
      + '</body></html>';
  }

  renderShareHTML() {
    const snap = this.getSnapshot();
    const llmSR = snap.llm?.calls?.total ? ((snap.llm.calls.success / snap.llm.calls.total) * 100).toFixed(1) : "N/A";
    const toolSR = snap.tools?.calls?.total ? ((snap.tools.calls.success / snap.tools.calls.total) * 100).toFixed(1) : "N/A";
    return '<div style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:12px;border-radius:8px;min-width:320px">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:#238636;display:inline-block"></span>'
      + '<span style="color:#58a6ff;font-weight:600;font-size:13px">CrabPaw</span>'
      + '<span style="color:#484f58;font-size:11px;margin-left:auto">' + Math.floor((snap.uptime || 0) / 1000) + 's up</span></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">'
      + '<div style="background:#161b22;border-radius:6px;padding:8px;text-align:center"><div style="font-size:18px;font-weight:700;color:#58a6ff">' + (snap.llm?.calls?.total || 0) + '</div><div style="font-size:10px;color:#8b949e">LLM</div></div>'
      + '<div style="background:#161b22;border-radius:6px;padding:8px;text-align:center"><div style="font-size:18px;font-weight:700;color:#3fb950">' + llmSR + '</div><div style="font-size:10px;color:#8b949e">成功率</div></div>'
      + '<div style="background:#161b22;border-radius:6px;padding:8px;text-align:center"><div style="font-size:18px;font-weight:700;color:#58a6ff">' + (snap.tools?.calls?.total || 0) + '</div><div style="font-size:10px;color:#8b949e">工具</div></div>'
      + '<div style="background:#161b22;border-radius:6px;padding:8px;text-align:center"><div style="font-size:18px;font-weight:700;color:#3fb950">' + toolSR + '</div><div style="font-size:10px;color:#8b949e">成功率</div></div>'
      + '</div>'
      + '<div style="margin-top:6px;display:flex;gap:6px;font-size:10px;color:#484f58">'
      + '<span>Token: ' + (snap.tokens?.total || 0).toLocaleString() + '</span>'
      + '<span>会话: ' + (snap.sessions?.active || 0) + '/' + (snap.sessions?.completed || 0) + '</span>'
      + '</div></div>';
  }

  takeSnapshot() {
    const snap = this.getSnapshot();
    const snapshotId = crypto.randomUUID().slice(0, 8);
    const snapshotDir = path.join(getDataDir(), 'dashboard-snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const filePath = path.join(snapshotDir, 'snapshot-' + snapshotId + '.json');
    fs.writeFileSync(filePath, JSON.stringify({ id: snapshotId, timestamp: Date.now(), ...snap }, null, 2));
    this._lastSnapshot = snap;
    return { id: snapshotId, path: filePath, timestamp: Date.now() };
  }

  getDiffFromLast() {
    const current = this.getSnapshot();
    const prev = this._lastSnapshot || current;
    return {
      llmCallsDelta: (current.llm?.calls?.total || 0) - (prev.llm?.calls?.total || 0),
      toolCallsDelta: (current.tools?.calls?.total || 0) - (prev.tools?.calls?.total || 0),
      tokensDelta: (current.tokens?.total || 0) - (prev.tokens?.total || 0),
      current: { llm: current.llm, tools: current.tools, tokens: current.tokens, sessions: current.sessions },
      previous: { llm: prev.llm, tools: prev.tools, tokens: prev.tokens, sessions: prev.sessions },
    };
  }

  _statusBanner(llmRate, toolRate) {
    const llmNum = parseFloat(llmRate), toolNum = parseFloat(toolRate);
    if (isNaN(llmNum) && isNaN(toolNum)) return '<div class="status-banner ok">\u{1F7E2} System idle</div>';
    const degraded = (llmNum < 80) || (toolNum < 80);
    const warning = (llmNum < 95) || (toolNum < 95);
    if (degraded) return '<div class="status-banner degraded">⚠️ Degraded — LLM: ' + llmRate + '%, Tools: ' + toolRate + '%</div>';
    if (warning) return '<div class="status-banner warn">⚡ Warning — LLM: ' + llmRate + '%, Tools: ' + toolRate + '%</div>';
    return '<div class="status-banner ok">✅ All nominal — LLM: ' + llmRate + '%, Tools: ' + toolRate + '%</div>';
  }

  _barClass(rateStr) { const r = parseFloat(rateStr); if (isNaN(r)) return ""; if (r >= 95) return "good"; if (r >= 80) return "warn"; return "bad"; }

  _metricCard(label, value, sub, barPct) {
    const bar = barPct != null ? '<div class="bar"><div class="bar-fill ' + this._barClass(String(barPct)) + '" style="width:' + (parseFloat(String(barPct)) || 0) + '%"></div></div>' : '';
    return '<div class="metric"><div class="metric-value">' + value + '</div><div class="metric-label">' + label + '<br><span style="font-size:11px;color:#484f58">' + sub + '</span></div>' + bar + '</div>';
  }

  _errorList(errors) {
    const entries = Object.entries(errors);
    if (entries.length === 0) return "<p style='color:#238636'>No errors recorded.</p>";
    return "<div>" + entries.map(([k, v]) => '<span style="display:inline-block;background:#21262d;border-radius:4px;padding:4px 8px;margin:4px;font-size:13px"><b>' + k + '</b>: ' + v + '</span>').join("") + "</div>";
  }

  _modelList(byModel) {
    const entries = Object.entries(byModel);
    if (entries.length === 0) return "<p>No model data.</p>";
    return entries.map(([model, data]) => '<div style="margin-bottom:8px"><b>' + model + '</b>: ' + (data.total || 0).toLocaleString() + ' tokens (prompt: ' + (data.prompt || 0).toLocaleString() + ', completion: ' + (data.completion || 0).toLocaleString() + ')</div>').join("");
  }
}

const globalDashboard = new Dashboard(null);

function bindDashboardToMetrics(metricsPipeline) {
  globalDashboard._metrics = metricsPipeline;
}

module.exports = { Dashboard, globalDashboard, bindDashboardToMetrics };
