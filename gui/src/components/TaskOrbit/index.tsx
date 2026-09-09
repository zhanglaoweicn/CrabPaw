import { useTaskOrbit, TaskRun } from '../../hooks/useTaskOrbit';

function LaneRow({ lane }: { lane: TaskRun['lanes'][number] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background:
        lane.status === 'done' ? '#22c55e' : lane.status === 'failed' ? '#ef4444' : lane.status === 'running' ? '#f59e0b' : '#64748b' }} />
      <span style={{ fontSize: 13, flex: 1 }}>{lane.agent}</span>
      <span style={{ fontSize: 12, opacity: 0.7 }}>{lane.stage}</span>
      {lane.status === 'running' ? <span style={{ fontSize: 12, opacity: 0.8 }}>{lane.progress}%</span> : null}
    </div>
  );
}

function TaskCard({ run }: { run: TaskRun }) {
  return (
    <div className="collab-orbit-card" style={{ padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{run.title}</span>
        {run.skill ? <span style={{ fontSize: 11, opacity: 0.6 }}>技能·{run.skill}</span> : null}
      </div>
      {run.lanes.map((l) => <LaneRow key={l.id} lane={l} />)}
      {run.status === 'failed' ? <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>⚠ {run.error}</div> : null}
      {run.artifacts.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {run.artifacts.map((a) => (
            <span key={a.id} className="artifact-chip" style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, background: 'rgba(234,88,12,0.15)', color: '#fdba74', cursor: 'pointer' }}>
              📄 {a.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function TaskOrbit() {
  const { active, done } = useTaskOrbit();
  if (active.length === 0 && done.length === 0) return null;
  // 2026-09-05: 与 CollabOrbit 同理——协作运行期的任务轨道卡提到浮动卡之上,
  // 否则左下角心跳/日志卡(z=70)会盖住它(此前 z=40)
  return (
    <div className="collab-orbit" style={{ position: 'fixed', left: 16, bottom: 96, zIndex: 'var(--z-cockpit)', width: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {active.map((r) => <TaskCard key={r.taskId} run={r} />)}
      {done.length ? <div style={{ fontSize: 11, opacity: 0.5, textAlign: 'center' }}>最近完成 {done.length} 项</div> : null}
    </div>
  );
}
