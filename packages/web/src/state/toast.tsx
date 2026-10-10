import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface ToastOptions {
  kind?: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
  /** ms; 0 = until dismissed */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: number;
  message: string;
}

interface ToastApi {
  show: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, message, ...opts }]);
      const duration = opts.duration ?? (opts.kind === 'error' ? 7000 : 4000);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind ?? 'info'}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              aria-label="閉じる"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}
