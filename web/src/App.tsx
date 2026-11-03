import { useEffect } from 'react';
import { Header } from './header/Header';
import { Sidebar } from './sidebar/Sidebar';
import { CalcsView } from './calcs/CalcsView';
import { EngineStatus } from './pob/EngineStatus';
import { startPolling, useBridgeStore } from './pob/bridgeStore';
import { startStatsPolling } from './pob/statsStore';
import { useCalcsStore } from './pob/calcsStore';
import styles from './App.module.css';

export default function App() {
  const state = useBridgeStore();
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const refreshCalcs = useCalcsStore((s) => s.refresh);

  useEffect(() => startPolling(), []);
  useEffect(() => startStatsPolling(), []);

  // The Calcs payload is the expensive one, so it is fetched when the engine
  // says it recalculated rather than on a timer of its own.
  useEffect(() => {
    void refreshCalcs();
  }, [outputRevision, refreshCalcs]);

  return (
    <div className={styles.app}>
      <Header {...state} />
      <div className={styles.columns}>
        <Sidebar />
        <main className={styles.body}>
          <EngineStatus />
          <CalcsView />
        </main>
      </div>
    </div>
  );
}
