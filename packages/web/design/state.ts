/** What the catalog shows; serialized into URL hashes so every view can be linked. */
export interface PreviewState {
  story: string;
  args: Record<string, unknown>;
  accent: string;
  mode: 'light' | 'dark';
}

export const VIEWPORTS = {
  auto: { label: '自動', width: 0, height: 0 },
  phone: { label: 'スマホ', width: 390, height: 844 },
  tablet: { label: 'タブレット', width: 768, height: 1024 },
  desktop: { label: 'PC', width: 1280, height: 800 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;

export function encodeState(s: PreviewState): string {
  return encodeURIComponent(JSON.stringify(s));
}

export function decodeState(hash: string): Partial<PreviewState> {
  try {
    const raw = hash.replace(/^#/, '');
    return raw ? (JSON.parse(decodeURIComponent(raw)) as Partial<PreviewState>) : {};
  } catch {
    return {};
  }
}
