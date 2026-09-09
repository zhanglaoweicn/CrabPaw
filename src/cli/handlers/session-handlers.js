/**
 * 会话管理处理器 - 从 request-handler.js 提取
 *
 * 处理会话的 CRUD、搜索、清理等 API 请求
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 创建会话管理处理器集合
 * @param {Function} sendJson - JSON 响应发送函数
 * @returns {Object} 会话管理处理器映射
 */
function createSessionHandlers(sendJson) {
  return {
    async handleSessions(req, res, ctx) {
      const userId = ctx.url.searchParams.get('userId') || 'default';
      const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10);
      const keyword = ctx.url.searchParams.get('keyword') || '';
      const projectId = ctx.url.searchParams.get('projectId') || '';

      try {
        const sessionPersistence = ctx.sessionManager?.persistence;
        if (!sessionPersistence) {
          return sendJson(res, 200, { success: true, sessions: [], total: 0 });
        }

        let sessions;
        if (keyword) {
          sessions = await sessionPersistence.findSessionByKeyword(keyword, userId);
        } else {
          sessions = await sessionPersistence.getUserSessions(userId, { limit });
        }

        // 扫描磁盘文件，补充索引中缺失的会话（带缓存，避免每次请求都扫描）
        const sessionsDir = sessionPersistence.sessionsDir;
        const now = Date.now();
        if (!sessionPersistence._diskScanCache || now - (sessionPersistence._diskScanCache.time || 0) > 300000) {
          const indexedIds = new Set(sessions.map(s => s.sessionId));
          try {
            const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith('sess_') && f.endsWith('.json'));
            for (const file of files) {
              const sid = file.replace('.json', '');
              if (!indexedIds.has(sid)) {
                try {
                  const fileData = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
                  const fileMsgs = (fileData.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
                  if (fileMsgs.length > 0) {
                    const meta = {
                      sessionId: sid,
                      userId: fileData.userId || userId,
                      createdAt: fileData.createdAt || Date.now(),
                      lastAccessed: fileData.updatedAt || fileData.savedAt || Date.now(),
                      messageCount: fileMsgs.length,
                      projectId: fileData.projectId || null,
                      title: fileData.title || null,
                      summary: {
                        firstMessage: fileMsgs[0].content?.substring(0, 100) || '',
                        lastMessage: fileMsgs[fileMsgs.length - 1].content?.substring(0, 100) || '',
                        messageCount: fileMsgs.length,
                        createdAt: fileData.createdAt || Date.now(),
                      },
                    };
                    sessions.push(meta);
                    indexedIds.add(sid);
                    await sessionPersistence.registerSession(sid, meta.userId, { projectId: meta.projectId, title: meta.title });
                    await sessionPersistence.updateSessionMeta(sid, {
                      messageCount: meta.messageCount,
                      summary: meta.summary,
                      projectId: meta.projectId,
                      title: meta.title,
                    }, meta.userId);
                  }
                } catch (e) { console.warn('[session-handlers] failed to save session metadata:', e.message); }
              }
            }
          } catch (e) { console.warn('[session-handlers] session cleanup exception:', e.message); }
          sessionPersistence._diskScanCache = { time: now };
        }

        const invalidSessionIds = [];
        const indexUpdates = [];
        const needGhostCheck = !sessionPersistence._diskScanCache || (Date.now() - (sessionPersistence._diskScanCache.time || 0) < 300000);
        sessions = sessions.filter(s => {
          if (!needGhostCheck) return true;
          const sessionPath = path.join(sessionPersistence.sessionsDir, `${s.sessionId}.json`);
          if (!fs.existsSync(sessionPath)) {
            invalidSessionIds.push(s.sessionId);
            return false;
          }
          if (s.messageCount === 0 && (!s.summary || !s.summary.firstMessage)) {
            // 新创建的空会话（1小时内）不视为幽灵会话，跳过检查
            const ageMs = Date.now() - (s.createdAt || 0);
            if (ageMs < 3600000) return true;
            try {
              const fileData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
              const fileMsgs = (fileData.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
              if (fileMsgs.length > 0) {
                s.messageCount = fileMsgs.length;
                s.summary = {
                  firstMessage: fileMsgs[0].content?.substring(0, 100) || '',
                  lastMessage: fileMsgs[fileMsgs.length - 1].content?.substring(0, 100) || '',
                  messageCount: fileMsgs.length,
                  createdAt: fileData.createdAt || s.createdAt,
                };
                indexUpdates.push(s);
                return true;
              }
              // 2026-08-14 数据链审计 I3: 磁盘仍为空但运行期内存有消息(防抖落盘窗口内)
              // → 非幽灵会话:保留索引并触发显式落盘,防止误删活跃会话数据。
              try {
                const { memoryManager: runtimeMemory } = require('../../../core/memory-system');
                const runtimeSession = runtimeMemory?.sessions?.get(s.sessionId);
                if (runtimeSession && runtimeSession.messages?.length > 0) {
                  runtimeMemory.flushSession(s.sessionId, userId).catch(e2 =>
                    console.warn('[session-handlers] 运行期会话落盘失败:', e2?.message)
                  );
                  s.messageCount = runtimeSession.messages.length;
                  indexUpdates.push(s);
                  return true;
                }
              } catch (e) { console.warn('[session-handlers] 运行期会话检查失败:', e.message); }
            } catch (e) { console.warn('[session-handlers] failed to read session file:', e.message); }
            invalidSessionIds.push(s.sessionId);
            return false;
          }
          return true;
        });

        for (const s of indexUpdates) {
          await sessionPersistence.updateSessionMeta(s.sessionId, {
            messageCount: s.messageCount,
            summary: s.summary,
          }, userId);
        }

        for (const sid of invalidSessionIds) {
          try {
            const sessionPath = path.join(sessionPersistence.sessionsDir, `${sid}.json`);
            if (fs.existsSync(sessionPath)) {
              fs.unlinkSync(sessionPath);
            }
            if (sessionPersistence._userIndex) {
              // eslint-disable-next-line no-unused-vars
            for (const [uid, userSessions] of sessionPersistence._userIndex.entries()) {
                const idx = userSessions.findIndex(s => s.sessionId === sid);
                if (idx !== -1) {
                  userSessions.splice(idx, 1);
                }
              }
            }
            if (sessionPersistence._sessions) {
              sessionPersistence._sessions.delete(sid);
            }
            if (sessionPersistence._sessionCache) {
              sessionPersistence._sessionCache.delete(sid);
            }
          } catch (e) { console.warn('[session-handlers] failed to clean up invalid session:', e.message); }
        }

        if (invalidSessionIds.length > 0 && sessionPersistence._userIndex) {
          await sessionPersistence._saveUserIndex();
        }

        // 按项目过滤（兼容旧会话：旧会话无 projectId 字段）
        // 当指定 projectId 时，只返回属于该项目的会话
        // 旧会话（无 projectId）在项目视图中不显示，在"所有对话"视图中正常显示
        if (projectId) {
          sessions = sessions.filter(s => s.projectId === projectId);
        }

        // total 必须返回真实总数（limit 之前的数量），否则前端卡片会卡在 limit 上限
        // 注意：分页场景下应基于"全量过滤后"再 limit，前端才能用 total 渲染正确的「总会话数」
        // 注意：await 必须放在 countUserSessions(...) 调用上（不能在三元外层），
        // 否则三元右侧会返回未 await 的 Promise，JSON.stringify(Promise) === "{}"
        const totalAll = sessionPersistence.countUserSessions
          ? await sessionPersistence.countUserSessions(userId, { projectId })
          : sessions.length; // 兜底：没有统计方法时至少给出本次返回的长度
        sendJson(res, 200, { success: true, sessions, total: totalAll });
      } catch (e) {
        console.error('[session-handlers] handleSessions error:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleSessionDetail(req, res, ctx) {
      const sessionId = ctx.url.searchParams.get('sessionId');

      if (!sessionId) {
        return sendJson(res, 400, { success: false, message: '缺少 sessionId' });
      }

      try {
        const sessionPersistence = ctx.sessionManager?.persistence;
        if (!sessionPersistence) {
          return sendJson(res, 404, { success: false, message: '会话持久化未初始化' });
        }

        const sessionData = await sessionPersistence.loadSession(sessionId);
        if (!sessionData) {
          return sendJson(res, 404, { success: false, message: '会话不存在' });
        }

        sendJson(res, 200, { success: true, session: sessionData });
      } catch (e) {
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleSessionSearch(req, res, ctx) {
      const keyword = ctx.url.searchParams.get('keyword') || '';
      const userId = ctx.url.searchParams.get('userId') || 'default';

      if (!keyword) {
        return sendJson(res, 400, { success: false, message: '缺少 keyword 参数' });
      }

      try {
        const sessionPersistence = ctx.sessionManager?.persistence;
        if (!sessionPersistence) {
          return sendJson(res, 200, { success: true, results: [], total: 0 });
        }

        const results = await sessionPersistence.findSessionByKeyword(keyword, userId);
        sendJson(res, 200, { success: true, results, total: results.length });
      } catch (e) {
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleSessionDelete(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const sessionId = pathname.replace('/api/sessions/', '');

      if (!sessionId) {
        return sendJson(res, 400, { success: false, message: '缺少 sessionId' });
      }

      try {
        const sessionPersistence = ctx.sessionManager?.persistence;
        if (sessionPersistence) {
          const sessionPath = path.join(sessionPersistence.sessionsDir, `${sessionId}.json`);
          if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
          }

          if (sessionPersistence._userIndex) {
            // eslint-disable-next-line no-unused-vars
            for (const [userId, sessions] of sessionPersistence._userIndex.entries()) {
              const idx = sessions.findIndex(s => s.sessionId === sessionId);
              if (idx !== -1) {
                sessions.splice(idx, 1);
              }
            }
            await sessionPersistence._saveUserIndex();
          }
          if (sessionPersistence._sessions) {
            sessionPersistence._sessions.delete(sessionId);
          }
          if (sessionPersistence._sessionCache) {
            sessionPersistence._sessionCache.delete(sessionId);
          }

          if (ctx.sessionManager && ctx.sessionManager._sessions) {
            ctx.sessionManager._sessions.delete(sessionId);
          }
        }

        sendJson(res, 200, { success: true, message: '会话已删除' });
      } catch (e) {
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleSessionCreate(req, res, ctx) {
      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { console.error('[session-handlers] JSON parse error:', e.message); resolve({}); } });
          req.on('error', reject);
        });

        const sessionId = body.sessionId || `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const userId = body.userId || 'default';
        const title = body.title || '';
        const projectId = body.projectId || null;
        console.debug('[session-handlers] 创建会话:', { sessionId, userId, projectId, bodyKeys: Object.keys(body) });

        const sessionPersistence = ctx.sessionManager?.persistence;
        if (sessionPersistence) {
          await sessionPersistence.registerSession(sessionId, userId, { projectId, title });
          if (title) {
            await sessionPersistence.updateSessionMeta(sessionId, { title }, userId);
          }
          if (projectId) {
            await sessionPersistence.updateSessionMeta(sessionId, { projectId }, userId);
          }
          await sessionPersistence.saveSession(sessionId, {
            messages: [],
            createdAt: Date.now(),
            title,
            projectId,
          }, userId);
        }

        sendJson(res, 200, { success: true, sessionId });
      } catch (e) {
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleSessionUpdate(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const sessionId = pathname.replace('/api/sessions/', '');

      if (!sessionId) {
        return sendJson(res, 400, { success: false, message: '缺少 sessionId' });
      }

      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { console.error('[session-handlers] JSON parse error:', e.message); resolve({}); } });
          req.on('error', reject);
        });

        const sessionPersistence = ctx.sessionManager?.persistence;
        if (!sessionPersistence) {
          return sendJson(res, 404, { success: false, message: '会话持久化未初始化' });
        }

        const existing = await sessionPersistence.loadSession(sessionId) || {};
        const updated = {
          ...existing,
          ...body,
          sessionId,
          updatedAt: Date.now(),
        };

        const userId = body.userId || 'default';
        await sessionPersistence.saveSession(sessionId, updated, userId);

        const msgs = Array.isArray(updated.messages) ? updated.messages : [];
        const userMsgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
        const summary = userMsgs.length > 0 ? {
          firstMessage: userMsgs[0].content?.substring(0, 100) || '',
          lastMessage: userMsgs[userMsgs.length - 1].content?.substring(0, 100) || '',
          messageCount: userMsgs.length,
          createdAt: updated.createdAt || Date.now(),
        } : null;

        await sessionPersistence.registerSession(sessionId, userId, { title: updated.title, projectId: updated.projectId });
        const metaUpdate = {
          messageCount: userMsgs.length,
          summary,
        };
        if (updated.title) {
          metaUpdate.title = updated.title;
        }
        await sessionPersistence.updateSessionMeta(sessionId, metaUpdate, userId);

        sendJson(res, 200, { success: true, sessionId });
      } catch (e) {
        sendJson(res, 500, { success: false, message: e.message });
      }
    },
  };
}

module.exports = { createSessionHandlers };
