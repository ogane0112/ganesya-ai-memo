const KEY = 'gmemo.deviceName';

function guessDevice(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Androidスマホ' : 'Androidタブレット';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'この端末';
}

/** Name sent with every save so conflict proposals say which device the edit came from. */
export function deviceName(): string {
  try {
    return localStorage.getItem(KEY) || guessDevice();
  } catch {
    return guessDevice();
  }
}

export function setDeviceName(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(KEY, name.trim().slice(0, 40));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
