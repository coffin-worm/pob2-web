import { Header } from './header/Header';
import { useMockStore } from './pob/mockStore';
import styles from './App.module.css';

export default function App() {
  const state = useMockStore();

  return (
    <div className={styles.app}>
      <Header {...state} />
      <main className={styles.body}>
        <p className={styles.note}>
          Header prototype. Everything below this line is the rest of the
          application, which does not exist yet.
        </p>
        <p className={styles.note}>
          The controls are live but the state is a mock, not the engine —
          change the class and the ascendancy list follows it, set a level
          and the passive budget moves, edit anything and the unsaved dot
          appears.
        </p>
      </main>
    </div>
  );
}
