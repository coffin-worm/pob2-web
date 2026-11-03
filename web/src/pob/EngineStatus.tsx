import { Button } from '../ui/Button';
import { useBridgeStore } from './bridgeStore';
import styles from './EngineStatus.module.css';

/**
 * Whether the engine is there, and what it is waiting on.
 *
 * Temporary furniture for the prototype: in a finished app the connection is
 * the shell's problem and a dialog is drawn as a dialog. It is here because a
 * bridge that is invisible when it fails is the main way this architecture
 * can waste someone's afternoon.
 */
export function EngineStatus() {
  const connection = useBridgeStore((s) => s.connection);
  const ready = useBridgeStore((s) => s.ready);
  const error = useBridgeStore((s) => s.error);
  const popup = useBridgeStore((s) => s.popup);
  const newBuild = useBridgeStore((s) => s.newBuild);
  const dismiss = useBridgeStore((s) => s.dismissPopup);

  const title =
    connection === 'offline'
      ? 'Engine not reachable'
      : connection === 'connecting'
        ? 'Connecting to the engine…'
        : ready
          ? 'Live — the header above is the real build'
          : 'Engine running, no build open';

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <span className={styles.dot} data-state={connection} />
        <span className={styles.title}>{title}</span>
      </div>

      {connection === 'offline' && (
        <p className={styles.detail}>
          {error}. Start it with the working directory set to{' '}
          <code>src/</code>:{' '}
          <code>"C:\Program Files\LOVE\lovec.exe" C:\dev\pob2\bridge</code>
        </p>
      )}

      {connection === 'live' && !ready && (
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void newBuild()}>
            New build
          </Button>
        </div>
      )}

      {popup && (
        <div className={styles.popup}>
          The engine is waiting on a dialog: <strong>{popup.title}</strong>.
          PoB answers some commands with a modal rather than by doing the
          thing — changing class with an allocated tree, Save As, or Back with
          unsaved work. This UI does not draw dialogs yet.
          <div className={styles.actions}>
            <Button onClick={dismiss}>Dismiss</Button>
          </div>
        </div>
      )}
    </div>
  );
}
