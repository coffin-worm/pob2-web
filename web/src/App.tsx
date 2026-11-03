import { useEffect } from 'react';
import { Header } from './header/Header';
import { EngineStatus } from './pob/EngineStatus';
import { startPolling, useBridgeStore } from './pob/bridgeStore';
import styles from './App.module.css';

export default function App() {
  const state = useBridgeStore();

  useEffect(() => startPolling(), []);

  return (
    <div className={styles.app}>
      <Header {...state} />
      <main className={styles.body}>
        <EngineStatus />
        <p className={styles.note}>
          Header prototype, on the real engine. PoB's Lua runs headless in a
          separate process and serves its state over loopback HTTP; the
          controls above drive its own callbacks, so a class change rebuilds
          the passive tree and reloads the ascendancy list the same way the
          desktop app does.
        </p>
        <p className={styles.note}>
          Everything below this line is the rest of the application, which
          does not exist yet.
        </p>
      </main>
    </div>
  );
}
