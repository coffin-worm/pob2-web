import { useEffect, useRef, useState } from 'react';
import styles from './BuildTitle.module.css';

interface Props {
  name: string;
  unsaved: boolean;
  onRename: (name: string) => void;
}

/**
 * The build's name, as the document title it actually is.
 *
 * PoB shows it as "Current build:" followed by a read-only box wedged
 * between the Save buttons and the point display, and renaming happens in a
 * Save As dialog. Here it is the most prominent thing in the header,
 * because it is the thing the window is about, and clicking it renames.
 *
 * The unsaved mark is a dot rather than an asterisk in the string: it is
 * state, not part of the name, and it should not move the text when it
 * appears.
 */
export function BuildTitle({ name, unsaved, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
    setEditing(false);
  };

  return (
    <div className={styles.title}>
      {editing ? (
        <input
          ref={input}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className={styles.name}
          onClick={() => setEditing(true)}
          title="Rename build"
        >
          {name}
        </button>
      )}
      <span
        className={styles.dot}
        data-visible={unsaved || undefined}
        title={unsaved ? 'Unsaved changes' : undefined}
        aria-label={unsaved ? 'Unsaved changes' : undefined}
      />
    </div>
  );
}
