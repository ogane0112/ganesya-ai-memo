import { type ReactNode, useRef, useState } from 'react';

/**
 * A card that can be swiped right (approve) or left (reject). Buttons inside
 * the card offer the same actions for keyboard / screen reader users.
 */
export function SwipeCard({
  children,
  onSwipeRight,
  onSwipeLeft,
  rightLabel = '承認',
  leftLabel = '却下',
  disabled,
}: {
  children: ReactNode;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  rightLabel?: string;
  leftLabel?: string;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<0 | 1 | -1>(0);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(
    null,
  );
  const el = useRef<HTMLDivElement>(null);

  const threshold = () => Math.min(140, (el.current?.offsetWidth ?? 300) * 0.33);

  const onDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.horizontal === null) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      s.horizontal = Math.abs(mx) > Math.abs(my);
      if (s.horizontal) el.current?.setPointerCapture(e.pointerId);
    }
    if (s.horizontal) setDx(mx);
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId || !s.horizontal) {
      setDx(0);
      return;
    }
    const t = threshold();
    if (dx > t) {
      setLeaving(1);
      setTimeout(onSwipeRight, 180);
    } else if (dx < -t) {
      setLeaving(-1);
      setTimeout(onSwipeLeft, 180);
    }
    setTimeout(() => {
      setDx(0);
      setLeaving(0);
    }, 200);
  };

  const t = threshold();
  const progress = Math.min(1, Math.abs(dx) / t);
  const offset = leaving ? leaving * 600 : dx;
  return (
    <div className="swipe">
      <div
        className={`swipe-bg ${dx > 0 ? 'swipe-bg-right' : dx < 0 ? 'swipe-bg-left' : ''}`}
        aria-hidden="true"
        style={{ opacity: progress }}
      >
        <span>{rightLabel}</span>
        <span>{leftLabel}</span>
      </div>
      <div
        ref={el}
        className="swipe-card"
        style={{
          transform: `translateX(${offset}px) rotate(${offset / 60}deg)`,
          transition: start.current ? 'none' : 'transform .2s ease',
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {children}
      </div>
    </div>
  );
}
