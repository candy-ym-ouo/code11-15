import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getAccessToken } from '../../api/client';
import { Button, EmptyState, Modal, SegmentedControl, Spinner, Tag, Field, Select, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useFamily } from '../families/useFamily';
import type { KinEdge, KinGraph, KinInference, KinIssue, KinVersion } from '../../api/types';
import { KIN_CONFIDENCE_LABELS, KIN_EDGE_LABELS } from '../../lib/constants';
import { KinGraphSvg } from './KinGraphSvg';

type Tab = 'graph' | 'issues' | 'infer' | 'versions';

export function KinshipPage() {
  const { fid } = useParams<{ fid: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);
  const [tab, setTab] = useState<Tab>('graph');
  const [edgeModal, setEdgeModal] = useState(false);
  const [editingEdge, setEditingEdge] = useState<KinEdge | null>(null);

  const graphQuery = useQuery({
    queryKey: ['kin-graph', fid],
    queryFn: () => api.get<KinGraph>(`/families/${fid}/kinship/graph`),
    enabled: Boolean(fid),
  });

  const issuesQuery = useQuery({
    queryKey: ['kin-issues', fid],
    queryFn: () => api.get<{ issues: KinIssue[] }>(`/families/${fid}/kinship/issues`),
    enabled: Boolean(fid) && (tab === 'issues' || tab === 'graph'),
  });

  const canWrite = familyData && ['owner', 'admin', 'editor'].includes(familyData.myRole);
  const exportUrl = (format: string) => {
    const token = getAccessToken();
    return `/api/v1/families/${fid}/kinship/export?format=${format}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
  };
  const graph = graphQuery.data ?? null;
  const issues = issuesQuery.data?.issues ?? [];
  const openIssues = issues.filter((i) => i.status === 'open' || i.status === 'ignored');

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['kin-graph', fid] });
    void queryClient.invalidateQueries({ queryKey: ['kin-issues', fid] });
    void queryClient.invalidateQueries({ queryKey: ['kin-inference', fid] });
    void queryClient.invalidateQueries({ queryKey: ['kin-versions', fid] });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>家族关系图谱</h1>
          <p className="page-head__sub">
            从人物称呼（「外公」「舅妈」）和物品的来源角色推导亲属关系；祖辈、叔侄等不靠手填，沿关系自动算。
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {canWrite ? (
            <Button variant="primary" onClick={() => { setEditingEdge(null); setEdgeModal(true); }}>
              ＋ 手动补关系
            </Button>
          ) : null}
          <Button
            onClick={() => {
              window.open(exportUrl('gedcom'), '_blank');
            }}
          >
            导出 GEDCOM
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              window.open(exportUrl('dot'), '_blank');
            }}
          >
            DOT
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              window.open(exportUrl('csv'), '_blank');
            }}
          >
            CSV
          </Button>
        </div>
      </div>

      <SegmentedControl<Tab>
        value={tab}
        onChange={setTab}
        name="kinship-tabs"
        options={[
          { value: 'graph', label: '图谱', icon: '🧬' },
          { value: 'issues', label: openIssues.length ? `矛盾 (${openIssues.length})` : '矛盾', icon: '⚠️' },
          { value: 'infer', label: '自动推导', icon: '✨' },
          { value: 'versions', label: '版本留痕', icon: '🕘' },
        ]}
      />

      {graphQuery.isLoading ? (
        <Spinner />
      ) : !graph ? (
        <EmptyState icon="🧬" title="图谱加载失败" description="请稍后再试。" />
      ) : (
        <>
          {tab === 'graph' ? (
            <GraphTab
              fid={fid!}
              graph={graph}
              canWrite={Boolean(canWrite)}
              issues={openIssues}
              edgeModal={edgeModal}
              setEdgeModal={setEdgeModal}
              editingEdge={editingEdge}
              setEditingEdge={setEditingEdge}
              onChanged={refreshAll}
              push={push}
            />
          ) : null}
          {tab === 'issues' ? (
            <IssuesTab fid={fid!} issues={issues} canWrite={Boolean(canWrite)} onChanged={refreshAll} push={push} />
          ) : null}
          {tab === 'infer' ? <InferTab fid={fid!} canWrite={Boolean(canWrite)} onChanged={refreshAll} push={push} /> : null}
          {tab === 'versions' ? <VersionsTab fid={fid!} canWrite={Boolean(canWrite)} onChanged={refreshAll} push={push} /> : null}
        </>
      )}
    </div>
  );
}

// ---------- 图谱标签 ----------

function GraphTab(props: {
  fid: string;
  graph: KinGraph;
  canWrite: boolean;
  issues: KinIssue[];
  edgeModal: boolean;
  setEdgeModal: (v: boolean) => void;
  editingEdge: KinEdge | null;
  setEditingEdge: (e: KinEdge | null) => void;
  onChanged: () => void;
  push: ReturnType<typeof useToast>['push'];
}) {
  const { fid, graph, canWrite, issues, edgeModal, setEdgeModal, editingEdge, setEditingEdge, onChanged, push } = props;
  const highlightEdges = useMemo(() => new Set(issues.flatMap((i) => i.edgeIds)), [issues]);
  const highlightPeople = useMemo(() => new Set(issues.flatMap((i) => i.personIds)), [issues]);
  const errCount = issues.filter((i) => i.severity === 'error' && i.status === 'open').length;

  return (
    <div className="stack">
      {errCount > 0 ? (
        <div className="kin-banner kin-banner--error" role="alert">
          有 {errCount} 个硬矛盾需要处理（图中高亮处）。
          <Tag tone="warn">请校正</Tag>
        </div>
      ) : null}
      {!graph.anchorPersonId && graph.people.length > 0 ? (
        <AnchorBanner fid={fid} graph={graph} canWrite={canWrite} onChanged={onChanged} push={push} />
      ) : null}

      <div className="card card--flush kin-canvas-card">
        <KinGraphSvg
          graph={graph}
          familyId={fid}
          highlightEdgeIds={highlightEdges}
          highlightPersonIds={highlightPeople}
          onAddEdge={canWrite ? () => { setEditingEdge(null); setEdgeModal(true); } : undefined}
          onSelectEdge={canWrite ? (e) => { setEditingEdge(e); setEdgeModal(true); } : undefined}
        />
      </div>

      <EdgeList graph={graph} canWrite={canWrite} onEdit={(e) => { setEditingEdge(e); setEdgeModal(true); }} onChanged={onChanged} push={push} fid={fid} />

      <EdgeModal
        open={edgeModal}
        fid={fid}
        graph={graph}
        edge={editingEdge}
        onClose={() => setEdgeModal(false)}
        onChanged={() => { setEdgeModal(false); onChanged(); }}
        push={push}
      />
    </div>
  );
}

function AnchorBanner({ fid, graph, canWrite, onChanged, push }: { fid: string; graph: KinGraph; canWrite: boolean; onChanged: () => void; push: ReturnType<typeof useToast>['push'] }) {
  const [personId, setPersonId] = useState(graph.anchorPersonId ?? '');
  const mutation = useMutation({
    mutationFn: () => api.post(`/families/${fid}/kinship/anchor`, { personId: personId || null }),
    onSuccess: () => {
      push('锚点人物已设置，称呼将以此人为中心解读', 'success');
      onChanged();
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '设置失败', 'error'),
  });
  return (
    <div className="kin-banner kin-banner--info">
      <Field label="先指定「以谁为中心」解读称呼（一般选建档人本人）">
        <div className="row">
          <Select value={personId} onChange={(e) => setPersonId(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="">请选择人物…</option>
            {graph.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          {canWrite ? <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>设为锚点</Button> : null}
        </div>
      </Field>
    </div>
  );
}

function EdgeList({ graph, canWrite, onEdit, onChanged, push, fid }: { graph: KinGraph; canWrite: boolean; onEdit: (e: KinEdge) => void; onChanged: () => void; push: ReturnType<typeof useToast>['push']; fid: string }) {
  const queryClient = useQueryClient();
  const nameOf = (id: string) => graph.people.find((p) => p.id === id)?.name ?? '（已删除）';
  const del = useMutation({
    mutationFn: (edge: KinEdge) => api.del(`/families/${fid}/kinship/edges/${edge.id}`),
    onSuccess: () => {
      push('关系已删除（可在版本留痕里找回）', 'success');
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ['kin-graph', fid] });
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '删除失败', 'error'),
  });
  if (graph.edges.length === 0) return null;
  return (
    <section className="card">
      <h2 style={{ marginBottom: 'var(--space-3)' }}>全部关系（{graph.edges.length}）</h2>
      <ul className="kin-edge-list">
        {graph.edges.map((e) => (
          <li key={e.id} className="kin-edge-row">
            <span className="kin-edge-row__names">
              {nameOf(e.fromPersonId)}
              <span className="kin-edge-row__type">{KIN_EDGE_LABELS[e.type]}</span>
              {nameOf(e.toPersonId)}
            </span>
            <span className="row" style={{ gap: 6 }}>
              {e.origin === 'inferred' ? <Tag tone="muted">推导</Tag> : <Tag tone="success">人工</Tag>}
              {!e.confirmed ? <Tag tone="warn">待确认</Tag> : null}
              <Tag>{KIN_CONFIDENCE_LABELS[e.confidence]}</Tag>
              {canWrite ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => onEdit(e)}>校正</Button>
                  <Button size="sm" variant="ghost" onClick={() => del.mutate(e)}>删除</Button>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EdgeModal({ open, fid, graph, edge, onClose, onChanged, push }: {
  open: boolean; fid: string; graph: KinGraph; edge: KinEdge | null; onClose: () => void; onChanged: () => void; push: ReturnType<typeof useToast>['push'];
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState<KinEdge['type']>('parent');
  const [confirmed, setConfirmed] = useState(true);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 打开时同步初始值
  useEffect(() => {
    if (open) {
      setFrom(edge?.fromPersonId ?? '');
      setTo(edge?.toPersonId ?? '');
      setType(edge?.type ?? 'parent');
      setConfirmed(edge?.confirmed ?? true);
      setNote(edge?.note ?? '');
      setError(null);
    }
  }, [open, edge]);

  const save = useMutation({
    mutationFn: async () => {
      if (edge) {
        await api.patch(`/families/${fid}/kinship/edges/${edge.id}`, {
          note: note.trim() || null,
          confirmed,
        });
      } else {
        await api.post(`/families/${fid}/kinship/edges`, {
          fromPersonId: from,
          toPersonId: to,
          type,
          note: note.trim() || null,
          confirmed,
        });
      }
    },
    onSuccess: () => {
      push(edge ? '关系已校正' : '关系已补上', 'success');
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '保存失败'),
  });

  return (
    <Modal
      open={open}
      title={edge ? '校正亲属关系' : '补一条亲属关系'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!edge && (!from || !to || from === to)}>
            保存
          </Button>
        </>
      }
    >
      {edge ? (
        <div className="stack">
          <p className="muted">
            {graph.people.find((p) => p.id === edge.fromPersonId)?.name} → {graph.people.find((p) => p.id === edge.toPersonId)?.name}
            （{KIN_EDGE_LABELS[edge.type]}）
          </p>
          <label className="field">
            <span className="field__label">确认状态</span>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 已人工核实
          </label>
          <Field label="备注">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="例如「户口记载」「大姨电话确认」" />
          </Field>
          {edge.origin === 'inferred' && edge.evidence ? (
            <p className="muted" style={{ fontSize: 13 }}>推导依据：{(edge.evidence as { reason?: string })?.reason ?? '—'}</p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <Field label="关系类型" required>
            <Select value={type} onChange={(e) => setType(e.target.value as KinEdge['type'])}>
              <option value="parent">父母 → 子女（有方向）</option>
              <option value="partner">配偶</option>
              <option value="sibling">兄弟姐妹</option>
            </Select>
          </Field>
          <div className="form-grid">
            <Field label={type === 'parent' ? '父母' : '人物甲'} required>
              <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">选择人物…</option>
                {graph.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label={type === 'parent' ? '子女' : '人物乙'} required>
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">选择人物…</option>
                {graph.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="备注">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
          <p className="field__hint">祖辈、叔侄、表亲不用手填：有了父母边之后，图谱会自动推导。</p>
        </div>
      )}
      {error ? <p className="field__error" role="alert">{error}</p> : null}
    </Modal>
  );
}

// ---------- 矛盾标签 ----------

function IssuesTab({ fid, issues, canWrite, onChanged, push }: { fid: string; issues: KinIssue[]; canWrite: boolean; onChanged: () => void; push: ReturnType<typeof useToast>['push'] }) {
  const [showResolved, setShowResolved] = useState(false);
  const visible = issues.filter((i) => showResolved || i.status !== 'resolved');
  const ignore = useMutation({
    mutationFn: ({ id, ignoreFlag }: { id: string; ignoreFlag: boolean }) =>
      api.post(`/families/${fid}/kinship/issues/${id}/ignore`, { ignore: ignoreFlag }),
    onSuccess: () => { push('已更新'); onChanged(); },
    onError: (e) => push(e instanceof ApiError ? e.message : '操作失败', 'error'),
  });

  if (issues.length === 0) {
    return <EmptyState icon="✅" title="暂未发现矛盾" description="每次补录关系后都会自动重新检查：代际循环、性别与称呼不符、年龄倒挂等。" />;
  }
  return (
    <div className="stack">
      <div className="row row--between">
        <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 显示已解决
        </label>
      </div>
      {visible.map((issue) => (
        <div key={issue.id} className={`kin-issue kin-issue--${issue.severity} kin-issue--${issue.status}`}>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <Tag tone={issue.severity === 'error' ? 'warn' : 'muted'}>{issue.severity === 'error' ? '硬矛盾' : '可疑'}</Tag>
              {issue.status === 'ignored' ? <Tag>已忽略</Tag> : null}
              {issue.status === 'resolved' ? <Tag tone="success">已消失</Tag> : null}
            </div>
            <p style={{ margin: '8px 0 0' }}>{issue.message}</p>
          </div>
          {canWrite && issue.status !== 'resolved' ? (
            issue.status === 'ignored' ? (
              <Button size="sm" variant="ghost" onClick={() => ignore.mutate({ id: issue.id, ignoreFlag: false })}>重新关注</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => ignore.mutate({ id: issue.id, ignoreFlag: true })}>忽略</Button>
            )
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------- 推导标签 ----------

function InferTab({ fid, canWrite, onChanged, push }: { fid: string; canWrite: boolean; onChanged: () => void; push: ReturnType<typeof useToast>['push'] }) {
  const inferenceQuery = useQuery({
    queryKey: ['kin-inference', fid],
    queryFn: () => api.get<KinInference>(`/families/${fid}/kinship/inference`),
    enabled: Boolean(fid),
  });
  const [includeRoles, setIncludeRoles] = useState(false);
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ createdCount: number }>(`/families/${fid}/kinship/inference/apply`, {
        includeRoleSuggestions: includeRoles,
      }),
    onSuccess: (data) => {
      push(`已采纳 ${data.createdCount} 条推导关系，均标记为待确认`, 'success');
      onChanged();
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '推导失败', 'error'),
  });

  if (inferenceQuery.isLoading) return <Spinner />;
  const data = inferenceQuery.data;
  if (!data) return null;
  const total = data.labelEdges.length + (includeRoles ? data.roleSuggestions.length : 0);

  return (
    <div className="stack">
      <section className="card">
        <h2>从人物称呼推导</h2>
        <p className="muted">系统会把「外公」「舅妈」这类称呼，沿「父母 → 父母的父母」等路径补成基础关系边。补出的边默认是<strong>未确认</strong>状态，请逐条核实。</p>
        {data.labelEdges.length === 0 ? (
          <EmptyState icon="🪄" title="没有新的称呼可推导" description="可能是称呼都已落成边，或还没指定锚点人物。" />
        ) : (
          <ul className="kin-edge-list">
            {data.labelEdges.map((d, i) => (
              <li key={`${d.fromPersonId}-${d.toPersonId}-${d.type}-${i}`} className="kin-edge-row">
                <span className="kin-edge-row__names">
                  {d.fromName} <span className="kin-edge-row__type">{KIN_EDGE_LABELS[d.type]}</span> {d.toName}
                </span>
                <Tag tone="muted">{d.evidence.reason}</Tag>
              </li>
            ))}
          </ul>
        )}
        {data.unresolved.length > 0 ? (
          <div className="kin-banner kin-banner--info">
            {data.unresolved.length} 个称呼落不了地（路径上的中间人物还没建档），例如：
            {' '}{data.unresolved.slice(0, 3).map((u) => `「${u.label}」`).join('、')}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>从物品来源角色找弱线索</h2>
        <p className="muted">同一件物品若记录为某人「继承自」另一位，通常意味着长幼关系。但生活里也可能来自叔伯，所以只作<strong>待核实</strong>建议，绝不自动坐实。</p>
        <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={includeRoles} onChange={(e) => setIncludeRoles(e.target.checked)} disabled={data.roleSuggestions.length === 0} />
          一并采纳 {data.roleSuggestions.length} 条「疑似长辈」线索
        </label>
        {data.roleSuggestions.slice(0, 8).map((s, i) => (
          <div key={i} className="kin-edge-row">
            <span className="kin-edge-row__names">{s.fromName} <span className="kin-edge-row__type">疑似长辈 →</span> {s.toName}</span>
            <Tag tone="warn">{s.evidence.reason}</Tag>
          </div>
        ))}
      </section>

      {canWrite ? (
        <div>
          <Button variant="primary" loading={apply.isPending} disabled={total === 0} onClick={() => apply.mutate()}>
            采纳 {total} 条推导
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- 版本标签 ----------

function VersionsTab({ fid, canWrite, onChanged, push }: { fid: string; canWrite: boolean; onChanged: () => void; push: ReturnType<typeof useToast>['push'] }) {
  const dotUrl = () => {
    const token = getAccessToken();
    return `/api/v1/families/${fid}/kinship/export?format=dot${token ? `&t=${encodeURIComponent(token)}` : ''}`;
  };
  const versionsQuery = useQuery({
    queryKey: ['kin-versions', fid],
    queryFn: () => api.get<{ versions: KinVersion[] }>(`/families/${fid}/kinship/versions`),
    enabled: Boolean(fid),
  });
  const revert = useMutation({
    mutationFn: (versionId: string) => api.post(`/families/${fid}/kinship/versions/${versionId}/revert`, {}),
    onSuccess: () => {
      push('图谱已回滚（回滚本身也留了一个版本）', 'success');
      onChanged();
    },
    onError: (e) => push(e instanceof ApiError ? e.message : '回滚失败', 'error'),
  });
  if (versionsQuery.isLoading) return <Spinner />;
  const versions = versionsQuery.data?.versions ?? [];
  if (versions.length === 0) {
    return <EmptyState icon="🕘" title="还没有版本" description="第一次手动校正或采纳推导前，系统会自动把当前图谱存一个版本。" />;
  }
  return (
    <ul className="kin-version-list">
      {versions.map((v) => (
        <li key={v.id} className="kin-version-row">
          <div>
            <strong>第 {v.version} 版</strong>
            <span className="muted" style={{ marginLeft: 10 }}>{new Date(v.createdAt).toLocaleString('zh-CN')}</span>
            {v.reason ? <p className="muted" style={{ margin: '4px 0 0' }}>{v.reason}</p> : null}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn--sm btn--ghost" href={dotUrl()} target="_blank" rel="noreferrer">导出 DOT</a>
            {canWrite ? (
              <Button size="sm" variant="ghost" loading={revert.isPending} onClick={() => {
                if (window.confirm(`回滚到第 ${v.version} 版？之后对关系的校正会被该版本覆盖（仍可再回到本版）。`)) revert.mutate(v.id);
              }}>回滚到此版</Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
