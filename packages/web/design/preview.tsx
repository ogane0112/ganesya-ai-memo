/**
 * Renders one story with the app's real styles. The catalog loads this page in
 * an iframe (so phone widths get the real media queries) and updates the URL
 * hash to switch story, arguments or theme without reloading.
 */
import { Component, type ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '@fontsource-variable/nunito';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/app.css';
import { loadStorySets } from '../src/design/registry';
import { defaultArgs, storyId } from '../src/design/story';
import { decodeState, type PreviewState } from './state';

const sets = loadStorySets();
const stories = new Map(
  sets.flatMap((set) => set.stories.map((s, i) => [storyId(set, i), s] as const)),
);

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error)
      return (
        <pre className="notice notice-error" style={{ margin: 24, whiteSpace: 'pre-wrap' }}>
          このストーリーの描画でエラーが起きました:{'\n'}
          {this.state.error.message}
        </pre>
      );
    return this.props.children;
  }
}

function applyTheme(s: Partial<PreviewState>) {
  const root = document.documentElement;
  if (!s.accent || s.accent === 'green') delete root.dataset['accent'];
  else root.dataset['accent'] = s.accent;
  root.dataset['mode'] = s.mode === 'dark' ? 'dark' : 'light';
}

function Preview() {
  const [state, setState] = useState(() => decodeState(location.hash));
  useEffect(() => {
    const on = () => setState(decodeState(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  applyTheme(state);
  const id = state.story ?? [...stories.keys()][0]!;
  const story = stories.get(id);
  if (!story) return <p style={{ padding: 24 }}>ストーリーが見つかりません: {id}</p>;
  const args = { ...defaultArgs(story.controls), ...(state.args ?? {}) };
  const layout = story.layout ?? 'padded';
  return (
    <MemoryRouter>
      <Boundary key={id}>
        <div
          key={id}
          style={
            layout === 'fullscreen'
              ? { minHeight: '100vh' }
              : layout === 'centered'
                ? { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }
                : { padding: 24 }
          }
        >
          {story.render(args as never)}
        </div>
      </Boundary>
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
