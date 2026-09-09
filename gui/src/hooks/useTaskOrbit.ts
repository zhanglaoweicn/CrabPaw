import { useMemo, useRef, useState } from 'react';
import { useSse } from './useSSE';

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

export function useTaskOrbit() {
  const [active, setActive] = useState<TaskRun[]>([]);
  const [done, setDone] = useState<TaskRun[]>([]);
  const byId = useRef(new Map<string, TaskRun>());

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
      },
    }), []),
  });

  return { active, done };
}
