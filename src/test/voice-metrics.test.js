const { getMetricsCollector } = require('../core/observability');

describe('voice metrics wiring', () => {
  let metrics;
  beforeEach(() => { metrics = getMetricsCollector(); metrics.reset(); });

  it('increment + histogram 可读回', () => {
    metrics.increment('voice_asr_transcripts_total', 1, { provider: 'volcengine' });
    metrics.histogram('voice_asr_transcript_latency_ms', 120, { provider: 'volcengine' });
    const all = metrics.getAllMetrics();
    expect(all.counters['voice_asr_transcripts_total{provider=volcengine}']).toBe(1);
    expect(all.histograms['voice_asr_transcript_latency_ms{provider=volcengine}'].count).toBe(1);
  });
});
