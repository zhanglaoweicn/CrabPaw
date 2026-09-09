const { EventEmitter } = require('events');

class ResultSummarizer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._maxSummaryLength = config.maxSummaryLength || 500;
    this._maxKeyPoints = config.maxKeyPoints || 5;
    this._maxArtifacts = config.maxArtifacts || 3;
    this._summaryCache = new Map();
    this._cacheMaxSize = config.cacheMaxSize || 100;
  }

  summarize(agentResult, options = {}) {
    const agentId = agentResult.agentId || 'unknown';
    const domainId = agentResult.domainId || options.domainId;
    const capabilityId = agentResult.capabilityId || options.capabilityId;

    const raw = agentResult.result || agentResult.output || agentResult;

    const summary = {
      agentId,
      domainId,
      capabilityId,
      success: agentResult.success !== false,
      summary: this._generateSummary(raw),
      keyPoints: this._extractKeyPoints(raw),
      artifacts: this._extractArtifacts(raw),
      metrics: this._extractMetrics(agentResult),
      timestamp: Date.now(),
    };

    this._summaryCache.set(`${agentId}_${Date.now()}`, summary);
    if (this._summaryCache.size > this._cacheMaxSize) {
      const firstKey = this._summaryCache.keys().next().value;
      this._summaryCache.delete(firstKey);
    }

    this.emit('result:summarized', { agentId, summaryLength: summary.summary.length });
    return summary;
  }

  summarizeFlowResults(flowResults, options = {}) {
    const stepSummaries = [];

    for (const stepResult of flowResults.results || []) {
      if (stepResult.status === 'completed' || stepResult.result) {
        stepSummaries.push(this.summarize(stepResult, {
          domainId: options.domainId,
          capabilityId: stepResult.capabilityId,
        }));
      }
    }

    const overallSummary = {
      flowId: flowResults.flowId,
      flowName: flowResults.flowName,
      totalSteps: flowResults.results?.length || 0,
      completedSteps: stepSummaries.length,
      success: stepSummaries.every(s => s.success),
      summary: this._mergeSummaries(stepSummaries),
      keyPoints: this._mergeKeyPoints(stepSummaries),
      artifacts: this._mergeArtifacts(stepSummaries),
      steps: stepSummaries,
      timestamp: Date.now(),
    };

    this.emit('flow:summarized', { flowId: flowResults.flowId, stepCount: stepSummaries.length });
    return overallSummary;
  }

  _generateSummary(raw) {
    if (!raw) return '';

    if (typeof raw === 'string') {
      return raw.length > this._maxSummaryLength
        ? raw.slice(0, this._maxSummaryLength) + '...'
        : raw;
    }

    if (raw.summary) {
      return raw.summary.length > this._maxSummaryLength
        ? raw.summary.slice(0, this._maxSummaryLength) + '...'
        : raw.summary;
    }

    if (raw.output) {
      const output = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output);
      return output.length > this._maxSummaryLength
        ? output.slice(0, this._maxSummaryLength) + '...'
        : output;
    }

    try {
      const str = JSON.stringify(raw);
      return str.length > this._maxSummaryLength
        ? str.slice(0, this._maxSummaryLength) + '...'
        : str;
    } catch {
      return 'Result could not be summarized';
    }
  }

  _extractKeyPoints(raw) {
    const points = [];

    if (!raw) return points;

    if (raw.keyPoints) {
      return raw.keyPoints.slice(0, this._maxKeyPoints);
    }

    if (raw.findings) {
      return raw.findings.slice(0, this._maxKeyPoints);
    }

    if (typeof raw === 'string') {
      const lines = raw.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'));
      return lines.slice(0, this._maxKeyPoints).map(l => l.replace(/^[-•]\s*/, '').trim());
    }

    return points;
  }

  _extractArtifacts(raw) {
    const artifacts = [];

    if (!raw) return artifacts;

    if (raw.artifacts) {
      return raw.artifacts.slice(0, this._maxArtifacts);
    }

    if (raw.files) {
      return raw.files.slice(0, this._maxArtifacts).map(f => ({
        type: 'file',
        path: typeof f === 'string' ? f : f.path,
      }));
    }

    if (raw.urls) {
      return raw.urls.slice(0, this._maxArtifacts).map(u => ({
        type: 'url',
        url: typeof u === 'string' ? u : u.url,
      }));
    }

    return artifacts;
  }

  _extractMetrics(agentResult) {
    const metrics = {};

    if (agentResult.duration) metrics.duration = agentResult.duration;
    if (agentResult.iterations) metrics.iterations = agentResult.iterations;
    if (agentResult.tokenUsage) metrics.tokenUsage = agentResult.tokenUsage;
    if (agentResult.toolCalls) metrics.toolCalls = agentResult.toolCalls;

    return metrics;
  }

  _mergeSummaries(summaries) {
    return summaries
      .map(s => `[${s.agentId}] ${s.summary}`)
      .join('\n')
      .slice(0, this._maxSummaryLength * 2);
  }

  _mergeKeyPoints(summaries) {
    const allPoints = summaries.flatMap(s => s.keyPoints || []);
    return allPoints.slice(0, this._maxKeyPoints * 2);
  }

  _mergeArtifacts(summaries) {
    const allArtifacts = summaries.flatMap(s => s.artifacts || []);
    return allArtifacts.slice(0, this._maxArtifacts * 2);
  }
}

module.exports = { ResultSummarizer };
