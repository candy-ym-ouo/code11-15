import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { KinshipGraph, KinshipIssue, KinshipSuggestion, Relationship, RelationshipVersion } from '../../api/types';
import { Button, EmptyState, SegmentedControl, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useFamily } from '../families/useFamily';
import { KinshipSvg } from './KinshipSvg';
import { EdgeEditDialog } from './EdgeEditDialog';
import { EdgeCreateDialog } from './EdgeCreateDialog';
import { VersionsDialog } from './VersionsDialog';

type Tab = 'graph' | 'issues' | 'infer';

export function KinshipPage() {
  const { fid } = useParams<{ fid: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);
  const canWrite = Boolean(familyData && ['owner', 'admin', 'editor'].includes(familyData.myRole));
  const canDelete = Boolean(familyData && ['owner', 'admin'].includes(familyData.myRole));

  const [tab, setTab] = useState<Tab>('graph');
  const [showSuggested, setShowSuggested] = useState(true);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<Relationship | null>(null);
  const [creating, setCreating] = useState(false);
  const [createPreset, setCreatePreset] = useState<{ fromId?: string; toId?: string }>({});
  const [versionsOpen, setVersionsOpen] = useState(false);

  const graphQuery = useQuery({
    queryKey: ['kinship-graph', fid],
    queryFn: () => api.get<{ graph: KinshipGraph }>(`/families/${fid}/kinship/graph`),
    enabled: Boolean(fid),
  });

  const inferQuery = useQuery({
    queryKey: ['kinship-infer', fid],
    queryFn: () => api.get<{ suggestions: KinshipSuggestion[]; skipped: number }>(`/families/${fid}/kinship/infer`),
    enabled: Boolean(fid) && tab === 'infer',
  });

  const versionsQuery = useQuery({
    queryKey: ['kinship-versions', fid],
    queryFn: () => api.get<{ versions: RelationshipVersion[] }>(`/families/${fid}/kinship/versions`),
    enabled: Boolean(fid) && versionsOpen,
  });

  const graph = graphQuery.data?.graph ?? null;
  const peopleById = useMemo(() => new Map((graph?.people ?? []).map((p) => [p.id, p])), [graph]);
  const nameOf = (id: string) => peopleById.get(id)?.name ?? '已删除人物';

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kinship-graph', fid] }),
      queryClient.invalidateQueries({ queryKey: ['kinship-infer', fid] }),
    ]);

  const persistOne = useMutation({
    mutationFn: (vars: { s: KinshipSuggestion; adopt: boolean }) =>
      api.post(`/families/${fid}/kinship/infer/persist`, { ...vars.s, adopt: vars.adopt }),
    onSuccess: async (_d, vars) => {
      push(vars.adopt ? '已采纳并加入图谱' : '已暂存为待确认建议', 'success');
      await refresh();
    },
    onError: (e) => push(e instanceof Error ? e.message : '操作失败', 'error'),
  });

  const persistAll = useMutation<{ created: number; duplicates: number }, Error, boolean>({
    mutationFn: async (adopt: boolean) => {
      const items = (inferQuery.data?.suggestions ?? []).map((s) => ({ ...s }));
      return api.post<{ created: number; duplicates: number }>(`/families/${fid}/kinship/infer/persist-all`, { items, adopt });
    },
    onSuccess: async (d: { created: number; duplicates: number }) => {
      push(`已处理 ${d.created} 条建议${d.duplicates ? `，${d.duplicates} 条重复跳过` : ''}`, 'success');
      await refresh();
    },
    onError: (e) => push(e instanceof Error ? e.message : '操作失败', 'error'),
  });

  const saveEdge = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Relationship> }) =>
      api.patch(`/families/${fid}/kinship/edges/${vars.id}`, vars.patch),
    onSuccess: async () => {
      push('校正已保存并记录版本', 'success');
      await refresh();
    },
    onError: (e) => push(e instanceof Error ? e.message : '保存失败', 'error'),
  });

  const deleteEdge = useMutation({
    mutationFn: (id: string) => api.del(`/families/${fid}/kinship/edges/${id}`),
    onSuccess: async () => {
      push('关系已删除', 'success');
      await refresh();
    },
    onError: (e) => push(e instanceof Error ? e.message : '删除失败', 'error'),
  });

  const createEdge = useMutation({
    mutationFn: (input: { fromPersonId: string; toPersonId: string; kind: Relationship['kind']; label: string | null; note: string | null }) =>
      api.post(`/families/${fid}/kinship/edges`, input),
    onSuccess: async () => {
      push('关系已建立', 'success');
      await refresh();
    },
    onError: (e) => push(e instanceof Error ? e.message : '建立失败', 'error'),
  });

  const rollback = useMutation({
    mutationFn: (vars: { version: number; reason: string | null }) =>
      api.post(`/families/${fid}/kinship/versions/${vars.version}/rollback`, { reason: vars.reason }),
    onSuccess: async () => {
      push('已回滚，新版本已追加到历史末尾', 'success');
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['kinship-versions', fid] })]);
    },
    onError: (e) => push(e instanceof Error ? e.message : '回滚失败', 'error'),
  });

  if (graphQuery.isLoading) return <Spinner />;
  if (!graph) return <EmptyState icon="🧬" title="图谱不可用" description="请稍后再试。" />;

  const selectedEdges = selectedPerson
    ? graph.edges.filter((e) => e.fromPersonId === selectedPerson || e.toPersonId === selectedPerson)
    : [];

  const download = (format: 'json' | 'csv' | 'graphml') => {
    window.open(`/api/v1/families/${fid}/kinship/export?format=${format}`, '_blank');
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>家族关系图谱</h1>
          <p className="page-head__sub">
            从物品档案里的来源人物与角色自动推导亲属关系；发现矛盾会标红，每一次人工校正都留有版本，可随时回滚与导出。
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {canWrite ? (
            <Button
              variant="primary"
              onClick={() => {
                setCreatePreset({});
                setCreating(true);
              }}
            >
              手工连边
            </Button>
          ) : null}
          <Button onClick={() => setVersionsOpen(true)}>版本历史</Button>
          <Button onClick={() => download('json')}>JSON</Button>
          <Button onClick={() => download('csv')}>CSV</Button>
          <Button onClick={() => download('graphml')}>GraphML</Button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat__value">{graph.counts.people}</div>
          <div className="stat__label">人物</div>
        </div>
        <div className="stat">
          <div className="stat__value">{graph.counts.edges}</div>
          <div className="stat__label">有效关系（手工 {graph.counts.manual} · 推导 {graph.counts.derived}）</div>
        </div>
        <div className="stat">
          <div className="stat__value">{graph.counts.suggested}</div>
          <div className="stat__label">待确认建议</div>
        </div>
        <div className="stat">
          <div className="stat__value" style={{ color: graph.counts.errors ? '#B43E2C' : undefined }}>
            {graph.counts.issues}
          </div>
          <div className="stat__label">{graph.counts.errors ? `其中 ${graph.counts.errors} 个硬矛盾` : '矛盾与提醒'}</div>
        </div>
      </div>

      <SegmentedControl<Tab>
        name="kinship-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'graph', label: '关系图', icon: '🧬' },
          { value: 'infer', label: '推导建议', icon: '✨' },
          { value: 'issues', label: graph.counts.issues ? `矛盾清单 (${graph.counts.issues})` : '矛盾清单', icon: '⚠️' },
        ]}
      />

      {tab === 'graph' ? (
        <div className="kinship-layout">
          <div className="kinship-main">
            {graph.people.length < 2 ? (
              <EmptyState
                icon="👨‍👩‍👧"
                title="人物还不够成图"
                description="先在「人物」里至少建两位亲属（把关系称谓填成「爸爸」「外公」「舅舅」等），再在物品档案里把他们标为来源/赠送/继承，系统就能推导出关系。"
              />
            ) : (
              <>
                <label className="row kinship-filter">
                  <input type="checkbox" checked={showSuggested} onChange={(e) => setShowSuggested(e.target.checked)} />
                  <span>显示虚线的待确认建议</span>
                </label>
                <KinshipSvg
                  graph={graph}
                  showSuggested={showSuggested}
                  highlightPerson={selectedPerson}
                  onSelectPerson={setSelectedPerson}
                  onEditEdge={(e) => canWrite && setEditingEdge(e)}
                />
              </>
            )}
          </div>
          <aside className="kinship-side">
            {selectedPerson ? (
              <PersonSide
                personId={selectedPerson}
                name={nameOf(selectedPerson)}
                edges={selectedEdges}
                nameOf={nameOf}
                canWrite={canWrite}
                onEditEdge={setEditingEdge}
                onAddEdge={(otherId) => {
                  setCreatePreset({ fromId: selectedPerson, toId: otherId });
                  setCreating(true);
                }}
                onClose={() => setSelectedPerson(null)}
                allPeople={graph.people.map((p) => p.id)}
              />
            ) : (
              <div className="card kinship-hint">
                <h3>怎么看图</h3>
                <ul>
                  <li>上下分层是辈分；深色实线箭头是「父母→子女」。</li>
                  <li>红边是配偶、绿边是同胞、紫边是其他亲属。</li>
                  <li>虚线是系统推导、还没确认的建议。</li>
                  <li>点节点看这个人的全部关系；点边的标签可直接校正。</li>
                  <li>右上角能导出 JSON / CSV / GraphML（可导入 Gephi、yEd）。</li>
                </ul>
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {tab === 'infer' ? (
        <InferPanel
          loading={inferQuery.isLoading}
          suggestions={inferQuery.data?.suggestions ?? []}
          skipped={inferQuery.data?.skipped ?? 0}
          nameOf={nameOf}
          canWrite={canWrite}
          busy={persistOne.isPending || persistAll.isPending}
          onAdoptOne={(s) => persistOne.mutate({ s, adopt: true })}
          onSaveOne={(s) => persistOne.mutate({ s, adopt: false })}
          onAdoptAll={() => persistAll.mutate(true)}
          onSaveAll={() => persistAll.mutate(false)}
        />
      ) : null}

      {tab === 'issues' ? <IssuesPanel issues={graph.issues} nameOf={nameOf} canWrite={canWrite} onFix={setEditingEdge} edgesById={new Map(graph.edges.map((e) => [e.id, e]))} /> : null}

      <EdgeEditDialog
        key={editingEdge?.id ?? 'none'}
        open={Boolean(editingEdge)}
        edge={editingEdge}
        nameOf={nameOf}
        onClose={() => setEditingEdge(null)}
        onSave={async (patch) => {
          if (editingEdge) await saveEdge.mutateAsync({ id: editingEdge.id, patch });
        }}
        onDelete={async () => {
          if (editingEdge) await deleteEdge.mutateAsync(editingEdge.id);
        }}
      />

      <EdgeCreateDialog
        key={`${createPreset.fromId ?? ''}-${createPreset.toId ?? ''}-${creating ? 'open' : 'closed'}`}
        open={creating}
        graph={graph}
        preset={createPreset}
        onClose={() => setCreating(false)}
        onCreate={async (input) => {
          await createEdge.mutateAsync(input);
        }}
      />

      <VersionsDialog
        open={versionsOpen}
        versions={versionsQuery.data?.versions ?? []}
        loading={versionsQuery.isLoading}
        onClose={() => setVersionsOpen(false)}
        onRollback={async (version, reason) => {
          await rollback.mutateAsync({ version, reason });
        }}
      />
    </div>
  );
}

function PersonSide(props: {
  personId: string;
  name: string;
  edges: Relationship[];
  nameOf: (id: string) => string;
  canWrite: boolean;
  onEditEdge: (e: Relationship) => void;
  onAddEdge: (otherId: string) => void;
  onClose: () => void;
  allPeople: string[];
}) {
  const { personId, edges, nameOf } = props;
  const kindText: Record<Relationship['kind'], string> = { parent: '父母', spouse: '配偶', sibling: '同胞', kin: '亲属' };
  return (
    <div className="card">
      <div className="card__head row--between">
        <h3 style={{ margin: 0 }}>{props.name}</h3>
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">✕</button>
      </div>
      {edges.length === 0 ? <p className="muted">还没有任何关系连线。</p> : null}
      <ul className="kinship-edge-list">
        {edges.map((e) => {
          const other = e.fromPersonId === personId ? e.toPersonId : e.fromPersonId;
          const text =
            e.kind === 'parent'
              ? e.fromPersonId === personId
                ? `是 ${nameOf(other)} 的父母/长辈`
                : `${nameOf(other)} 是 TA 的父母/长辈`
              : `与 ${nameOf(other)} 是${e.label ? `「${e.label}」` : kindText[e.kind]}`;
          return (
            <li key={e.id} className="kinship-edge-item">
              <span>
                {text}
                {e.source === 'suggested' ? <Tag tone="warn">待确认</Tag> : null}
                {e.source === 'derived' ? <Tag tone="success">推导</Tag> : null}
                {e.source === 'ignored' ? <Tag>已忽略</Tag> : null}
              </span>
              {props.canWrite ? (
                <Button size="sm" variant="ghost" onClick={() => props.onEditEdge(e)}>
                  校正
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.canWrite ? (
        <Button size="sm" onClick={() => props.onAddEdge(props.personId)}>
          从 TA 连一条新关系
        </Button>
      ) : null}
    </div>
  );
}

function InferPanel(props: {
  loading: boolean;
  suggestions: KinshipSuggestion[];
  skipped: number;
  nameOf: (id: string) => string;
  canWrite: boolean;
  busy: boolean;
  onAdoptOne: (s: KinshipSuggestion) => void;
  onSaveOne: (s: KinshipSuggestion) => void;
  onAdoptAll: () => void;
  onSaveAll: () => void;
}) {
  if (props.loading) return <Spinner />;
  return (
    <div>
      <div className="row--between" style={{ margin: '12px 0' }}>
        <p className="muted" style={{ margin: 0 }}>
          从物品共现与亲属称谓推导出 <strong>{props.suggestions.length}</strong> 条候选关系
          {props.skipped ? `（另有 ${props.skipped} 条已在图谱中）` : ''}。推导只做建议，采纳前不会改动图谱。
        </p>
        {props.canWrite && props.suggestions.length > 0 ? (
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" onClick={props.onSaveAll} disabled={props.busy}>
              全部暂存为待确认
            </Button>
            <Button size="sm" variant="primary" onClick={props.onAdoptAll} disabled={props.busy}>
              全部采纳
            </Button>
          </div>
        ) : null}
      </div>
      {props.suggestions.length === 0 ? (
        <EmptyState
          icon="🌿"
          title="暂时没有新的推导"
          description="试试：给人物填上「爸爸/外公/舅舅」这类关系称谓；在物品档案里把相关亲属一起标为来源或赠送/继承。"
        />
      ) : (
        <ul className="kinship-suggest-list">
          {props.suggestions.map((s, i) => (
            <li key={`${s.fromPersonId}-${s.toPersonId}-${s.kind}-${i}`} className="card kinship-suggest-item">
              <div>
                <strong>{props.nameOf(s.fromPersonId)}</strong>
                {s.kind === 'parent' ? ' → ' : ' ↔ '}
                <strong>{props.nameOf(s.toPersonId)}</strong>
                <Tag tone={s.confidence >= 0.85 ? 'success' : 'warn'}>
                  {s.kind === 'parent' ? '父母' : s.kind === 'spouse' ? '配偶' : s.kind === 'sibling' ? '同胞' : '亲属'} ·{' '}
                  {Math.round(s.confidence * 100)}%
                </Tag>
                {s.label ? <Tag>{s.label}</Tag> : null}
                <p className="muted" style={{ margin: '6px 0 0' }}>{s.reason}</p>
                <BasisTag s={s} />
              </div>
              {props.canWrite ? (
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => props.onSaveOne(s)} disabled={props.busy}>
                    暂存
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => props.onAdoptOne(s)} disabled={props.busy}>
                    采纳
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BasisTag({ s }: { s: KinshipSuggestion }) {
  const detail = s.basis?.detail as { itemTitle?: string; term?: string; text?: string } | undefined;
  if (s.basis?.type === 'item_cooccur') {
    return <p className="muted kinship-basis-line">依据：共同出现在「{detail?.itemTitle ?? '物品'}」</p>;
  }
  if (s.basis?.type === 'anchor') {
    return <p className="muted kinship-basis-line">依据：本人与「{detail?.term}」共现</p>;
  }
  if (s.basis?.type === 'compound_term') {
    return <p className="muted kinship-basis-line">依据：复合称谓「{detail?.text}」</p>;
  }
  if (s.basis?.type === 'item_roles') {
    return <p className="muted kinship-basis-line">依据：同一物品上的来源/继承角色（弱信号）</p>;
  }
  return null;
}

function IssuesPanel(props: {
  issues: KinshipIssue[];
  nameOf: (id: string) => string;
  canWrite: boolean;
  onFix: (e: Relationship) => void;
  edgesById: Map<string, Relationship>;
}) {
  if (props.issues.length === 0) {
    return (
      <EmptyState
        icon="✅"
        title="没有检测到矛盾"
        description="系统已检查年龄、辈分、重复父母、成环、称谓一致性等规则。新的矛盾会在每次打开图谱时实时检测。"
      />
    );
  }
  return (
    <ul className="kinship-issue-list">
      {props.issues.map((issue, i) => {
        const targetEdge = issue.edgeIds[0] ? props.edgesById.get(issue.edgeIds[0]) : undefined;
        return (
          <li key={i} className={`card kinship-issue kinship-issue--${issue.severity}`}>
            <div>
              <Tag tone={issue.severity === 'error' ? 'warn' : 'default'}>{issue.severity === 'error' ? '硬矛盾' : '提醒'}</Tag>
              <span style={{ marginLeft: 8 }}>{issue.message}</span>
            </div>
            {props.canWrite && targetEdge ? (
              <Button size="sm" variant="ghost" onClick={() => props.onFix(targetEdge)}>
                去校正
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
