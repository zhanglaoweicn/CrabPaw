/**
 * roundtable.js — 圆桌会议编排（多专家群聊式讨论，2026-09-20）
 *
 * 场景：老板说「专家们开个会讨论2026年业务计划」→ 自动召集相关专家 →
 *       圆桌两轮讨论（发言互相可见，可被老板插话）→ 主持收口（结论+任务清单）
 *       → 生成会议纪要与业务计划 Word 文档卡。
 *
 * 与部门例会（collaboration.js startDepartmentMeeting 并行+汇总制）的差异：
 *   发言是顺序轮次制、后发言者看得到先前全部发言（真讨论而非各说各话）、
 *   老板可在会中插话且插话进入后续所有人的 prompt。
 *
 * 透明性：statement 级 SSE（roundtable:*）+ data/roundtable/rt_*.json 落盘。
 * 音色：豆包 seed-tts-2.0 音色池，专家↔音色稳定绑定（roundtable-voices.json），
 *       绑定持久——老板多次开会后"听声识人"。合成在 GUI 侧按语句调 /api/voice/tts，
 *       文本永远是真值，语音只是渲染层（合成失败自动降级纯文字，不阻塞会议）。
 *
 * 防跑偏三闸（Cumora 借鉴）：
 *   ①轮次硬地板——固定两轮必收口，无自由接龙；
 *   ②顺序调度——同一时刻只有一位专家在发言（无并发撞车）；
 *   ③单例会议——全库同时最多一场进行中圆桌，重复触发返回既有会议句柄。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const RT_DIR = path.join(config.DATA_DIR, 'roundtable');
const VOICE_FILE = path.join(RT_DIR, 'roundtable-voices.json');

const { getExpert, getDepartments, getTeamPresets, getAllExperts } = require('./index');
const { broadcastEvent } = require('../sse-broadcast');
const { TTS_PROVIDERS } = require('../tts');

// ─── 常量 ──────────────────────────────────────────────
const MAX_MEMBERS = 4;               // 成员席位（主持之外），全场 ≤5 人
const STATEMENT_TIMEOUT_MS = 180000; // 单条发言超时
const TOTAL_DEADLINE_MS = 15 * 60 * 1000; // 整场看门狗
const RECENT_WINDOW_MS = 10 * 60 * 1000;  // 同会话幂等窗口

// 豆包 seed-tts-2.0 十音色（5女5男）；池缺失时退 edge 兜底音色（保底不空）
const VOICE_POOL = (TTS_PROVIDERS.doubao && Array.isArray(TTS_PROVIDERS.doubao.voices) && TTS_PROVIDERS.doubao.voices.length > 0)
  ? TTS_PROVIDERS.doubao.voices.slice()
  : ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'];

// ─── 内部状态 ──────────────────────────────────────────
const _roundtables = new Map();      // meetingId -> state
const _recentStarts = new Map();     // sessionId -> startedAt（幂等）
let _saveChain = Promise.resolve();  // 写盘串行链（防并发撕裂）

function _ensureDirs() { fs.mkdirSync(RT_DIR, { recursive: true }); }

function _loadState(meetingId) {
  if (_roundtables.has(meetingId)) return _roundtables.get(meetingId);
  try {
    const p = path.join(RT_DIR, `${meetingId}.json`);
    if (fs.existsSync(p)) {
      const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _roundtables.set(meetingId, state);
      return state;
    }
  } catch (err) { console.error('[Roundtable] 读取会议失败:', meetingId, err.message); }
  return null;
}

function _save(state) {
  // 2026-09-20 串行化写盘——收口阶段(ms 级连续 _save)曾并发撕裂文件(JSON Extra data),
  // 与 sse-broadcast 事件日志同一手法: 单 Promise 链保序, 写完才放下一个
  _ensureDirs();
  _saveChain = _saveChain.then(() => new Promise((resolve) => {
    try {
      fs.writeFile(path.join(RT_DIR, `${state.meetingId}.json`), JSON.stringify(state, null, 2), (err) => {
        if (err) console.error('[Roundtable] 保存失败:', err.message);
        resolve();
      });
    } catch (err) { console.error('[Roundtable] 保存失败:', err.message); resolve(); }
  }));
  return _saveChain;
}

function _setPhase(state, phase, round) {
  state.phase = phase;
  if (round != null) state.round = round;
  _save(state);
  broadcastEvent('roundtable:phase', { meetingId: state.meetingId, phase, round: state.round });
}

// ─── 音色分配（稳定绑定 + 池内补位） ────────────────────
function _loadVoiceBindings() {
  try {
    if (fs.existsSync(VOICE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(VOICE_FILE, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    }
  } catch (err) { console.warn('[Roundtable] 音色绑定读取失败:', err.message); }
  return {};
}

function _saveVoiceBindings(bindings) {
  try {
    _ensureDirs();
    _saveChain = _saveChain.then(() => new Promise((resolve) => {
      try {
        fs.writeFile(VOICE_FILE, JSON.stringify(bindings, null, 2), (err) => {
          if (err) console.error('[Roundtable] 音色绑定保存失败:', err.message);
          resolve();
        });
      } catch (err) { console.error('[Roundtable] 音色绑定保存失败:', err.message); resolve(); }
    }));
  } catch (err) { console.error('[Roundtable] 音色绑定保存失败:', err.message); }
}

/** 专家↔音色稳定绑定：已绑定的保持不变；新专家从池中取未占用音色（耗尽则轮转）。 */
function assignVoices(expertIds) {
  const bindings = _loadVoiceBindings();
  const pool = VOICE_POOL;
  const used = new Set(Object.values(bindings).filter((v) => pool.includes(v)));
  const assignedCount = Object.keys(bindings).length;
  for (const id of expertIds) {
    if (bindings[id] && pool.includes(bindings[id])) continue;
    let voice = null;
    for (const v of pool) { if (!used.has(v)) { voice = v; break; } }
    if (!voice) voice = pool[assignedCount % pool.length] || pool[0];
    bindings[id] = voice;
    used.add(voice);
  }
  _saveVoiceBindings(bindings);
  return expertIds.map((id) => bindings[id]);
}

