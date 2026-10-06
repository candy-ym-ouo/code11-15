import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { KinEdge, KinGraph } from '../../api/types';
import { KIN_EDGE_LABELS } from '../../lib/constants';
import { NODE_SIZE, edgeEndpoints, layoutGraph } from './graphLayout';

interface Props {
  graph: KinGraph;
  familyId: string;
  highlightEdgeIds?: Set<string>;
  highlightPersonIds?: Set<string>;
  onAddEdge?: () => void;
  onSelectEdge?: (edge: KinEdge) => void;
}

/**
 * SVG 分层家谱图。
 * - parent 边画成上下竖线（有方向箭头）；
 * - partner / sibling 画在同代两人之间，用颜色区分；
 * - 未确认（推导出来还没人工采纳）的边画虚线。
 */
export function KinGraphSvg({ graph, familyId, highlightEdgeIds, highlightPersonIds, onAddEdge, onSelectEdge }: Props) {
  const layout = layoutGraph(graph.people, graph.edges, graph.anchorPersonId);
  const [hovered, setHovered] = useState<string | null>(null);

  if (graph.people.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon" aria-hidden="true">🧬</div>
        <h3 className="empty__title">还没有人物可以成图</h3>
        <p className="empty__desc">先到「人物」里建档（称呼填「爸爸」「外公」这类），再来这里生成关系图谱。</p>
        <Link className="btn btn--primary" to={`/f/${familyId}/people`}>去建人物</Link>
      </div>
    );
  }

  return (
    <div className="kin-canvas-wrap">
      <svg className="kin-canvas" width={layout.width} height={layout.height} role="img" aria-label="家族关系图谱">
        {/* 边 */}
        {graph.edges.map((edge) => {
          const { from, to } = edgeEndpoints(edge, layout);
          if (!from || !to) return null;
          const highlighted = highlightEdgeIds?.has(edge.id);
          const dimmed = highlightEdgeIds && !highlighted;
          const isParent = edge.type === 'parent';
          const x1 = from.x + NODE_SIZE.width / 2;
          const y1 = isParent ? from.y + NODE_SIZE.height : from.y + NODE_SIZE.height / 2;
          const x2 = to.x + NODE_SIZE.width / 2;
          const y2 = isParent ? to.y : to.y + NODE_SIZE.height / 2;
          const midY = (y1 + y2) / 2;
          const path = isParent
            ? `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`
            : `M ${x1} ${y1} H ${x2}`;
          const color = edge.type === 'partner' ? '#b05a4a' : edge.type === 'sibling' ? '#4a6fa5' : '#2F4858';
          return (
            <g key={edge.id} className={dimmed ? 'kin-edge kin-edge--dim' : 'kin-edge'} opacity={dimmed ? 0.25 : 1}>
              <path
                d={path}
                fill="none"
                stroke={highlighted ? '#d98c2b' : color}
                strokeWidth={highlighted ? 3 : 1.6}
                strokeDasharray={edge.confirmed ? undefined : '6 4'}
                markerEnd={isParent ? 'url(#kin-arrow)' : undefined}
              />
              <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: onSelectEdge ? 'pointer' : undefined }}
                onMouseEnter={() => setHovered(edge.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelectEdge?.(edge)}
              />
              {(hovered === edge.id || highlighted) && (
                <g pointerEvents="none">
                  <rect x={(x1 + x2) / 2 - 46} y={midY - 24} width={92} height={20} rx={4} fill="#2F4858" />
                  <text x={(x1 + x2) / 2} y={midY - 10} textAnchor="middle" fontSize={11} fill="#fff">
                    {KIN_EDGE_LABELS[edge.type]}
                    {edge.confirmed ? '' : '（待确认）'}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 箭头定义 */}
        <defs>
          <marker id="kin-arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#2F4858" />
          </marker>
        </defs>

        {/* 节点 */}
        {layout.people.map((p) => {
          const isAnchor = p.id === graph.anchorPersonId;
          const highlighted = highlightPersonIds?.has(p.id);
          return (
            <g key={p.id} transform={`translate(${p.x},${p.y})`}>
              <rect
                width={NODE_SIZE.width}
                height={NODE_SIZE.height}
                rx={10}
                fill={isAnchor ? '#ffe9c2' : highlighted ? '#fdf0d5' : '#fffdf8'}
                stroke={highlighted ? '#d98c2b' : '#2F4858'}
                strokeWidth={isAnchor || highlighted ? 2 : 1}
              />
              <circle cx={14} cy={16} r={4} fill={p.gender === 'female' ? '#b05a4a' : p.gender === 'male' ? '#4a6fa5' : '#9aa5ad'} />
              <text x={26} y={20} fontSize={13} fontWeight={600} fill="#2F4858">
                {p.name.length > 7 ? `${p.name.slice(0, 7)}…` : p.name}
              </text>
              <text x={12} y={38} fontSize={11} fill="#6b7780">
                {p.derivedTitle ?? p.relation ?? (isAnchor ? '锚点人物' : '—')}
              </text>
              <text x={12} y={54} fontSize={10} fill="#9aa5ad">
                {[p.birthYear, p.deathYear].filter(Boolean).join('–') || '生卒年未记'}
              </text>
              {isAnchor ? (
                <text x={NODE_SIZE.width - 10} y={16} textAnchor="end" fontSize={13} aria-label="锚点">⭐</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {onAddEdge ? (
        <button type="button" className="btn btn--secondary btn--sm kin-canvas__add" onClick={onAddEdge}>
          ＋ 手动补关系
        </button>
      ) : null}
    </div>
  );
}
