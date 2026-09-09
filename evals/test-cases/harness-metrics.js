const { MetricsPipeline } = require("../../src/core/metrics-pipeline");

module.exports = {
  name: "Harness Metrics",
  cases: [
    {
      id: "hm_001",
      name: "MetricsPipeline creates with defaults",
      category: "harness_metrics",
      run: () => {
        const mp = new MetricsPipeline();
        return mp !== null && typeof mp.getSnapshot === "function";
      },
    },
    {
      id: "hm_002",
      name: "recordLlmCallStart increments total count",
      category: "harness_metrics",
      run: () => {
        const mp = new MetricsPipeline();
        mp.recordLlmCallStart();
        const snap = mp.getSnapshot();
        return snap.llm.calls.total > 0;
      },
    },
    {
      id: "hm_003",
      name: "recordLlmCallSuccess records token usage",
      category: "harness_metrics",
      run: () => {
        const mp = new MetricsPipeline();
        const start = mp.recordLlmCallStart();
        mp.recordLlmCallSuccess(start, "gpt-4", { prompt_tokens: 1000, completion_tokens: 500 });
        const snap = mp.getSnapshot();
        return snap.llm.calls.success > 0;
      },
    },
    {
      id: "hm_004",
      name: "recordToolCallStart/Success tracks count",
      category: "harness_metrics",
      run: () => {
        const mp = new MetricsPipeline();
        const start = mp.recordToolCallStart("Bash");
        mp.recordToolCallSuccess(start, "Bash");
        const snap = mp.getSnapshot();
        return snap.tools.calls.success > 0;
      },
    },
    {
      id: "hm_005",
      name: "recordSession tracks lifecycle",
      category: "harness_metrics",
      run: () => {
        const mp = new MetricsPipeline();
        mp.recordSessionStart("user_1");
        mp.recordSessionEnd("user_1", true);
        const snap = mp.getSnapshot();
        return snap.sessions.completed > 0;
      },
    },
  ],
};
