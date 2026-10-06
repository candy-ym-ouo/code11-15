import { useState } from 'react';
import type { RelationshipVersion } from '../../api/types';
import { Button, Modal, TextArea } from '../../components/ui';

const ACTION_LABELS: Record<string, string> = {
  'edge.create': '手工新增关系',
  'edge.update': '人工校正',
  'edge.delete': '删除关系',
  'infer.adopt': '采纳推导',
  'infer.persist_all': '保存推导建议',
  'infer.adopt_all': '批量采纳推导',
  'infer.suggest': '暂存单条建议',
};

function actionLabel(a: string): string {
  if (ACTION_LABELS[a]) return ACTION_LABELS[a]!;
  if (a.startsWith('rollback:')) return `回滚到 v${a.slice('rollback:v'.length)}`;
  return a;
}

interface Props {
  open: boolean;
  versions: RelationshipVersion[];
  loading: boolean;
  onClose: () => void;
  onRollback: (version: number, reason: string | null) => Promise<void>;
}

export function VersionsDialog({ open, versions, loading, onClose, onRollback }: Props) {
  const [target, setTarget] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const snapshotCount = (v: RelationshipVersion): { edges: number; people: number } => {
    const snap = v.snapshot as { edges?: unknown[]; people?: unknown[] } | null;
    return { edges: snap?.edges?.length ?? 0, people: snap?.people?.length ?? 0 };
  };

  const doRollback = async () => {
    if (target == null) return;
    setBusy(true);
    try {
      await onRollback(target, reason.trim() || null);
      setTarget(null);
      setReason('');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="版本历史与回滚"
      onClose={() => {
        setTarget(null);
        onClose();
      }}
      footer={
        target != null ? (
          <>
            <span className="muted">回滚会在历史末尾新增一版，不删除任何记录</span>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setTarget(null)}>再想想</Button>
            <Button variant="danger" loading={busy} onClick={doRollback}>
              确认回滚到 v{target}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>关闭</Button>
        )
      }
    >
      {target != null ? (
        <div>
          <p>
            即将把整张图谱恢复为 <strong>v{target}</strong> 时的样子：之后新增的关系会移除、删除的恢复、修改的还原。
          </p>
          <TextArea
            placeholder="为什么回滚？（选填，会记入审计日志）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
          />
        </div>
      ) : (
        <div className="kinship-versions">
          {loading ? (
            <p className="muted">加载中…</p>
          ) : versions.length === 0 ? (
            <p className="muted">还没有任何修改记录。</p>
          ) : (
            <ul className="kinship-version-list">
              {versions.map((v) => {
                const c = snapshotCount(v);
                return (
                  <li key={v.id} className="kinship-version-item">
                    <div>
                      <strong>v{v.version}</strong>
                      <span className="tag tag--muted" style={{ marginLeft: 8 }}>
                        {actionLabel(v.action)}
                      </span>
                      {v.reason ? <p className="muted" style={{ margin: '4px 0 0' }}>{v.reason}</p> : null}
                    </div>
                    <div className="kinship-version-meta">
                      <span className="muted">
                        {c.people} 人 · {c.edges} 条边
                      </span>
                      <span className="muted">{new Date(v.createdAt).toLocaleString('zh-CN')}</span>
                      <Button size="sm" variant="ghost" onClick={() => setTarget(v.version)}>
                        回滚到这版
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
