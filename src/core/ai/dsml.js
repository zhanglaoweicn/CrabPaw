'use strict';

/**
 * DSML 标签解析与清理（从 ai.js 拆分）
 *
 * DSML 是 DeepSeek 模型在 function calling 不可用时可能输出的标签格式，
 * 例如：<｜｜DSML｜｜invoke name="Weather">...<｜｜DSML｜｜/invoke>
 * 本模块负责从文本中解析出工具调用，并清理标签以便展示给用户。
 */

/**
 * 从文本中解析 DSML 工具调用
 * 兼容全角 ｜(U+FF5C) 和半角 |(U+007C) 竖线
 * @param {string} text - LLM 输出文本
 * @returns {Array<{name: string, params: object}>} 工具调用列表
 */
function parseDSMLToolCalls(text) {
  const results = [];

  // 2026-09-24 实测修复: 竖线组与标签名之间允许空白——DeepSeek 实测输出
  // `<｜｜DSML｜｜ invoke name="ShowTyphoon">`（｜｜ 与 invoke 间有空格），
  // 旧正则 [｜|]+DSML[｜|]+invoke 不容空白 → 整个调用解析不到 → 被当纯文本
  // 放行，"关闭台风卡"整轮空转（trajectory 0 次工具调用）。
  const invokeRegex = /<[｜|]+\s*DSML\s*[｜|]+\s*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*[｜|]+\s*DSML\s*[｜|]+\s*invoke\s*>/g;
  let invokeMatch;

  while ((invokeMatch = invokeRegex.exec(text)) !== null) {
    const name = invokeMatch[1];
    const paramsBlock = invokeMatch[2];

    const params = {};
    const paramRegex = /<[｜|]+\s*DSML\s*[｜|]+\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*[｜|]+\s*DSML\s*[｜|]+\s*parameter\s*>/g;
    let paramMatch;

    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      let paramValue = paramMatch[2].trim();

      const fullParamTag = paramMatch[0];
      const isString = /string\s*=\s*"true"/i.test(fullParamTag);
      // 注意：string="false" 仅表示"不是字符串"，不能据此判定为布尔值
      // 必须显式 boolean="true" 才认为是布尔类型
      const isBoolean = /boolean\s*=\s*"true"/i.test(fullParamTag);
      const isNumber = /number\s*=\s*"true"/i.test(fullParamTag);
      const isInteger = /integer\s*=\s*"true"/i.test(fullParamTag);

      // 优先级：显式类型 > 自动推断
      // 数字/整数优先于布尔（避免把 "8" 这样的数字误判为布尔）
      if (isInteger) {
        const intVal = parseInt(paramValue, 10);
        paramValue = isNaN(intVal) ? paramValue : intVal;
      } else if (isNumber) {
        const num = Number(paramValue);
        paramValue = isNaN(num) ? paramValue : num;
      } else if (isBoolean) {
        paramValue = (paramValue === 'true' || paramValue === 'True' || paramValue === '1');
      } else if (!isString) {
        // 无显式类型标注，尝试自动推断
        // 2026-08-08 fix: 模型常把嵌套 JSON 参数(data 等)写成 JSON 字符串——
        // 此前保持字符串导致工具契约校验失败("[Tool Contract] ... / should be object")
        // → 工具执行失败 → 强制重生成最终回答(用户看到乱文字回复)。对 { / [ 开头
        // 的值尝试 JSON.parse 还原为对象/数组。
        const trimmed = paramValue.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            paramValue = JSON.parse(trimmed);
          } catch (e) {

            // JSON 解析失败则保持原字符串，交给契约校验兜底

            console.warn('[dsml.js] 空 catch 补日志:', e && e.message);
          }

        } else if (paramValue === 'true' || paramValue === 'True') paramValue = true;
        else if (paramValue === 'false' || paramValue === 'False') paramValue = false;
        else {
          const num = Number(paramValue);
          if (!isNaN(num) && paramValue !== '') paramValue = num;
        }
      }

      params[paramName] = paramValue;
    }

    // 2026-09-24 实测修复: 空参数调用不再静默丢弃——旧逻辑 params 为空直接跳过，
    // 模型"发了调用但没填参数"时整个调用蒸发（连失败反馈都没有）。现一律透出，
    // 由消费方（ai.js）按契约校验：缺必填参数 → 走自修正/诚实失败路径，而不是蒸发。
    // 参数名兼容：部分模型用 path，部分用 file_path
    if (name === 'Read' && params.path && !params.file_path) {
      params.file_path = params.path;
      delete params.path;
    }
    if (name === 'Write' && params.path && !params.file_path) {
      params.file_path = params.path;
      delete params.path;
    }
    if (name === 'LS' && params.file_path && !params.path) {
      params.path = params.file_path;
      delete params.file_path;
    }

    results.push({ name, params });
  }

  if (results.length > 0) {
    console.log('🔍 DSML 解析结果:', JSON.stringify(results));
  }
  return results;
}

