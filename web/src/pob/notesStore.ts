import { create } from 'zustand';
import { bridge } from './bridge';
import type { Connection, NoteColour } from './types';

/**
 * The build's notes.
 *
 * One text buffer, and the only screen here where the browser is ahead of
 * the engine rather than behind it. Everywhere else the engine holds the
 * truth and this asks for it; here the user is typing, so the draft is the
 * truth until it has been pushed.
 *
 * That is why the draft lives in the store rather than in the component.
 * It has to survive the editor being unmounted by a tab switch, and it has
 * to be reachable by the flush that a tab switch triggers, neither of
 * which is true of a `useState` inside the view.
 */
interface NotesStore {
  connection: Connection;
  ready: boolean;

  /** What the engine has. */
  text: string;
  /** What is in the editor, which runs ahead of the engine while typing. */
  draft: string;
  /** PoB's own comparison of the buffer against what the file holds. */
  modified: boolean;
  saving: boolean;
  /** The engine's refusal, if it refused. */
  error: string | null;

  /** The colours the desktop tab offers, and what the digits resolve to. */
  palette: NoteColour[];
  digits: Record<string, string>;

  load(): Promise<void>;
  /** Take a keystroke. Pushing it is debounced. */
  edit(text: string): void;
  /** Push now, rather than when the debounce says so. */
  flush(): Promise<void>;
}

/**
 * Long enough that a sentence is one write rather than thirty, short
 * enough that walking away from the keyboard leaves the work safe.
 */
const SETTLE_MS = 500;

export const useNotesStore = create<NotesStore>((set, get) => {
  let timer: number | undefined;

  const push = async () => {
    window.clearTimeout(timer);
    timer = undefined;
    const text = get().draft;
    if (text === get().text) return;

    set({ saving: true, error: null });
    try {
      await bridge.act('setNotes', { text });
      set({ text, connection: 'live' });
      // Read it back rather than assuming. It confirms the engine took
      // the text, and `modified` is PoB's own comparison against the
      // file, which cannot be worked out on this side: typing the notes
      // back to what was loaded clears it, and only PoB knows that.
      await get().load();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        connection: 'live',
      });
    } finally {
      set({ saving: false });
    }
  };

  return {
    connection: 'connecting',
    ready: false,
    text: '',
    draft: '',
    modified: false,
    saving: false,
    error: null,
    palette: [],
    digits: {},

    load: async () => {
      try {
        const snapshot = await bridge.notes();
        if (!snapshot.ready) {
          set({ connection: 'live', ready: false });
          return;
        }
        const text = snapshot.text ?? '';
        set((state) => ({
          connection: 'live',
          ready: true,
          text,
          modified: snapshot.modified ?? false,
          palette: snapshot.palette ?? state.palette,
          digits: snapshot.digits ?? state.digits,
          // Only when the editor is not ahead. A reload landing in the
          // middle of a sentence must not take the sentence back.
          draft: state.draft === state.text ? text : state.draft,
        }));
      } catch {
        set({ connection: 'offline' });
      }
    },

    edit: (text) => {
      set({ draft: text });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void push(), SETTLE_MS);
    },

    flush: push,
  };
});
