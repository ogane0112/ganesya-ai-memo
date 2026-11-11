import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { describeError } from '../api/client';
import { Icon } from './Icon';

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function Loading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="error-box" role="alert">
      <strong>{title ?? '読み込めませんでした'}</strong>
      <p>{describeError(error)}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          再試行
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon = 'notes',
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={36} />
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  back,
  actions,
  sub,
}: {
  title: ReactNode;
  back?: () => void;
  actions?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <button type="button" className="icon-btn" onClick={back} aria-label="戻る">
          <Icon name="back" />
        </button>
      )}
      <div className="page-header-title">
        <h1>{title}</h1>
        {sub && <div className="page-header-sub">{sub}</div>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

/** Accessible modal built on <dialog>. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Own id: a modal can open on top of another one (the folder picker in a form).
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal modal-wide' : 'modal'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        // React passes this event up to the dialogs this one sits inside; Escape
        // should only close the one on top.
        e.stopPropagation();
        onClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} />
      {done ? 'コピーしました' : label}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ai' | 'ok' | 'warn' | 'danger' | 'accent';
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A one-time secret (token, recovery codes) with copy + "saved" confirmation. */
export function SecretReveal({
  title,
  lines,
  note,
  onDone,
  doneLabel = '保存しました',
  filename,
}: {
  title: string;
  lines: string[];
  note?: ReactNode;
  onDone: () => void;
  doneLabel?: string;
  filename?: string;
}) {
  const [ack, setAck] = useState(false);
  const text = lines.join('\n');
  return (
    <div className="secret-reveal">
      <h3>{title}</h3>
      {note && <div className="hint">{note}</div>}
      <pre className="secret-box" tabIndex={0}>
        {text}
      </pre>
      <div className="row wrap">
        <CopyButton text={text} />
        {filename && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Icon name="download" size={16} />
            ファイルに保存
          </button>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        安全な場所に保存しました(この画面を閉じると二度と表示されません)
      </label>
      <button type="button" className="btn btn-primary btn-block" disabled={!ack} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