function getVoiceAssignments() {
  const appCfg = config.loadConfig();
  const key = (appCfg.voice || {}).doubaoKey || (((appCfg.models || {}).providers || {}).doubao || {}).apiKey || '';
  const ttsReady = Boolean(key && key.length > 8 && !key.includes('***'));
  return { pool: VOICE_POOL, bindings: _loadVoiceBindings(), ttsReady, provider: 'doubao' };
}

// ─── 会前实算数据简报（"先算准再喂"——经营分析会数字幻觉教训） ───────
// minimal 只读工具面的专家拿不到业务库，只能讲原则（实测"发言务虚"根因）。
// 开会前先从业务语义视图聚合核心数字，注入每条发言 prompt 并上屏，发言
// 要求：引用简报数字、禁止编造；无数据时降级为"定性声明"口径。

function _fmtWan(n) {
  const v = Number(n) || 0;
  return Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${Math.round(v)}`;
}

function _briefFromDb(db) {
  const lines = [];
  try {
    const agg = db.prepare('select count(*) c, sum(revenue) s, min(date) d0, max(date) d1 from v_sales').get();
    if (agg && agg.c > 0) {
      const topP = db.prepare('select product p, sum(revenue) s from v_sales where product is not null group by product order by s desc limit 3').all();
      const topC = db.prepare('select customer c, sum(revenue) s from v_sales where customer is not null group by customer order by s desc limit 3').all();
      lines.push(`· 销售：${agg.c} 笔营收记录（${agg.d0 || '?'} ~ ${agg.d1 || '?'}），累计 ${_fmtWan(agg.s)}；TOP 产品 ${topP.map((r) => `${r.p}(${_fmtWan(r.s)})`).join('、')}；TOP 客户 ${topC.map((r) => `${r.c}(${_fmtWan(r.s)})`).join('、')}`);
    }
  } catch (e) { /* 视图缺失跳过 */ }
  try {
    const agg = db.prepare('select count(*) c, sum(receivable) s, min(date) d0 from v_receivable').get();
    if (agg && agg.c > 0) {
      const topC = db.prepare('select customer c, sum(receivable) s from v_receivable where customer is not null group by customer order by s desc limit 3').all();
      lines.push(`· 应收：未清余额合计 ${_fmtWan(agg.s)}，${agg.c} 笔（最早 ${agg.d0 || '?'}，注意账龄）；欠款最多 ${topC.map((r) => `${r.c}(${_fmtWan(r.s)})`).join('、')}`);
    }
  } catch (e) { /* 跳过 */ }
  try {
    const agg = db.prepare('select count(*) c, sum(contract) s, max(date) d1 from v_contract').get();
    if (agg && agg.c > 0) {
      const topC = db.prepare('select customer c, sum(contract) s from v_contract where customer is not null group by customer order by s desc limit 3').all();
      lines.push(`· 合同：${agg.c} 笔合计 ${_fmtWan(agg.s)}（最近 ${agg.d1 || '?'}）；金额居前 ${topC.map((r) => `${r.c}(${_fmtWan(r.s)})`).join('、')}`);
    }
  } catch (e) { /* 跳过 */ }
  return lines;
}

/** 聚合业务语义视图 → 紧凑数据简报；无 better-sqlite3/无库/无数据一律返回 ''（降级定性口径） */
function collectDataBrief() {
  try {
    const Database = (() => { try { return require('better-sqlite3'); } catch { return null; } })();
    if (!Database) return '';
    // 业务库有两个历史落点：registry 常量(DATA_DIR/business) 与项目根 data/business——双候选自适应
    let registryDir = '';
    try { registryDir = require('../business-data-registry').BUSINESS_DIR || ''; } catch (e) { /* registry 不可用 */ }
    const candidates = [registryDir && path.join(registryDir, 'business.db'), path.join(config.DATA_DIR, '..', 'business', 'business.db')];
    for (const dbPath of candidates) {
      if (!dbPath || !fs.existsSync(dbPath)) continue;
      let db = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const lines = _briefFromDb(db);
        if (lines.length > 0) {
          return `【会场数据简报·实算于 ${new Date().toISOString().slice(0, 10)}，发言引用数字以此为准】\n${lines.join('\n')}`;
        }
      } catch (e) { console.warn('[Roundtable] 数据简报查询失败:', dbPath, e.message); } finally {
        try { if (db) db.close(); } catch (e) { /* 关闭失败忽略 */ }
      }
    }
  } catch (e) { console.warn('[Roundtable] 数据简报失败:', e.message); }
  return '';
}

/** 发言数字纪律：有简报→引用为准禁编造；无简报→定性声明禁估数 */
function _dataDiscipline(state) {
  if (state.dataBrief) {
    return `${state.dataBrief}\n数字纪律：论据必须引用简报中的具体数字；禁止编造简报之外的数字；简报没有的数据明确说"需要核实"，不许估。`;
  }
  return '数字纪律：当前会场无实算数据，判断须标注为定性分析，严禁编造任何具体数字。';
}

// ─── 选人（三模式） ────────────────────────────────────
function _expertBrief(e) {
  return { id: e.id, name: e.name, title: e.title || '', icon: e.icon || '', department: e.department || '', voiceStyle: e.voiceStyle || '' };
}

/**
 * 跨部门话题相关选人：复用 routeMessage 固定分档评分（关键词 vs 岗位名/别名/关键词表），
 * 主持取榜首；成员优先跨部门（每部门至多 2 席）保证视角多样性。
 */
function selectCrossRoster(goal) {
  const { routeMessage } = require('./index');
  let ranked = [];
  try { ranked = (routeMessage(String(goal || '')) || []).filter((r) => r && r.expertId); } catch (e) { /* 路由失败走兜底 */ }
  let experts = ranked.map((r) => getExpert(r.expertId)).filter((e) => e && e.status !== 'parked');
  // 兜底：评分不足时补内置经营班子（覆盖战略/财务/销售/人力视角）
  const fallbackIds = ['boss_cockpit', 'finance_advisor', 'sales_director', 'hr_manager', 'strategy-business-strategist'];
  for (const id of fallbackIds) {
    if (experts.length >= 1 + MAX_MEMBERS) break;
    const e = getExpert(id);
    if (e && !experts.some((x) => x.id === id)) experts.push(e);
  }
  if (experts.length === 0) throw new Error('未找到可用专家，无法召开圆桌会');
  const host = experts[0];
  const deptCount = {};
  if (host.department) deptCount[host.department] = 1;
  const members = [];
  for (const e of experts.slice(1)) {
    if (members.length >= MAX_MEMBERS) break;
    const c = deptCount[e.department] || 0;
    if (e.department && c >= 2) continue;
    if (e.department) deptCount[e.department] = c + 1;
    members.push(e);
  }
  return { host, members };
}

function selectRoster(params) {
  if (params.presetId) {
    const preset = getTeamPresets().find((p) => p.id === params.presetId);
    if (!preset) throw new Error(`班组不存在: ${params.presetId}`);
    const roster = preset.expertIds.map((id) => getExpert(id)).filter(Boolean);
    return { host: roster[0] || null, members: roster.slice(1, 1 + MAX_MEMBERS), departmentLabel: preset.label, mode: 'preset' };
  }
  if (params.department) {
    const dept = getDepartments().find((d) => d.id === params.department);
    if (!dept) throw new Error(`部门不存在: ${params.department}`);
    const roster = getAllExperts().filter((e) => e.department === dept.id && e.status !== 'parked')
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
    const host = roster.find((e) => e.id === dept.lead) || roster[0] || null;
    const members = roster.filter((e) => !host || e.id !== host.id).slice(0, MAX_MEMBERS);
    return { host, members, departmentLabel: dept.label, mode: 'department' };
  }
  const { host, members } = selectCrossRoster(params.goal);
  return { host, members, departmentLabel: null, mode: 'cross' };
}

// ─── 发言 prompt ───────────────────────────────────────
function _interventionsText(state) {
  if (!state.interventions || state.interventions.length === 0) return '';
  return state.interventions.map((i) => `【老板插话·必须重视】${i.text}`).join('\n') + '\n';
}

function statementPrompt(expert, state, round) {
  const role = `「${expert.name}」${expert.title ? `（${expert.title}）` : ''}`;
  if (round === 1) {
    return `【圆桌会议·第一轮】议题：「${state.goal}」。${state.host && state.host.id === expert.id ? '你是本次会议主持，先做简短开场并给出你的总体判断。' : '请发表你的开场立场。'}\n${_dataDiscipline(state)}\n内容结构：①核心判断 ②关键理由（有数据给数据，没有给逻辑）③一条可执行建议。\n要求：口播风格，80~200字，观点鲜明，直接输出说话内容——不要markdown符号、不要标题、不要客套、不要复述议题。`;
  }
  const others = (state.statements || [])
    .filter((s) => s.round === 1 && s.expertId !== expert.id && s.text && !s.failed)
    .map((s) => `【${s.expertName}】${s.text}`)
    .join('\n');
  return `【圆桌会议·第二轮】议题：「${state.goal}」。\n${_dataDiscipline(state)}\n第一轮各岗位发言：\n${others || '（第一轮发言缺失，请直接给收敛意见）'}\n${_interventionsText(state)}请以${role}的身份发表第二轮意见：回应与你判断不同的观点（可点名），坚持或修正你的立场，并给出收敛后的建议。他人引用的数字与简报不符时直接指出。\n要求：口播风格，80~200字，直接输出说话内容，不要markdown符号。`;
}

function synthesisPrompt(state) {
  const all = (state.statements || [])
    .filter((s) => s.text && !s.failed)
    .map((s) => `【第${s.round}轮·${s.expertName}】${s.text}`)
    .join('\n');
  return `【圆桌会议·收口】你是本次圆桌会议主持「${state.host ? state.host.name : '主持'}」。议题：「${state.goal}」。全部发言如下：\n${all}\n${_interventionsText(state)}${_dataDiscipline(state)}\n请形成会议收口，结论必须有数字支撑（引用简报），严格按以下结构输出（不要额外内容）：\n## 会议结论\n（共识、分歧、下一步方向，400字内，口播风格）\n## 任务清单\n（每行一条，格式：【负责人姓名】具体任务事项，2~6条；确实没有可执行任务就只写"无"）`;
}

