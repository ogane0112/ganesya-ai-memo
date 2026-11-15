import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { NoteEditor } from '../components/NoteEditor';
import { useDocumentTitle } from '../lib/hooks';
import { noteUrl } from '../lib/paths';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

/**
 * A new memo, like iOS Notes: it opens empty and ready to type, the first line
 * is its title, and where it is saved is asked on "完了". `home` is the "書く"
 * tab: after saving it starts the next memo instead of leaving. `?folder=`
 * (from a folder's "add note") is offered first in the save sheet.
 */
export function NewNotePage({ home = false }: { home?: boolean }) {
  useDocumentTitle(home ? '書く' : '新しいメモ');
  const [params] = useSearchParams();
  const folder = (params.get('folder') ?? '').replace(/^\/+|\/+$/g, '');
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshNotes } = useApp();
  // A fresh editor for the next memo (home screen).
  const [round, setRound] = useState(0);
  return (
    <NoteEditor
      key={round}
      path={null}
      content={null}
      sha={null}
      home={home}
      {...(folder ? { folder } : {})}
      onDone={(path) => {
        if (path) refreshNotes();
        if (home) {
          if (path)
            toast.show('保存しました', {
              kind: 'success',
              action: { label: '開く', onClick: () => navigate(noteUrl(path)) },
            });
          setRound((r) => r + 1);
          return;
        }
        if (path) navigate(noteUrl(path), { replace: true });
        else if (window.history.length > 1) navigate(-1);
        else navigate(folder ? `/notes?folder=${encodeURIComponent(folder)}` : '/notes');
      }}
    />
  );
}
