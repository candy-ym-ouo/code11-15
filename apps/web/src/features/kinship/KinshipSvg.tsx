import { useMemo, useRef, useState } from 'react';
import type { Relationship } from '../../api/types';
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type Layout } from './layout';
import type { KinshipGraph } from '../../api/types';

interface Props {
  graph: KinshipGraph;
  showSuggested: boolean;
  highlightPerson: string | null;
  onSelectPerson: (id: string | null) => void;
  onEditEdge: (edge: Relationship) => void;
}

const KIND_COLOR: Record<Relationship['kind'], string> = {
  parent: '#2F4858',
  spouse: '#C1502E',
  sibling: '#5B7C5B',
  kin: '#8A7CA8',
};

const KIND_TEXT: Record<Relationship['kind'], string> = {
  parent: '父母',
  spouse: '配偶',
  sibling: '同胞',
  kin: '亲属',
};

const ROW_LABELS = ['祖辈', '父辈', '本人这代', '子辈', '孙辈'];

export function KinshipSvg({ graph, showSuggested, highlightPerson, onSelectPerson, onEditEdge }: Props) {
  const layout: Layout = useMemo(() => layoutGraph(graph, { showSuggested }), [graph, showSuggested]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  const personById = useMemo(() => new Map(graph.people.map((p) => [p.id, p])), [graph.people]);
  const edges = graph.edges.filter((e) => e.source !== 'ignored' && (showSuggested || e.source !== 'suggested'));

  const center = (id: string) => {
    const n = layout.nodes.get(id);
    if (!n) return { x: 0, y: 0 };
    return { x: 60 + n.col * (NODE_WIDTH + 32) + NODE_WIDTH / 2, y: 56 + n.row * (NODE_HEIGHT + 56) + NODE_HEIGHT / 2 };
  };

  const rowsTotal = layout.rows.length;

  return (
    <div className="kinship-canvas-wrap" ref={wrapRef}>
      <div className="kinship-toolbar">
        <button type="button" className="btn btn--sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}>
          －
        </button>
        <span className="muted" style={{ minWidth: 44, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className="btn btn--sm" onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.15).toFixed(2)))}>
          ＋
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setZoom(1)}>
          重置
        </button>
      </div>
      <div className="kinship-scroll">
        <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="家族关系图谱">
          {/* 代数行背景与行名 */}
          {Array.from({ length: rowsTotal }, (_, i) => i).map((r) => {
            const rel = layout.rows[r]!;
            const labelIndex = rel + 2;
            return (
              <g key={r}>
                <rect x={8} y={40 + r * (NODE_HEIGHT + 56)} width={layout.width - 16} height={NODE_HEIGHT + 32} rx={10} className="kinship-rowband" />
                <text x={20} y={62 + r * (NODE_HEIGHT + 56)} className="kinship-rowlabel">
                  {ROW_LABELS[labelIndex] ?? `第${rel}代`}
                </text>
              </g>
            );
          })}

          {/* 边 */}
          {edges.map((e) => {
            const a = center(e.fromPersonId);
            const b = center(e.toPersonId);
            const x1 = a.x;
            const y1 = a.y;
            const x2 = b.x;
            const y2 = b.y;
            const sameRow = Math.abs(y1 - y2) < 4;
            // 同代边画到节点侧面，跨代边画到底/顶
            const path = sameRow
              ? `M ${x1 + (x2 > x1 ? NODE_WIDTH / 2 : -NODE_WIDTH / 2)} ${y1} L ${x2 + (x2 > x1 ? -NODE_WIDTH / 2 : NODE_WIDTH / 2)} ${y2}`
              : `M ${x1} ${y1 + NODE_HEIGHT / 2} L ${x2} ${y2 - NODE_HEIGHT / 2}`;
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            const color = KIND_COLOR[e.kind];
            const dashed = e.source === 'suggested';
            const dim = highlightPerson && e.fromPersonId !== highlightPerson && e.toPersonId !== highlightPerson;
            const label = e.label ?? KIND_TEXT[e.kind];
            return (
              <g key={e.id} opacity={dim ? 0.18 : 1} className="kinship-edge">
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={e.kind === 'parent' ? 2 : 1.6}
                  strokeDasharray={dashed ? '5 4' : undefined}
                  markerEnd={e.kind === 'parent' ? `url(#arrow-${e.kind})` : undefined}
                />
                <g className="kinship-edge-label" onClick={() => onEditEdge(e)}>
                  <rect x={midX - 26} y={midY - 9} width={52} height={18} rx={9} fill="white" stroke={color} strokeWidth={1} />
                  <text x={midX} y={midY + 4} textAnchor="middle" fontSize={11} fill={color}>
                    {label.length > 5 ? `${label.slice(0, 4)}…` : label}
                  </text>
                </g>
              </g>
            );
          })}

          <defs>
            <marker id="arrow-parent" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={KIND_COLOR.parent} />
            </marker>
          </defs>

          {/* 节点 */}
          {graph.people.map((p) => {
            const n = layout.nodes.get(p.id);
            if (!n) return null;
            const x = 60 + n.col * (NODE_WIDTH + 32);
            const y = 40 + n.row * (NODE_HEIGHT + 56);
            const isHi = highlightPerson === p.id;
            const degree = edges.filter((e) => e.fromPersonId === p.id || e.toPersonId === p.id).length;
            return (
              <g
                key={p.id}
                transform={`translate(${x},${y})`}
                className="kinship-node"
                onClick={() => onSelectPerson(isHi ? null : p.id)}
              >
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={10}
                  className={isHi ? 'kinship-node-box kinship-node-box--active' : 'kinship-node-box'}
                />
                <text x={NODE_WIDTH / 2} y={24} textAnchor="middle" fontSize={14} fontWeight={600} className="kinship-node-name">
                  {p.name.length > 6 ? `${p.name.slice(0, 6)}…` : p.name}
                </text>
                <text x={NODE_WIDTH / 2} y={42} textAnchor="middle" fontSize={11} className="kinship-node-sub">
                  {p.relation && p.relation !== p.name ? p.relation : p.birthYear ? `${p.birthYear}${p.deathYear ? `–${p.deathYear}` : ''}` : '—'}
                </text>
                {degree === 0 ? <circle cx={NODE_WIDTH - 10} cy={10} r={4} className="kinship-node-orphan" /> : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
