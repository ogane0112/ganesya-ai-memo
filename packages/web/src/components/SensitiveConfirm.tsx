import type { PublicFinding } from '../api/types';
import { Modal } from './ui';

export function FindingList({ findings }: { findings: PublicFinding[] }) {
  return (
    <ul className="findings">
      {findings.map((f, i) => (
        <li key={`${f.fingerprint}-${i}`}>
          <span className="finding-label">{f.label}</span>
          <code className="finding-preview">{f.preview}</code>
        </li>
      ))}
    </ul>
  );
}

/** 428: the server found sensitive data and asks for explicit confirmation before sending it to an external AI. */
export function SensitiveConfirm({
  findings,
  onConfirm,
  onCancel,
  open,
}: {
  findings: PublicFinding[];
  onConfirm: () => void;
  onCancel: () => void;
  open: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="機密情報が含まれている可能性があります"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            送信しない
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            確認して送信
          </button>
        </>
      }
    >
      <p>外部AIに送る内容に、次の情報が見つかりました。送信してよいか確認してください。</p>
      <FindingList findings={findings} />
      <p className="hint">
        機密検出は補助であり完全ではありません。基本はフォルダ単位の送信制御で守ってください。
      </p>
    </Modal>
  );
}
