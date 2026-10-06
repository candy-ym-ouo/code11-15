import { useState } from 'react';
import type { KinshipKind, Relationship } from '../../api/types';
import { Button, Field, Modal, Select, TextArea, TextInput } from '../../components/ui';

const KINDS: { value: KinshipKind; label: string }[] = [
  { value: 'parent', label: '父母/子女（有方向：A 是 B 的父母）' },
  { value: 'spouse', label: '配偶' },
  { value: 'sibling', label: '同胞（兄弟姐妹）' },
  { value: 'kin', label: '其他亲属' },
];

const SOURCE_LABEL: Record<Relationship['source'], string> = {
  manual: '手工录入',
  derived: '推导已采纳',
  suggested: '待确认建议',
  ignored: '已人工忽略',
};

interface Props {
  open: boolean;
  edge: Relationship | null;
  nameOf: (id: string) => string;
  onClose: () => void;
  onSave: (patch: { kind?: KinshipKind; label?: string | null; note?: string | null; source?: Relationship['source'] }) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}

export function EdgeEditDialog({ open, edge, nameOf, onClose, onSave, onDelete }: Props) {
  const [kind, setKind] = useState<KinshipKind>(edge?.kind ?? 'parent');
  const [label, setLabel] = useState(edge?.label ?? '');
  const [note, setNote] = useState(edge?.note ?? '');
  const [source, setSource] = useState<Relationship['source']>(edge?.source ?? 'manual');
  const [busy, setBusy] = useState(false);

  if (!edge) return null;

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        kind: kind !== edge.kind ? kind : undefined,
        label: label.trim() === (edge.label ?? '') ? undefined : label.trim() || null,
        note: note.trim() === (edge.note ?? '') ? undefined : note.trim() || null,
        source: source !== edge.source ? source : undefined,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="校正亲属关系"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" onClick={del} loading={busy}>
            删除这条关系
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            保存校正
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        <strong>{nameOf(edge.fromPersonId)}</strong>
        {kind === 'parent' ? ' 是 ' : ' ↔ '}
        <strong>{nameOf(edge.toPersonId)}</strong>
        {kind === 'parent' ? ' 的父母/长辈' : ''}
      </p>
      <Field label="关系类型">
        <Select value={kind} onChange={(e) => setKind(e.target.value as KinshipKind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="称谓（选填）" hint="例如「外公」「二舅」；父母边表示长辈的称谓">
        <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="如：外公" />
      </Field>
      <Field label="备注（选填）" hint="校正原因、依据，会留在版本历史里">
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <Field label="状态">
        <Select value={source} onChange={(e) => setSource(e.target.value as Relationship['source'])}>
          {(Object.keys(SOURCE_LABEL) as Relationship['source'][]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      {edge.basis ? (
        <details className="kinship-basis">
          <summary>系统推导依据</summary>
          <pre>{JSON.stringify(edge.basis, null, 2)}</pre>
        </details>
      ) : null}
    </Modal>
  );
}
