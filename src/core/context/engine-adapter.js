// eslint-disable-next-line no-unused-vars
const { ContextEngineV2, ENGINE_LIFECYCLE } = require('./engine-v2');
const { AssembleResult } = require('./assemble-result');
const { ThreadBootstrapProjection } = require('./thread-bootstrap');

class EngineAdapter {
  constructor(legacyEngine) {
    this._legacy = legacyEngine;
    this._v2 = null;
    this._projection = null;
  }

  async toV2(config = {}) {
    this._v2 = new ContextEngineV2({
      engineId: `adapted-${this._legacy.name || 'legacy'}`,
      tokenBudget: config.tokenBudget || this._legacy.thresholdTokens || 128000,
      ...config,
    });

    this._projection = new ThreadBootstrapProjection({
      bootstrapContent: config.bootstrapContent || '',
    });

    return this._v2;
  }

  async bootstrap(params) {
    if (!this._v2) await this.toV2();
    return this._v2.bootstrap(params);
  }

  async ingest(params) {
    if (!this._v2) await this.toV2();

    const result = await this._v2.ingest(params);

    if (this._legacy && this._legacy.pipeline) {
      try {
        this._legacy.pipeline.addMessage(params.message);
      } catch (e) {

        // legacy pipeline may not support this

        console.warn('[engine-adapter.js] 空 catch 补日志:', e && e.message);
      }

    }

    return result;
  }

  async assemble(params) {
    if (!this._v2) await this.toV2();

    const v2Result = await this._v2.assemble(params);

    const assembleResult = new AssembleResult({
      messages: v2Result.messages,
      promptAuthority: v2Result.promptAuthority,
      projection: v2Result.projection,
      tokenBudget: v2Result.tokenBudget,
      usedTokens: v2Result.usedTokens,
      messageCount: v2Result.messageCount,
      totalAvailable: v2Result.totalAvailable,
      truncated: v2Result.truncated,
    });

    if (this._projection && params.sessionKey) {
      const projection = this._projection.getProjection(params.sessionKey);
      if (projection) {
        assembleResult.messages = this._projection.applyProjection(
          assembleResult.messages,
          projection
        );
        assembleResult.projection = projection;
      }
    }

    return assembleResult;
  }

  async compact(params) {
    if (!this._v2) await this.toV2();
    return this._v2.compact(params);
  }

  async maintain(params) {
    if (!this._v2) await this.toV2();
    return this._v2.maintain(params);
  }

  async afterTurn(params) {
    if (!this._v2) await this.toV2();
    return this._v2.afterTurn(params);
  }

  getV2() {
    return this._v2;
  }

  getProjection() {
    return this._projection;
  }
}

module.exports = { EngineAdapter };
