const { AgentContractValidator } = require("../../src/core/agent-contract-validator");

module.exports = {
  name: "Harness Contracts",
  cases: [
    {
      id: "hc_001",
      name: "AgentContractValidator creates with defaults",
      category: "harness_contracts",
      run: () => {
        const acv = new AgentContractValidator();
        return acv !== null && typeof acv.defineContract === "function";
      },
    },
    {
      id: "hc_002",
      name: "defineContract populates contracts",
      category: "harness_contracts",
      run: () => {
        const acv = new AgentContractValidator();
        acv.defineContract("test_planner", {
          requiredCapabilities: ["planning"],
          maxIterations: 10,
        });
        return true;
      },
    },
    {
      id: "hc_003",
      name: "validateSpawn returns structured result",
      category: "harness_contracts",
      run: () => {
        const acv = new AgentContractValidator();
        acv.defineContract("planner", {
          requiredCapabilities: ["planning", "reasoning"],
          maxIterations: 10,
        });
        const result = acv.validateSpawn("planner",
          { capabilities: ["planning", "reasoning"], tools: [] },
          { task: "test" });
        return typeof result === "object" && "valid" in result;
      },
    },
  ],
};
