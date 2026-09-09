/**
 * decision-feed.js — SSE 决策旁路接线：折叠 → 哈希链落库。
 * 旁路铁律：任何失败只 console.error，绝不抛出阻断主 SSE 流。
 */
const { createFoldState, foldRunEvent } = require('./decision-recorder');
const { persistDecision } = require('./provenance-chain');

let _feedInstance = null;

function createFeed({ store }) {
  const state = createFoldState();
  function feed(eventType, data) {
    try {
      const outcome = foldRunEvent(state, eventType, data);
      if (outcome && outcome.decision) {
        persistDecision(store, outcome.decision);
      }
    } catch (e) {
      console.error('[decision-feed] 决策记录旁路异常（已忽略，不阻断主流程）:', e && e.message);
    }
  }
  return { feed, state };
}

function installDecisionFeed({ store }) {
  _feedInstance = createFeed({ store });
  global.__decisionFeed = _feedInstance.feed;
  console.log('🧾 决策溯源旁路已安装（run 级决策记录 + SHA-256 哈希链）');
  return _feedInstance;
}

function getFeedInstance() { return _feedInstance; }

module.exports = { createFeed, installDecisionFeed, getFeedInstance };
