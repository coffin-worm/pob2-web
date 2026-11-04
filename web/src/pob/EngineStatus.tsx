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
  const engineError = useBridgeStore((s) => s.engineError);
  const newBuild = useBridgeStore((s) => s.newBuild);
  const dismissError = useBridgeStore((s) => s.dismissError);

  const title =
    connection === 'offline'
      ? 'Engine not reachable'
      : connection === 'connecting'
        ? 'Connecting to the engine…'
        : engineError
          ? 'The build stopped calculating'
          : ready
            ? 'Live — this is the real build'
            : 'Engine running, no build open';

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <span
          className={styles.dot}
          data-state={connection === 'live' && engineError ? 'error' : connection}
        />
        <span className={styles.title}>{title}</span>
      </div>

      {connection === 'offline' && (
        <p className={styles.detail}>
          {error}. The dev server starts the engine itself, so this usually
          means it could not find LÖVE — set <code>POB_LOVE</code> to{' '}
          <code>lovec.exe</code> and restart <code>npm run dev</code>. The
          terminal running it will say which.
        </p>
      )}

      {/* PoB records errors from its own frame handler instead of crashing,
          so without this a build whose calculations have died is
          indistinguishable from an empty one: a blank sidebar, no reason. */}
      {engineError && (
        <>
          <p className={styles.detail}>
            <code>{engineError}</code>
          </p>
          <div className={styles.actions}>
            <Button onClick={() => void dismissError()}>Dismiss</Button>
            <Button variant="primary" onClick={() => void newBuild()}>
              New build
            </Button>
          </div>
        </>
      )}

      {connection === 'live' && !ready && !engineError && (
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void newBuild()}>
            New build
          </Button>
        </div>
      )}

      {/* The dialog itself is drawn by EngineDialog, over everything. This
          line is what is left: the panel still accounts for the engine's
          state, and the modal is where it is answered. */}
      {popup && (
        <div className={styles.popup}>
          Waiting on <strong>{popup.title}</strong>.
        </div>
      )}
    </div>
  );
}