/** 解析主持收口：## 会议结论 正文 + ## 任务清单 中的【负责人】任务 行 */
function parseConclusion(text) {
  const t = String(text || '');
  const idx = t.indexOf('任务清单');
  let conclusionText = idx >= 0 ? t.slice(0, idx) : t;
  conclusionText = conclusionText.replace(/#{1,6}\s*会议结论/g, '').replace(/#{1,6}/g, '').trim();
  const tasks = [];
  if (idx >= 0) {
    const section = t.slice(idx);
    const re = /【(.+?)】\s*([^\n【]+)/g;
    let m;
    while ((m = re.exec(section)) !== null) {
      const owner = m[1].trim();
      const task = m[2].trim().replace(/[。;；]+$/, '');
      if (task && task !== '无' && task.length >= 2) tasks.push({ owner, task });
    }
  }
  return { text: conclusionText || t.slice(0, 400), tasks: tasks.slice(0, 6) };
}

// ─── 执行器 ────────────────────────────────────────────
async function _runStatement(state, runner, expert, round, prompt) {
  broadcastEvent('roundtable:typing', {
    meetingId: state.meetingId, round, expertId: expert.id, expertName: expert.name,
  });
  const def = {
    goal: prompt,
    type: 'ANALYZE',
    toolProfile: 'minimal',
    maxIterations: 8,
    timeout: STATEMENT_TIMEOUT_MS,
    _expert: { id: expert.id, name: expert.name, systemPrompt: expert.systemPrompt || '' },
  };
  let result = null;
  try {
    const results = await Promise.race([
      Promise.resolve(runner([def], { parentAgentId: state.meetingId, concurrency: 1 })),
      new Promise((resolve) => setTimeout(() => resolve(null), STATEMENT_TIMEOUT_MS + 5000)),
    ]);
    result = Array.isArray(results) ? results[0] : null;
  } catch (err) {
    console.error('[Roundtable] 发言执行异常:', expert.id, err.message);
  }
  const ok = result && result.status !== 'failed' && result.status !== 'cancelled' && result.result;
  const statement = {
    seq: (state.statements || []).length + 1,
    round,
    expertId: expert.id,
    expertName: expert.name,
    icon: expert.icon || '',
    department: expert.department || '',
    voice: expert.voice || '',
    text: ok ? String(result.result).trim().slice(0, 1200) : '',
    failed: !ok,
    ts: Date.now(),
  };
  state.statements = state.statements || [];
  state.statements.push(statement);
  _save(state);
  broadcastEvent('roundtable:statement', { meetingId: state.meetingId, round, statement });
  return statement;
}

// ─── 纪要文档生成（层契约 R1 依赖反转，2026-09-20）──────────────
// core 不得上溯依赖 tools(document-tools)——生成体在 src/tools/roundtable-doc.js,
// 由 server.js 装配注入；未接线(如单测)时静默跳过。
let _docGenerator = null;

/** server.js 装配点：注入 tools 层的纪要生成器 generateRoundtableDoc(state)=>{name,path,size} */
function setRoundtableDocGenerator(fn) {
  _docGenerator = typeof fn === 'function' ? fn : null;
}

async function _generatePlanDoc(state) {
  // Jest 单测会跑真编排——文档产物只应出现在真实会议里（曾把"快闪会/复盘会"
  // 测试纪要写进真实 documents 目录，2026-09-20 用户检查文档时发现）。
  // 实测本仓 jest 环境里 JEST_WORKER 为 undefined（probe 验证），故以测试
  // 必设置的 CRABPAW_DATA_DIR（数据目录隔离）为主判据，JEST_WORKER 兜底。
  if (process.env.JEST_WORKER || process.env.CRABPAW_DATA_DIR) return null;
  if (!_docGenerator) return null;
  try {
    const doc = await Promise.resolve(_docGenerator(state));
    if (doc && doc.path) {
      state.document = doc;
      _save(state);
      broadcastEvent('roundtable:document', { meetingId: state.meetingId, document: doc });
    }
    return doc || null;
  } catch (err) {
    console.error('[Roundtable] 计划书生成失败:', err.message);
    return null;
  }
}

async function _orchestrate(state, runner) {
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt > TOTAL_DEADLINE_MS;
  try {
    // 第一轮：主持先开场，成员依次独立立场
    _setPhase(state, 'round1', 1);
    const r1Roster = [state.host, ...(state.members || [])].filter(Boolean);
    for (const expert of r1Roster) {
      if (expired()) break;
      await _runStatement(state, runner, expert, 1, statementPrompt(expert, state, 1));
    }
    const r1Ok = (state.statements || []).filter((s) => s.round === 1 && !s.failed);
    if (r1Ok.length === 0) throw new Error('第一轮全部发言失败');

    // 第二轮：成员交锋对齐（含老板插话回看）
    _setPhase(state, 'round2', 2);
    for (const expert of state.members || []) {
      if (expired()) break;
      await _runStatement(state, runner, expert, 2, statementPrompt(expert, state, 2));
    }

    // 主持收口：结论 + 任务清单
    _setPhase(state, 'synthesis', 3);
    const hostExpert = getExpert(state.host.id) || state.host;
    const synth = await _runStatement(state, runner, { ...hostExpert, voice: state.host.voice }, 3, synthesisPrompt(state));
    if (!synth || synth.failed) throw new Error('主持收口失败');
    state.conclusion = parseConclusion(synth.text);
    _save(state);
    broadcastEvent('roundtable:conclusion', { meetingId: state.meetingId, conclusion: state.conclusion });

    // 任务清单的承载：对话流收口消息 + 纪要文档任务表（双处已在）。
    // 2026-09-20: 不再建 TaskOrbit 泳道——静态 lane 无执行方谈不上跟踪,
    // 且窄栏渲染一字长蛇（用户实测"有必要出现吗"）；与部门例会砍 TaskRun 同理。
    // 后续若要"任务到期提醒"，走 LoopX 提醒系统而非静态看板。

    // 收口三件套之三：计划书文档
    _setPhase(state, 'document', 3);
    await _generatePlanDoc(state);

    _setPhase(state, 'done');
    state.finishedAt = Date.now();
    _save(state);
    const { recordActivity } = require('./collaboration');
    recordActivity({ type: 'collab:completed', content: `圆桌会「${String(state.goal).slice(0, 60)}」完成（${state.statements.length} 条发言${state.document ? '，纪要已生成' : ''}）` });
    broadcastEvent('roundtable:ended', {
      meetingId: state.meetingId, status: 'done',
      statementCount: state.statements.length,
      taskCount: state.conclusion ? state.conclusion.tasks.length : 0,
      document: state.document,
    });
  } catch (err) {
    console.error('[Roundtable] 会议编排异常:', err);
    state.phase = 'error';
    state.error = err.message;
    state.finishedAt = Date.now();
    _save(state);
    broadcastEvent('roundtable:error', { meetingId: state.meetingId, message: err.message });
    broadcastEvent('roundtable:ended', { meetingId: state.meetingId, status: 'error', error: err.message });
  }
}

// ─── 公共 API ──────────────────────────────────────────
function findRunning() {
  for (const [, s] of _roundtables) {
    if (!['done', 'error'].includes(s.phase)) return s;
  }
  return null;
}

/**
 * 召开圆桌会
 * @param {{goal: string, presetId?: string, department?: string, sessionId?: string}} params
 * @param {{runner?: Function}} opts
 */
async function startRoundtable(params, opts = {}) {
  const goal = String(params.goal || '').trim().slice(0, 80);
  if (!goal) throw new Error('缺少会议议题 goal');

  // 单例闸：同时只允许一场进行中圆桌
  const running = findRunning();
  if (running) {
    return { meetingId: running.meetingId, goal: running.goal, alreadyRunning: true, host: running.host, members: running.members };
  }

  const { host, members, departmentLabel, mode } = selectRoster({ ...params, goal });
  if (!host && members.length === 0) throw new Error('无可用专家，无法召开圆桌会');

  const voiceIds = [host, ...members].filter(Boolean).map((e) => e.id);
  const voices = assignVoices(voiceIds);
  const voiceOf = {};
  voiceIds.forEach((id, i) => { voiceOf[id] = voices[i]; });

  const meetingId = `rt_${crypto.randomBytes(4).toString('hex')}`;
  const decorate = (e) => ({ ..._expertBrief(e), voice: voiceOf[e.id] || '' });
  const dataBrief = collectDataBrief();
  const state = {
    meetingId,
    goal,
    mode,
    departmentLabel,
    host: host ? decorate(host) : null,
    members: members.map(decorate),
    round: 1,
    phase: 'roster',
    dataBrief,
    statements: [],
    interventions: [],
    conclusion: null,
    document: null,
    sessionId: opts.sessionId || null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  _roundtables.set(meetingId, state);
  _save(state);
  if (state.sessionId) _recentStarts.set(state.sessionId, state.startedAt);

  const { recordActivity } = require('./collaboration');
  recordActivity({ type: 'collab:started', content: `召开圆桌会「${goal.slice(0, 60)}」（主持 ${state.host ? state.host.name : '—'} + ${state.members.length} 席${dataBrief ? '，数据简报已备' : '，无实算数据（定性口径）'}）` });
  broadcastEvent('roundtable:started', {
    meetingId, goal, mode, departmentLabel, host: state.host, members: state.members,
    ttsReady: getVoiceAssignments().ttsReady,
  });
  // 数据简报上屏（透明过程的一部分：老板能看到专家们引用的数字从哪来）
  if (dataBrief) broadcastEvent('roundtable:brief', { meetingId, text: dataBrief });

  const runner = opts.runner || require('../subagent-enhanced').delegateTasks;
  setImmediate(() => { _orchestrate(state, runner); });

  return { meetingId, goal, mode, departmentLabel, host: state.host, members: state.members };
}

/** 老板插话：会中生效，进入后续所有发言者的 prompt */
function interveneRoundtable(meetingId, text) {
  const state = _loadState(String(meetingId || ''));
  if (!state) return { ok: false, reason: 'not_found' };
  if (['done', 'error'].includes(state.phase)) return { ok: false, reason: 'meeting_ended' };
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) return { ok: false, reason: 'empty' };
  state.interventions = state.interventions || [];
  state.interventions.push({ seq: state.interventions.length + 1, text: clean, ts: Date.now() });
  _save(state);
  broadcastEvent('roundtable:intervention', { meetingId, intervention: state.interventions[state.interventions.length - 1] });
  return { ok: true, seq: state.interventions.length };
}

function getRoundtable(meetingId) {
  const state = _loadState(String(meetingId || ''));
  if (!state) return null;
  return {
    meetingId: state.meetingId, goal: state.goal, mode: state.mode, departmentLabel: state.departmentLabel,
    host: state.host, members: state.members, round: state.round, phase: state.phase,
    statements: state.statements, interventions: state.interventions,
    conclusion: state.conclusion, document: state.document,
    startedAt: state.startedAt, finishedAt: state.finishedAt, error: state.error,
  };
}

function listRoundtables(limit = 20) {
  try {
    _ensureDirs();
    return fs.readdirSync(RT_DIR)
      .filter((f) => /^rt_.+\.json$/.test(f))
      .sort().reverse()
      .slice(0, limit)
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(RT_DIR, f), 'utf-8'));
          return { meetingId: s.meetingId, goal: s.goal, phase: s.phase, startedAt: s.startedAt, finishedAt: s.finishedAt };
        } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

