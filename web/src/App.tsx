import { useEffect, useState } from 'react';
import { Header } from './header/Header';
import { Sidebar } from './sidebar/Sidebar';
import { CalcsView } from './calcs/CalcsView';
import { ItemsView } from './items/ItemsView';
import { SkillsView } from './skills/SkillsView';
import { ConfigView } from './config/ConfigView';
import { NotesView } from './notes/NotesView';
import { PortView } from './port/PortView';
import { BuildsView } from './builds/BuildsView';
import { CompareView } from './compare/CompareView';
import { TreeView } from './tree/TreeView';
import { EngineStatus } from './pob/EngineStatus';
import { EngineDialog } from './pob/EngineDialog';
import { Segmented } from './ui/Segmented';
import { startPolling, useBridgeStore } from './pob/bridgeStore';
import { startStatsPolling } from './pob/statsStore';
import { useCalcsStore } from './pob/calcsStore';
import { useTreeStore } from './pob/treeStore';
import styles from './App.module.css';

type Tab =
  | 'tree'
  | 'items'
  | 'skills'
  | 'config'
  | 'calcs'
  | 'notes'
  | 'port'
  | 'builds'
  | 'compare';

export default function App() {
  const state = useBridgeStore();
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const refreshCalcs = useCalcsStore((s) => s.refresh);
  const refreshAlloc = useTreeStore((s) => s.refreshAlloc);

  const [tab, setTab] = useState<Tab>('tree');

  useEffect(() => startPolling(), []);
  useEffect(() => startStatsPolling(), []);

  // Both of these are fetched when the engine says it recalculated rather
  // than on timers of their own: the Calcs payload is expensive to build,
  // and the allocation only ever changes as a result of a recalculation.
  useEffect(() => {
    void refreshCalcs();
    void refreshAlloc();
  }, [outputRevision, refreshCalcs, refreshAlloc]);

  return (
    <div className={styles.app}>
      {/* Outside the column layout: a dialog the engine is waiting on
          blocks every screen, not the one you happen to be looking at. */}
      <EngineDialog />
      <Header {...state} />
      <div className={styles.columns}>
        <Sidebar />
        <main className={styles.body}>
          <EngineStatus />
          <Segmented
            aria-label="View"
            value={tab}
            onChange={(value) => setTab(value as Tab)}
            options={[
              { value: 'tree', label: 'Tree', title: 'The passive tree' },
              { value: 'items', label: 'Items', title: 'Equipment and the item list' },
              { value: 'skills', label: 'Skills', title: 'Socket groups and gems' },
              { value: 'config', label: 'Config', title: 'Everything the engine has to be told' },
              { value: 'calcs', label: 'Calcs', title: 'Calculation breakdown' },
              { value: 'notes', label: 'Notes', title: "The build's own notes" },
              { value: 'compare', label: 'Compare', title: 'This build against another' },
              { value: 'port', label: 'Import', title: 'Build codes in and out' },
              { value: 'builds', label: 'Builds', title: 'Open, save and manage build files' },
            ]}
          />
          {/* Both are kept mounted: the tree holds 420 kB of geometry and a
              fitted camera, and throwing those away on a tab switch would
              make the switch feel like a page load. */}
          <div className={styles.panel} hidden={tab !== 'tree'}>
            <TreeView />
          </div>
          {/* Items is unmounted when hidden, unlike the other two: it holds
              no camera and no large payload, and keeping it mounted would
              keep it polling the engine for a screen nobody is looking at. */}
          {tab === 'items' && (
            <div className={styles.panel}>
              <ItemsView />
            </div>
          )}
          {tab === 'skills' && (
            <div className={styles.panel}>
              <SkillsView />
            </div>
          )}
          {tab === 'config' && (
            <div className={styles.panel}>
              <ConfigView />
            </div>
          )}
          <div className={styles.panel} hidden={tab !== 'calcs'}>
            <CalcsView />
          </div>
          {/* Unmounted when hidden like the rest, which is also what
              flushes a half-typed note to the engine: the editor pushes
              on its way out. */}
          {tab === 'notes' && (
            <div className={styles.panel}>
              <NotesView />
            </div>
          )}
          {tab === 'port' && (
            <div className={styles.panel}>
              <PortView />
            </div>
          )}
          {tab === 'builds' && (
            <div className={styles.panel}>
              <BuildsView />
            </div>
          )}
          {tab === 'compare' && (
            <div className={styles.panel}>
              <CompareView />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