/**
 * 清理文本中的 DSML 标签
 * 兼容全角 ｜(U+FF5C) 和半角 |(U+007C) 竖线
 * @param {string} text - 含 DSML 标签的文本
 * @returns {string} 清理后的纯文本
 */
function stripDSMLTags(text) {
  if (!text) return text;
  let cleaned = text;
  // DSML format
  cleaned = cleaned.replace(/<[｜|]+DSML[｜|]+tool_calls>[\s\S]*?<\/[｜|]+DSML[｜|]+tool_calls>/g, '');
  cleaned = cleaned.replace(/<[｜|]+DSML[｜|]+invoke[^>]*>[\s\S]*?<\/[｜|]+DSML[｜|]+invoke>/g, '');
  cleaned = cleaned.replace(/<[｜|]+DSML[｜|]+parameter[^>]*>[\s\S]*?<\/[｜|]+DSML[｜|]+parameter>/g, '');
  cleaned = cleaned.replace(/<\/?[｜|]+DSML[｜|]+[^>]*>/g, '');
  cleaned = cleaned.replace(/<[｜|][^｜|]*[｜|][^>]*>/g, '');
  // Raw XML tool call tags hallucinated by LLM
  cleaned = cleaned.replace(/<\/(?:\s*\w+_)?invoke\s*>/gi, '');
  cleaned = cleaned.replace(/<\/\s*tool_calls\s*>/gi, '');
  cleaned = cleaned.replace(/<\s*(?:\w+_)?invoke\s+name\s*=\s*"[^"]*"\s*>/gi, '');
  cleaned = cleaned.replace(/<\s*tool_calls\s*>/gi, '');
  cleaned = cleaned.replace(/<\s*\/\s*tool_calls\s*>/gi, '');
  cleaned = cleaned.replace(/<\s*parameter\s+name\s*=\s*"[^"]*"[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\s*\/\s*parameter\s*>/gi, '');
  // Generic unclosed angle bracket fragments at end of response
  cleaned = cleaned.replace(/<\s*\/?\s*(?:invoke|tool_calls|parameter)\s*[^>]*$/gim, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

/**
 * 检查一次解析出的调用是否"参数不完整"（对照工具契约）。
 * 两种情形都算不完整：
 *   ① 缺必填参数（required 未给）；
 *   ② 零参数调用但契约本有参数可填——实测陷阱：ShowTyphoon 的 action 默认
 *      show，模型发空调用会被当 show 执行把面板"刷开"，与用户"关闭"意图相反。
 * 契约不存在或读取失败时按"完整"处理（交由执行层的契约钩子兜底）。
 * 返回不完整项的可读描述数组（带枚举可选值提示），空数组 = 可直接执行。
 */
function getMissingRequiredParams(toolName, params) {
  try {
    const { getToolContract } = require('../tool-contract');
    const contract = typeof getToolContract === 'function' ? getToolContract(toolName) : null;
    if (!contract || !contract.schema) return [];
    const props = contract.schema.properties || {};
    const src = params && typeof params === 'object' ? params : {};
    const required = Array.isArray(contract.schema.required) ? contract.schema.required : [];
    const missing = required
      .filter((k) => {
        const v = src[k];
        return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
      })
      .map((k) => {
        const p = props[k] || {};
        return Array.isArray(p.enum) ? `${k}（可选值: ${p.enum.join(' / ')}）` : k;
      });
    const propKeys = Object.keys(props);
    if (missing.length === 0 && propKeys.length > 0 && Object.keys(src).length === 0) {
      missing.push(`该调用没有任何参数（该工具的参数: ${propKeys.slice(0, 4).join('、')}${propKeys.length > 4 ? ' 等' : ''}）`);
    }
    return missing;
  } catch (e) {
    return [];
  }
}

module.exports = {
  parseDSMLToolCalls,
  stripDSMLTags,
  getMissingRequiredParams,
};
