import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, NetworkError, onUnauthorized } from '../api/client';
import type { AuthState, NoteSummary } from '../api/types';
import type { QueueState } from '../lib/queue';
import { claimDevice } from '../lib/localData';
import { applyPrefs, normalizePrefs } from '../lib/theme';
import { syncQueue } from '../lib/sync';

const AUTH_CACHE = 'gmemo.lastAuth';
/** How often a visible app checks for changes made elsewhere. */
const POLL_MS = 15_000;

interface AppContextValue {
  /** null while loading. */
  auth: AuthState | null;
  /** The server could not be reached; `auth` comes from the last known state. */
  offlineAuth: boolean;
  refreshAuth: () => Promise<AuthState | null>;
  signedIn: boolean;
  notes: NoteSummary[];
  notesLoaded: boolean;
  refreshNotes: () => void;
  /** Where the notes are kept (null until known). GitHub saves take seconds. */
  storage: 'builtin' | 'github' | null;
  refreshStorage: () => void;
  paths: string[];
  /** Folders created on their own; folders that hold notes come from `notes`. */
  folders: string[];
  /** Increments whenever main changes (server-sent events). */
  changeTick: number;
  lastChange: { commit: string; paths: string[] } | null;
  openProposals: number;
  refreshProposals: () => void;
  queue: QueueState;
}

const Ctx = createContext<AppContextValue | null>(null);

function readCachedAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function writeCachedAuth(s: AuthState | null) {
  try {
    if (s?.user && s.session?.via === 'passkey')
      localStorage.setItem(
        AUTH_CACHE,
        JSON.stringify({ ...s, recoveryCodesRemaining: null, passkeyCount: null }),
      );
    else localStorage.removeItem(AUTH_CACHE);
  } catch {
    /* ignore */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [offlineAuth, setOfflineAuth] = useState(false);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [storage, setStorage] = useState<'builtin' | 'github' | null>(null);
  const refreshStorage = useCallback(() => {
    api
      .storage()
      .then((s) => setStorage(s.storage))
      .catch(() => undefined);
  }, []);
  const [changeTick, setChangeTick] = useState(0);
  const [lastChange, setLastChange] = useState<{ commit: string; paths: string[] } | null>(null);
  const [openProposals, setOpenProposals] = useState(0);
  const [queue, setQueue] = useState<QueueState>(syncQueue.snapshot);

  const refreshAuth = useCallback(async () => {
    try {
      const s = await api.authState();
      if (s.prefs) applyPrefs(normalizePrefs(s.prefs));
      setAuth(s);
      setOfflineAuth(false);
      writeCachedAuth(s);
      return s;
    } catch (e) {
      if (e instanceof NetworkError) {
        const cached = readCachedAuth();
        setAuth(
          cached ?? {
            needsSetup: false,
            signup: 'closed',
            user: null,
            session: null,
            rpId: location.hostname,
            origin: location.origin,
            recoveryCodesRemaining: null,
            passkeyCount: null,
          },
        );
        setOfflineAuth(true);
        return cached;
      }
      throw e;
    }
  }, []);

  useEffect(() => {
    void refreshAuth().catch(() =>
      setAuth({
        needsSetup: false,
        signup: 'closed',
        user: null,
        session: null,
        rpId: location.hostname,
        origin: location.origin,
        recoveryCodesRemaining: null,
        passkeyCount: null,
      }),
    );
    const onOnline = () => void refreshAuth().catch(() => undefined);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refreshAuth]);

  useEffect(() => {
    onUnauthorized(() => {
      setAuth((a) => (a ? { ...a, user: null, session: null } : a));
      writeCachedAuth(null);
    });
    return () => onUnauthorized(null);
  }, []);

  const signedIn = !!auth?.user && !!auth.session;

  const notesReq = useRef(0);
  const refreshNotes = useCallback(() => {
    const n = ++notesReq.current;
    api
      .notes()
      .then((list) => {
        if (n !== notesReq.current) return;
        setNotes(list);
        setNotesLoaded(true);
      })
      .catch(() => setNotesLoaded(true));
    api
      .folders()
      .then((list) => {
        if (n === notesReq.current) setFolders(list);
      })
      .catch(() => undefined);
  }, []);

  const refreshProposals = useCallback(() => {
    api
      .proposals('open')
      .then((p) => setOpenProposals(p.length))
      .catch(() => undefined);
  }, []);

  const userId = auth?.user?.id;
  const username = auth?.user?.username;
  useEffect(() => {
    if (!signedIn || auth?.session?.via === 'recovery' || !userId || !username) return;
    let cancelled = false;
    // Another account's offline copies and unsent writes are removed before anything runs.
    void claimDevice({ id: userId, username }).then(() => {
      if (cancelled) return;
      refreshNotes();
      refreshProposals();
      refreshStorage();
      syncQueue.resume();
    });
    return () => {
      cancelled = true;
    };
  }, [
    signedIn,
    auth?.session?.via,
    userId,
    username,
    refreshNotes,
    refreshProposals,
    refreshStorage,
  ]);

  // Changes from other devices and agents: a cheap poll while the app is visible
  // (serverless hosting cannot keep event streams open).
  useEffect(() => {
    if (!signedIn || offlineAuth || auth?.session?.via === 'recovery') return;
    let head: string | null | undefined;
    let proposals: number | undefined;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const p = await api.poll(head ?? undefined);
        if (head !== undefined && p.head !== head) {
          // Unknown paths ('*') make open notes re-check themselves.
          setLastChange({ commit: p.head ?? '', paths: p.paths ?? ['*'] });
          setChangeTick((t) => t + 1);
          refreshNotes();
        }
        if (proposals !== undefined && p.openProposals !== proposals) refreshProposals();
        else setOpenProposals(p.openProposals);
        head = p.head;
        proposals = p.openProposals;
      } catch {
        /* offline: try again on the next tick */
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedIn, offlineAuth, auth?.session?.via, refreshNotes, refreshProposals]);

  useEffect(() => {
    const off = syncQueue.subscribe(setQueue);
    const offResult = syncQueue.onResult((_item, outcome) => {
      if (outcome.type === 'proposed') refreshProposals();
    });
    return () => {
      off();
      offResult();
    };
  }, [refreshProposals]);

  useEffect(() => {
    const onFocus = () => {
      if (signedIn) refreshProposals();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signedIn, refreshProposals]);

  const paths = useMemo(() => notes.map((n) => n.path), [notes]);

  const value = useMemo<AppContextValue>(
    () => ({
      auth,
      offlineAuth,
      refreshAuth,
      signedIn,
      notes,
      notesLoaded,
      refreshNotes,
      storage,
      refreshStorage,
      paths,
      folders,
      changeTick,
      lastChange,
      openProposals,
      refreshProposals,
      queue,
    }),
    [
      auth,
      offlineAuth,
      refreshAuth,
      signedIn,
      notes,
      notesLoaded,
      refreshNotes,
      storage,
      refreshStorage,
      paths,
      folders,
      changeTick,
      lastChange,
      openProposals,
      refreshProposals,
      queue,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}
