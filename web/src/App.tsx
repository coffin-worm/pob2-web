import { useEffect } from 'react';
import { Header } from './header/Header';
import { Sidebar } from './sidebar/Sidebar';
import { EngineStatus } from './pob/EngineStatus';
import { startPolling, useBridgeStore } from './pob/bridgeStore';
import { startStatsPolling } from './pob/statsStore';
import styles from './App.module.css';

export default function App() {
  const state = useBridgeStore();

  useEffect(() => startPolling(), []);
  useEffect(() => startStatsPolling(), []);

  return (
    <div className={styles.app}>
      <Header {...state} />
      <div className={styles.columns}>
        <Sidebar />
        <main className={styles.body}>
          <EngineStatus />
          <p className={styles.note}>
            Header and stat sidebar, both on the real engine. PoB's Lua runs
            headless in a separate process; every stat on the left was
            filtered, calculated and formatted by it, and the main skill
            selectors change what it calculates.
          </p>
          <p className={styles.note}>
            This space is the rest of the application — the passive tree,
            items, skills and the calculation breakdown — which does not
            exist yet.
          </p>
        </main>
      </div>
    </div>
  );
}
