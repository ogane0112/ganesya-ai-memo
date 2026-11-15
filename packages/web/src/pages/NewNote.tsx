import { useNavigate, useSearchParams } from 'react-router-dom';
import { NoteEditor } from '../components/NoteEditor';
import { useDocumentTitle } from '../lib/hooks';
import { noteUrl } from '../lib/paths';
import { useApp } from '../state/app';

/**
 * A new memo, like iOS Notes: it opens empty and ready to type; the first
 * line becomes its title and file name when it is first saved; leaving it
 * empty creates nothing. `?folder=` says where it goes (default: the top).
 */
export function NewNotePage() {
  useDocumentTitle('新しいメモ');
  const [params] = useSearchParams();
  const folder = (params.get('folder') ?? '').replace(/^\/+|\/+$/g, '');
  const navigate = useNavigate();
  const { refreshNotes } = useApp();
  return (
    <NoteEditor
      path={null}
      folder={folder}
      content={null}
      sha={null}
      onDone={(path) => {
        if (path) {
          refreshNotes();
          navigate(noteUrl(path), { replace: true });
        } else if (window.history.length > 1) navigate(-1);
        else navigate(folder ? `/notes?folder=${encodeURIComponent(folder)}` : '/notes');
      }}
    />
  );
}
