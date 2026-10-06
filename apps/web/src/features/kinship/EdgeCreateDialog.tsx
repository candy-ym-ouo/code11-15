import { useState } from 'react';
import type { KinshipGraph, KinshipKind } from '../../api/types';
import { Button, Field, Modal, Select, TextArea, TextInput } from '../../components/ui';

interface Props {
  open: boolean;
  graph: KinshipGraph;
  preset?: { fromId?: string; toId?: string };
  onClose: () => void;
  onCreate: (input: {
    fromPersonId: string;
    toPersonId: string;
    kind: KinshipKind;
    label: string | null;
    note: string | null;
  }) => Promise<void>;
}

export function EdgeCreateDialog({ open, graph, preset, onClose, onCreate }: Props) {
  const [fromId, setFromId] = useState(preset?.fromId ?? '');
  const [toId, setToId] = useState(preset?.toId ?? '');
  const [kind, setKind] = useState<KinshipKind>('parent');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options = graph.people
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const submit = async () => {
    setError(null);
    if (!fromId || !toId) {
      setError('请选择两端人物');
      return;
    }
    if (fromId === toId) {
      setError('不能把一个人与自己建立关系');
      return;
    }
    setBusy(true);
    try {
      await onCreate({ fromPersonId: fromId, toPersonId: toId, kind, label: label.trim() || null, note: note.trim() || null });
      onClose();
      setLabel('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="手工添加亲属关系"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={kind === 'parent' ? '父母/长辈' : '人物 A'} required>
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="">选择人物…</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.relation && p.relation !== p.name ? `（${p.relation}）` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={kind === 'parent' ? '子女/晚辈' : '人物 B'} required>
          <Select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">选择人物…</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.relation && p.relation !== p.name ? `（${p.relation}）` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="关系类型">
        <Select value={kind} onChange={(e) => setKind(e.target.value as KinshipKind)}>
          <option value="parent">父母 / 子女</option>
          <option value="spouse">配偶</option>
          <option value="sibling">同胞（兄弟姐妹）</option>
          <option value="kin">其他亲属</option>
        </Select>
      </Field>
      <Field label="称谓（选填）" hint={kind === 'parent' ? '长辈的称谓，如「爷爷」' : '如「堂表亲」'}>
        <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
      </Field>
      <Field label="备注（选填）">
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      {error ? <p className="field__error" role="alert">{error}</p> : null}
    </Modal>
  );
}
