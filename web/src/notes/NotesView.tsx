import { useEffect, useMemo, useRef } from 'react';
import { useNotesStore } from '../pob/notesStore';
import styles from './NotesView.module.css';

/**
 * The Notes tab.
 *
 * The one screen here that holds no engine state at all. The notes are
 * free text on the build, saved into its XML by `NotesTab:Save` and read
 * by nothing else, so there is no calculation to be faithful to and the
 * only question is how to edit them.
 *
 * PoB answers that with one widget and a toggle. Its notes carry caret
 * escapes, `^xRRGGBB` and `^0` to `^9`, which colour everything after
 * them, and its editor renders those colours rather than showing them. So
 * to see what you typed you press "Show Color Codes", which rewrites every
 * `^` in the buffer to `^_` and gives up the colours while you look. One
 * widget, two jobs, neither done at once.
 *
 * Two widgets costs nothing on this side, so the editor shows the text and
 * the preview shows the colours, and the toggle is not needed.
 */

/** A run of text in one colour, which is all these escapes amount to. */
interface Run {
  text: string;
  hex: string | null;
}

/**
 * One escape. Global, so the scans below can walk a string; every `exec`
 * loop resets `lastIndex` first, and `replace` resets it on its own.
 */
const ESCAPE = /\^(?:[xX]([0-9a-fA-F]{6})|(\d))/g;

/**
 * Split the notes into coloured runs.
 *
 * An escape sets the colour of everything after it until the next one.
 * There is no closing form and no nesting, because this is a renderer's
 * instruction rather than a markup language, which is why this is a fold
 * over the string rather than a parse of it.
 */
function runsOf(text: string, digits: Record<string, string>): Run[] {
  const runs: Run[] = [];
  let hex: string | null = null;
  let at = 0;

  ESCAPE.lastIndex = 0;
  let match = ESCAPE.exec(text);
  while (match) {
    if (match.index > at) runs.push({ text: text.slice(at, match.index), hex });
    hex = match[1] ? `#${match[1].toLowerCase()}` : (digits[match[2] ?? ''] ?? null);
    at = match.index + match[0].length;
    match = ESCAPE.exec(text);
  }
  if (at < text.length) runs.push({ text: text.slice(at), hex });
  return runs;
}

/** The colour in effect at a position, which is the last escape before it. */
function colourAt(text: string, index: number): string | null {
  const before = text.slice(0, index);
  let last: string | null = null;
  ESCAPE.lastIndex = 0;
  let match = ESCAPE.exec(before);
  while (match) {
    last = match[0];
    match = ESCAPE.exec(before);
  }
  return last;
}

export function NotesView() {
  const ready = useNotesStore((s) => s.ready);
  const draft = useNotesStore((s) => s.draft);
  const text = useNotesStore((s) => s.text);
  const modified = useNotesStore((s) => s.modified);
  const saving = useNotesStore((s) => s.saving);
  const error = useNotesStore((s) => s.error);
  const palette = useNotesStore((s) => s.palette);
  const digits = useNotesStore((s) => s.digits);
  const load = useNotesStore((s) => s.load);
  const edit = useNotesStore((s) => s.edit);
  const flush = useNotesStore((s) => s.flush);

  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // Leaving the tab unmounts this, and the debounce would go with it. The
  // flush is what makes a tab switch mid-sentence safe rather than a way
  // to lose the sentence.
  useEffect(() => () => void flush(), [flush]);

  const runs = useMemo(() => runsOf(draft, digits), [draft, digits]);

  /**
   * Insert a colour, or recolour the selection.
   *
   * PoB's own gesture, with one change. When it wraps a selection it
   * closes with the last colour found inside it, falling back to white,
   * so colouring three words in the middle of a yellow line leaves the
   * rest of that line white. Closing with the colour that was in effect
   * before the selection is what was actually meant, and it leaves the
   * file identical in every other respect.
   */
  const applyColour = (code: string) => {
    const el = area.current;
    if (!el) return;
    const from = el.selectionStart;
    const to = el.selectionEnd;

    let next: string;
    let caret: number;
    if (from === to) {
      next = draft.slice(0, from) + code + draft.slice(from);
      caret = from + code.length;
    } else {
      const inner = draft.slice(from, to).replace(ESCAPE, '');
      const after = colourAt(draft, from) ?? '^7';
      next = draft.slice(0, from) + code + inner + after + draft.slice(to);
      caret = from + code.length + inner.length;
    }

    edit(next);
    // After the state lands, so the textarea has the new value to put the
    // caret into.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  if (!ready) {
    return <p className={styles.empty}>Waiting for the engine.</p>;
  }

  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        <div className={styles.palette}>
          {palette.map((colour) => (
            <button
              key={colour.name}
              className={styles.swatch}
              style={{ color: colour.hex }}
              onClick={() => applyColour(colour.code)}
              title={`Insert ${colour.code}, or recolour the selection`}
            >
              {colour.name.toLowerCase()}
            </button>
          ))}
        </div>

        <span className={styles.state}>
          {error ? (
            <span className={styles.error}>{error}</span>
          ) : saving ? (
            'Saving…'
          ) : draft !== text ? (
            'Typing…'
          ) : modified ? (
            'In the build, not in the file yet'
          ) : (
            'Saved'
          )}
        </span>
      </div>

      <div className={styles.panes}>
        <textarea
          ref={area}
          className={styles.editor}
          value={draft}
          onChange={(event) => edit(event.target.value)}
          onBlur={() => void flush()}
          spellCheck={false}
          placeholder="Levelling order, gear targets, anything you would otherwise keep in a second window."
          aria-label="Build notes"
        />

        {/* Not a second editor: this is what the desktop app draws, and
            what anyone opening the build there will see. */}
        <div className={styles.preview} aria-label="Preview">
          {draft ? (
            runs.map((run, index) => (
              <span key={index} style={run.hex ? { color: run.hex } : undefined}>
                {run.text}
              </span>
            ))
          ) : (
            <span className={styles.hint}>
              Nothing yet. A caret and six hex digits set a colour, as in
              {' '}<code>^xFFFF77</code>, and it holds until the next one.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
