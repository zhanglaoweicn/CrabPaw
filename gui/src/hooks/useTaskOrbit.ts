import { useMemo, useRef, useState } from 'react';
import { useSse } from './useSSE';
import { notify, type Notice } from '../lib/notices';

export interface TaskLane {
  id: string;
  agent: string;
  stage: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  progress: number;
}

export interface TaskArtifact {
  id: string;
  name: string;
  path?: string;
}

export interface TaskRun {
  taskId: string;
  title: string;
  source: string;
  skill?: string | null;
  capability?: string | null;
  lanes: TaskLane[];
  status: 'running' | 'done' | 'failed';
  artifacts: TaskArtifact[];
  error?: string | null;
  ts: number;
}

export interface TaskNoticeDraft {
  notice: Omit<Notice, 'ts'> & { ts: number };
  /** 播报词；false = 只记账不出声 */
  speech: string | false;
}

/**
 * 任务终态 → 账本条目（纯函数，便于单测）。
 *
 * 口径（2026-09-22 体验层）：
 *  · 只收终态——running 不入账。账本回答的是「有什么结果要你知道」，
 *    不是进度条（进度归 TaskOrbit 自己）。
 *  · 失败出声、完成不出声。完成态多由面板自己播报（FileGenPanel done 已发
 *    crabpaw:speak），账本再念一遍就是双声；失败则相反——此前只在各自面板里
 *    默默变红，切走面板就没人知道。
 */
export function taskNotice(run: TaskRun): TaskNoticeDraft | null {
  if (!run || !run.taskId) return null;
  if (run.status === 'running') return null;
  const title = String(run.title || '').trim() || '一个任务';
  if (run.status === 'failed') {
    const reason = String(run.error || '').replace(/\s+/g, ' ').trim();
    return {
      notice: {
        id: `task_${run.taskId}`,
        ts: run.ts || Date.now(),
        kind: 'task',
        level: 'failed',
        title: `${title} 没跑成功`,
        detail: reason || undefined,
        ref: run.taskId,
      },
      speech: `${title}没跑成功${reason ? `，原因是${reason.slice(0, 40)}` : ''}。要我重试一次吗`,
    };
  }
  const files = Array.isArray(run.artifacts) ? run.artifacts.length : 0;
  return {
    notice: {
      id: `task_${run.taskId}`,
      ts: run.ts || Date.now(),
      kind: 'task',
      level: 'done',
      title: `${title} 做完了`,
      detail: files > 0 ? `产出 ${files} 个文件` : undefined,
      ref: run.taskId,
    },
    speech: false,
  };
}

export function useTaskOrbit() {
  const [active, setActive] = useState<TaskRun[]>([]);
  const [done, setDone] = useState<TaskRun[]>([]);
  const byId = useRef(new Map<string, TaskRun>());
  // 2026-09-22 体验层: 终态上报去重——同一 taskId 的同一终态只记账/播报一次。
  // SSE 对同一任务会推多次 update(阶段推进/产物追加)，不去重会把账本刷屏、
  // 把同一句话重复入播报队列。
  const reportedRef = useRef(new Set<string>());

  useSse({
    path: '/events',
    handlers: useMemo(() => ({
      'task:update': (run: TaskRun) => {
        if (!run || !run.taskId) return;
        byId.current.set(run.taskId, run);
        // 2026-08-08(审计 P2): 修剪 Map 上界——长会话(全生命周期不修剪)内存
        // 爬升防护;只保留最近 100 条
        if (byId.current.size > 100) {
          const recent = [...byId.current.values()]
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 100)
            .map(r => [r.taskId, r] as const);
          byId.current = new Map(recent);
        }
        const all = [...byId.current.values()].sort((a, b) => b.ts - a.ts);
        setActive(all.filter((r) => r.status === 'running').slice(0, 5));
        setDone(all.filter((r) => r.status !== 'running').slice(0, 3));
        // 2026-09-22 体验层: 终态进账本(失败出声/完成记账)
        const key = `${run.taskId}:${run.status}`;
        if (run.status !== 'running' && !reportedRef.current.has(key)) {
          const draft = taskNotice(run);
          if (draft) {
            reportedRef.current.add(key);
            if (reportedRef.current.size > 200) {
              // 防泄漏: 超界丢弃最早的一半(Set 保序)
              const keep = [...reportedRef.current].slice(-100);
              reportedRef.current = new Set(keep);
            }
            notify(draft.notice, draft.speech);
          }
        }
      },
    }), []),
  });

  return { active, done };
}