// ─── 聊天意图自动触发 ──────────────────────────────────
const ROUNDTABLE_PATTERNS = [
  /圆桌(会|会议|讨论)/,
  /(?:专家|员工|团队|班子|高管|大家).{0,10}(?:开个?会|碰个会|开个碰头会|开个讨论会|开个圆桌)/,
  /开个?会.{0,12}(?:讨论|商量|评估|议一议)/,
  /(?:把|请|让|叫).{0,8}(?:专家|员工|团队|各部门).{0,8}(?:叫来|召集|聚一下|开个会|碰一下)/,
  // 2026-09-21 用户实测补漏: "召开专家会议"此前未命中(正则只认"开会"字样),
  // 落入普通 chat 由 LLM 触发老例会——纪要弹文档卡+单音色播报, 与圆桌体验割裂。
  // "召开/召集+会议"句式收窄到动词开头, "会议纪要/日程"等名词短语不误触。
  /(?:召开|召集|组织).{0,8}(?:专家|高管|团队|部门|核心)?(?:会议|例会|圆桌)/,
  /(?:专家|高管)(?:会议|例会)/,
];

function isRoundtableIntent(message) {
  const msg = String(message || '');
  return ROUNDTABLE_PATTERNS.some((p) => p.test(msg));
}

/** 从消息中提取议题：优先「讨论/评估/商量 X」句式，否则整句截断 */
function extractGoal(message) {
  const msg = String(message || '').trim();
  let m = msg.match(/(?:讨论|商量|评估|评审|议一议|聊聊)[「『"']?(.{2,60}?)[」』"']?[。.！!？?\s]*$/);
  if (m && m[1].trim()) return m[1].trim();
  m = msg.match(/关于(.{2,60}?)(?:开个?会|碰个会|圆桌)/);
  if (m && m[1].trim()) return m[1].trim();
  return msg.slice(0, 60);
}

function hasRecentRoundtable(sessionId) {
  if (!sessionId) return false;
  const ts = _recentStarts.get(sessionId);
  return Boolean(ts && Date.now() - ts < RECENT_WINDOW_MS);
}

/**
 * 聊天链路自动触发（chat-handler 在 auto-collab 之前调用）。
 * 命中圆桌意图 → 召开会议并返回句柄（调用方负责在回复里告知用户）。
 */
async function maybeAutoStartRoundtable(userId, message, opts = {}) {
  if (!isRoundtableIntent(message)) return null;
  if (hasRecentRoundtable(userId)) {
    console.log('[Roundtable] 同会话近期已开会,跳过自动触发');
    return null;
  }
  const running = findRunning();
  if (running) {
    console.log('[Roundtable] 已有进行中圆桌,返回既有会议:', running.meetingId);
    return { meetingId: running.meetingId, goal: running.goal, alreadyRunning: true, host: running.host, members: running.members };
  }
  const goal = extractGoal(message);
  try {
    const r = await startRoundtable({ goal, sessionId: userId || null }, { runner: opts.runner });
    console.log('🗣️ [Roundtable] 自动召开圆桌会:', r.meetingId, '主持:', r.host && r.host.name);
    return r;
  } catch (e) {
    console.warn('[Roundtable] 自动召开失败(不影响聊天):', e.message);
    return null;
  }
}

module.exports = {
  startRoundtable, getRoundtable, listRoundtables, interveneRoundtable,
  getVoiceAssignments, assignVoices, findRunning, setRoundtableDocGenerator,
  isRoundtableIntent, extractGoal, maybeAutoStartRoundtable,
  parseConclusion, statementPrompt, synthesisPrompt, selectRoster,
  collectDataBrief,
  VOICE_POOL, MAX_MEMBERS,
};
