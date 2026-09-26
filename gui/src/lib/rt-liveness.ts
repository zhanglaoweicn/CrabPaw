/**
 * rt-liveness — 实时语音通道「判活」纯函数（2026-09-25 实测轮）
 *
 * 背景（实机日志证据，2026-09-25 16:50-16:53）：
 *   用户在实时通道问「最近有没有台风？」→ 后端委托给主链路（跑 ShowTyphoon 需抓政府
 *   数据源，10-25s）→ 这段时间豆包**本来就不该有下行**（它在等主链路答案）。但旧
 *   看门狗只看「用户说过话 + 豆包 20s 没下行」就判假死并强拆重连——实测动作时刻
 *   08:52:26.99 比 ShowTyphoon 实际执行(08:52:28.11)**早 1.1 秒**，等于在答案快好时
 *   把会话拆了，答案只能等重连后再补播，用户体感「没反应、要等一会才有反应」。
 *
 * 本模块把三个判定抽成纯函数（便于单测，与 voice-orb-state / orb-dynamics 同风格）：
 *   ① decideRtReconnect —— 推断式判活（保底网）。委托进行中给长阈值，不误杀等待期。
 *   ② shouldReplaySpeakText —— 断线续播去重（同一段文本最多重念一次）。
 *   ③ shouldSendPing / isPongTimedOut —— 协议层心跳判活（真死连接直接探测，
 *      不再靠「没听见话」间接猜）。
 */

/** 推断式判活阈值（无委托在途时）：用户说完且豆包下行静默超过此值 → 判假死 */
export const RT_HALFOPEN_MS = 20000
/** 委托在途时的长阈值——主链路跑工具+模型可长达数十秒，静默属正常（本次实测 20s 会误杀） */
export const RT_HALFOPEN_PENDING_MS = 120000
/** 委托在途标记的最长有效期——超时视为异常/丢失，不再豁免（防永久豁免） */
export const RT_DELEGATION_MAX_MS = 180000
/** 用户「开过口」的认定窗口（与旧逻辑一致） */
export const RT_SPOKE_WINDOW_MS = 60000
/** 认定「已停口」的最小静默（避免把正常停顿当说完） */
export const RT_STOPPED_MS = 3000
/** 协议层心跳发送间隔 */
export const RT_PING_INTERVAL_MS = 5000
/**
 * 连续「发出但没等到回包」的心跳数上限——达到即判链路半开。
 * 用计数而非时间差: 看门狗循环在 TTS 挂起/session 非活跃时会整体暂停, 恢复后
 * 「距上次回包的时间」会凭空变大 → 误判超时。计数只在循环真正运行时累加,
 * 天然免疫暂停(本项在自查时发现并修掉)。
 */
export const RT_MISSED_PONG_LIMIT = 3

export interface RtReconnectInput {
  /** 当前时刻 */
  now: number
  /** 最近一次「真正发出去」的人声帧时刻（0=从未）——注意不是本地采集到人声的时刻：
   *  播报期间客户端静音不上行，本地照样能听到自己在说，用它判活会制造假阳性 */
  lastLoudSentTs: number
  /** 最近一次收到豆包下行帧的时刻 */
  lastInboundTs: number
  /** 委托在途的起始时刻（0=无） */
  delegationSince: number
  /** 是否已有重连在排队（防重复触发） */
  reconnectScheduled: boolean
}

/**
 * 实时通道是否需要强制重连（推断式，保底网）。
 * 返回 null 表示无需动作；否则返回原因（供日志）。
 */
export function decideRtReconnect(input: RtReconnectInput): string | null {
  const { now, lastLoudSentTs, lastInboundTs, delegationSince, reconnectScheduled } = input
  if (reconnectScheduled) return null
  if (!lastLoudSentTs) return null // 从未上行过人声 → 无判据，保持沉默
  const spokeRecently = now - lastLoudSentTs < RT_SPOKE_WINDOW_MS
  const stoppedSpeaking = now - lastLoudSentTs > RT_STOPPED_MS
  if (!spokeRecently || !stoppedSpeaking) return null
  const pending = isDelegationPending(delegationSince, now)
  const threshold = pending ? RT_HALFOPEN_PENDING_MS : RT_HALFOPEN_MS
  const sinceInbound = now - lastInboundTs
  if (sinceInbound <= threshold) return null
  const secs = Math.round(sinceInbound / 1000)
  return pending
    ? `豆包下行 ${secs}s 无帧（委托在途已超长阈值，判真死）`
    : `用户已说话但豆包下行 ${secs}s 无帧`
}

/** 委托是否在途（含超时失效——防止异常路径下永久豁免） */
export function isDelegationPending(delegationSince: number, now: number): boolean {
  if (!delegationSince) return false
  return now - delegationSince < RT_DELEGATION_MAX_MS
}

/**
 * 断线续播是否应该重念。
 * 同一段文本最多重念一次：旧逻辑只记 done，而 done 依赖服务端 audio_end——
 * 会话被强拆时 audio_end 丢失，重连就把**已经念完**的同一句反复重念（实测
 * 「明天海口是晴天」被念了 3 遍）。replayedText 记录已重念过的文本即可收敛。
 */
export function shouldReplaySpeakText(input: {
  everReady: boolean
  text: string
  done: boolean
  replayedText: string
}): boolean {
  const { everReady, text, done, replayedText } = input
  if (!everReady) return false
  if (!text || done) return false
  return replayedText !== text
}

/** 是否该发心跳（WS 在线时按间隔发） */
export function shouldSendPing(now: number, lastPingTs: number): boolean {
  return now - lastPingTs >= RT_PING_INTERVAL_MS
}

/**
 * 心跳是否判为链路半开。
 * 只在「发过心跳但连续多个没回包」时成立——没发过就不能据此判死。
 * 注意用计数(见 RT_MISSED_PONG_LIMIT 注释), 不看时间差。
 */
export function isPongTimedOut(pendingPings: number, limit: number = RT_MISSED_PONG_LIMIT): boolean {
  return pendingPings >= limit
}
