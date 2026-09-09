const { EventBus } = require("../../src/core/events");

module.exports = {
  name: "Event Bus",
  cases: [
    {
      id: "eb_001",
      name: "EventBus creates with empty state",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        return bus !== null && typeof bus.publish === "function";
      },
    },
    {
      id: "eb_002",
      name: "publish dispatches to subscribed handler",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        let received = null;
        bus.subscribe("test:event", (event) => { received = event; });
        bus.publish("test", "event", { data: 42 });
        return received !== null && received.payload.data === 42;
      },
    },
    {
      id: "eb_003",
      name: "subscribe with wildcard matches all types",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        let count = 0;
        bus.subscribe("test:*", () => { count++; });
        bus.publish("test", "a", {});
        bus.publish("test", "b", {});
        return count === 2;
      },
    },
    {
      id: "eb_004",
      name: "subscribe with '*' matches all categories",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        let count = 0;
        bus.subscribe("*", () => { count++; });
        bus.publish("cat1", "evt1", {});
        bus.publish("cat2", "evt2", {});
        return count === 2;
      },
    },
    {
      id: "eb_005",
      name: "replay returns matching events",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        bus.publish("llm", "call_start", { model: "gpt-4" });
        bus.publish("tool", "call_start", { tool: "Bash" });
        const replayed = bus.replay({ category: "llm" });
        return replayed.length === 1 && replayed[0].type === "call_start";
      },
    },
    {
      id: "eb_006",
      name: "publish stores events for replay (limited history)",
      category: "event_bus",
      run: () => {
        const bus = new EventBus();
        for (let i = 0; i < 10; i++) bus.publish("test", `evt${i}`, { i });
        const all = bus.replay({});
        return all.length >= 5 && all.length <= 10;
      },
    },
    {
      id: "eb_007",
      name: "publish mirrors typed event into UnifiedEventBus (harness: namespace)",
      category: "event_bus",
      run: () => {
        // 2026-08-15 P2-7: EventBus = UnifiedEventBus 之上的类型化发布器。
        const bus = new EventBus();
        const unified = require("../../src/core/event-bus");
        let received = null;
        const handler = (payload) => { received = payload; };
        unified.on("harness:mirror:event", handler);
        bus.publish("mirror", "event", { ok: 1 });
        unified.off("harness:mirror:event", handler);
        return received !== null
          && received.category === "mirror"
          && received.type === "event"
          && received.payload.ok === 1;
      },
    },
  ],
};
