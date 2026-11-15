/**
 * iOS only opens the on-screen keyboard for a focus() made during the tap
 * itself. A new memo's editor mounts after the tap (on the next page), so the
 * tap focuses a hidden field first; when the editor takes focus a moment
 * later, the keyboard stays open. Harmless elsewhere.
 */
export function primeKeyboard(): void {
  if (typeof document === 'undefined') return;
  const el = document.createElement('input');
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  // Big enough font that iOS does not zoom, invisible, off the layout.
  el.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;';
  document.body.appendChild(el);
  el.focus({ preventScroll: true });
  const drop = () => el.remove();
  el.addEventListener('blur', drop, { once: true });
  // If nothing takes the focus over (the page did not open an editor), give up.
  setTimeout(() => {
    if (document.activeElement === el) el.blur();
    drop();
  }, 1500);
}
