const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')


const SILENCE_THRESHOLD_MS = 2 * 60 * 60 * 1000
const BURST_THRESHOLD = 10
const BURST_WINDOW_MS = 5 * 60 * 1000

class UserBehaviorSensor {
  constructor() {
    this._activities = []
    this._userProfiles = new Map()
    this._maxActivities = 5000
    this._interval = null
    this._running = false
    this._silenceThresholdMs = SILENCE_THRESHOLD_MS
    this._burstThreshold = BURST_THRESHOLD
  }

  setSilenceThreshold(ms) {
    this._silenceThresholdMs = ms
  }

  setBurstThreshold(threshold) {
    this._burstThreshold = threshold
  }

  start(intervalMs = 5 * 60 * 1000) {
    if (this._interval) return

    this._running = true
    this._interval = setInterval(() => this._analyze(), intervalMs)
    if (this._interval.unref) this._interval.unref()

    console.log('👤 用户行为感知器已启动')
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    this._running = false
  }

  recordActivity(userId, activity) {
    const record = {
      userId,
      type: activity.type || 'message',
      timestamp: Date.now(),
      detail: activity.detail || '',
      channel: activity.channel || 'unknown',
      topic: activity.topic || null,
      domain: activity.domain || null,
    }

    this._activities.push(record)
    if (this._activities.length > this._maxActivities) {
      this._activities = this._activities.slice(-this._maxActivities / 2)
    }

    this._updateUserProfile(userId, record)
    this._detectBurst(userId)
  }

  _updateUserProfile(userId, record) {
    let profile = this._userProfiles.get(userId)
    if (!profile) {
      profile = {
        userId,
        firstSeen: record.timestamp,
        lastActivity: record.timestamp,
        totalActivities: 0,
        channels: new Set(),
        topics: new Map(),
        domains: new Map(),
        activeHours: new Array(24).fill(0),
        dailyActivity: new Map(),
      }
      this._userProfiles.set(userId, profile)
    }

    profile.lastActivity = record.timestamp
    profile.totalActivities++
    profile.channels.add(record.channel)

    if (record.topic) {
      profile.topics.set(record.topic, (profile.topics.get(record.topic) || 0) + 1)
    }
    if (record.domain) {
      profile.domains.set(record.domain, (profile.domains.get(record.domain) || 0) + 1)
    }

    const hour = new Date(record.timestamp).getHours()
    profile.activeHours[hour]++

    const dayKey = new Date(record.timestamp).toISOString().slice(0, 10)
    profile.dailyActivity.set(dayKey, (profile.dailyActivity.get(dayKey) || 0) + 1)

    if (profile.dailyActivity.size > 90) {
      const oldest = [...profile.dailyActivity.keys()].sort()[0]
      profile.dailyActivity.delete(oldest)
    }
  }

  _detectBurst(userId) {
    const now = Date.now()
    const recent = this._activities.filter(
      a => a.userId === userId && now - a.timestamp < BURST_WINDOW_MS
    )

    if (recent.length >= this._burstThreshold) {
      globalSignalBus.emit({
        type: 'user_burst_activity',
        source: `user:${userId}`,
        severity: SIGNAL_SEVERITY.INFO,
        detail: `用户 ${userId} 在 ${BURST_WINDOW_MS / 1000}s 内有 ${recent.length} 次活动`,
        metrics: { activityCount: recent.length, windowMs: BURST_WINDOW_MS },
      })
    }
  }

  _analyze() {
    const now = Date.now()

    for (const [userId, profile] of this._userProfiles) {
      const silenceDuration = now - profile.lastActivity

      if (silenceDuration > this._silenceThresholdMs && profile.totalActivities > 5) {
        globalSignalBus.emit({
          type: 'user_silence',
          source: `user:${userId}`,
          severity: SIGNAL_SEVERITY.INFO,
          detail: `用户 ${userId} 已沉默 ${Math.round(silenceDuration / 60000)} 分钟`,
          metrics: { silenceDurationMs: silenceDuration, lastActivity: profile.lastActivity },
        })
      }

      if (profile.topics.size > 0) {
        const sortedTopics = [...profile.topics.entries()].sort((a, b) => b[1] - a[1])
        const topTopic = sortedTopics[0]
        if (topTopic && topTopic[1] >= 3) {
          globalSignalBus.emit({
            type: 'user_topic_trend',
            source: `user:${userId}`,
            severity: SIGNAL_SEVERITY.INFO,
            detail: `用户 ${userId} 频繁关注: ${topTopic[0]} (${topTopic[1]} 次)`,
            metrics: { topic: topTopic[0], count: topTopic[1] },
          })
        }
      }

      if (profile.domains.size > 0) {
        const sortedDomains = [...profile.domains.entries()].sort((a, b) => b[1] - a[1])
        const topDomain = sortedDomains[0]
        if (topDomain && topDomain[1] >= 3) {
          globalSignalBus.emit({
            type: 'user_domain_focus',
            source: `user:${userId}`,
            severity: SIGNAL_SEVERITY.INFO,
            detail: `用户 ${userId} 频繁使用领域: ${topDomain[0]}`,
            metrics: { domain: topDomain[0], count: topDomain[1] },
          })
        }
      }

      const peakHour = profile.activeHours.indexOf(Math.max(...profile.activeHours))
      if (profile.totalActivities > 10) {
        globalSignalBus.emit({
          type: 'user_active_pattern',
          source: `user:${userId}`,
          severity: SIGNAL_SEVERITY.INFO,
          detail: `用户 ${userId} 活跃高峰: ${peakHour}:00`,
          metrics: { peakHour, totalActivities: profile.totalActivities },
        })
      }
    }
  }

  getUserProfile(userId) {
    const profile = this._userProfiles.get(userId)
    if (!profile) return null

    return {
      userId: profile.userId,
      firstSeen: profile.firstSeen,
      lastActivity: profile.lastActivity,
      totalActivities: profile.totalActivities,
      channels: [...profile.channels],
      topTopics: [...profile.topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      topDomains: [...profile.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      peakHour: profile.activeHours.indexOf(Math.max(...profile.activeHours)),
      activeHours: profile.activeHours,
    }
  }

  getAllUserProfiles() {
    return this._userProfiles
  }

  getStatus() {
    return {
      running: this._running,
      totalUsers: this._userProfiles.size,
      totalActivities: this._activities.length,
    }
  }
}

const globalUserBehaviorSensor = new UserBehaviorSensor()

module.exports = {
  UserBehaviorSensor,
  globalUserBehaviorSensor,
}
