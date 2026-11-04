import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../pob/bridge';
import { useBridgeStore } from '../pob/bridgeStore';
import { useBuildsStore } from '../pob/buildsStore';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import type { BuildEntry, BuildSort } from '../pob/types';
import styles from './BuildsView.module.css';

/**
 * The builds folder.
 *
 * The scan is PoB's: `Modules/BuildListHelpers` is already UI-free, and it
 * reads the class, ascendancy and level out of the first 2 kB of each file
 * rather than loading the build, which is what makes listing a folder
 * cheap. The sort is its `SortList`, so folders come first and the natural
 * ordering matches the desktop app's.
 *
 * None of it worked until the bridge supplied a filesystem: the headless
 * wrapper stubs `NewFileSearch` to return nothing, and PoB's scanner is
 * built entirely on it, so the folder came back empty rather than broken.
 *
 * The folder is the one the desktop app uses, so builds saved here show up
 * there and the other way round.
 */

const SORTS: { value: BuildSort; label: string; title: string }[] = [
  { value: 'EDITED', label: 'Edited', title: 'Most recently edited first' },
  { value: 'NAME', label: 'Name', title: 'Alphabetical' },
  { value: 'CLASS', label: 'Class', title: 'Grouped by class' },
  { value: 'LEVEL', label: 'Level', title: 'Highest level first' },
];

function when(seconds?: number) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days < 1) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function BuildsView() {
  const buildName = useBridgeStore((s) => s.buildName);
  const unsavedFlag = useBridgeStore((s) => s.unsaved);
  const outputRevision = useBridgeStore((s) => s.outputRevision);

  const snapshot = useBuildsStore((s) => s.snapshot);
  const loadError = useBuildsStore((s) => s.error);
  const sort = useBuildsStore((s) => s.sort);
  const busy = useBuildsStore((s) => s.busy);
  const refresh = useBuildsStore((s) => s.refresh);
  const setSort = useBuildsStore((s) => s.setSort);
  const runCommand = useBuildsStore((s) => s.run);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [saveName, setSaveName] = useState('');
  const [saveFolder, setSaveFolder] = useState('');
  const [folderName, setFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);

  // Re-read on every recalculation: saving moves a file's modified time
  // and opening moves which row is the open one.
  useEffect(() => {
    void refresh();
  }, [outputRevision, refresh]);

  const run = async (work: () => Promise<unknown>) => {
    setRefusal(await runCommand(work));
    setConfirming(null);
  };

  /** Folders carry the path they sit in, so the tree is rebuilt by subPath. */
  const groups = useMemo(() => {
    if (!snapshot) return [];
    const bySubPath = new Map<string, BuildEntry[]>();
    for (const entry of snapshot.entries) {
      const key = entry.kind === 'folder' ? `${entry.subPath}${entry.name}/` : entry.subPath;
      if (entry.kind === 'folder' && !bySubPath.has(key)) bySubPath.set(key, []);
      if (entry.kind === 'build') {
        const list = bySubPath.get(key) ?? [];
        list.push(entry);
        bySubPath.set(key, list);
      }
    }
    if (!bySubPath.has('')) bySubPath.set('', []);
    return [...bySubPath.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div className={styles.empty}>{loadError ?? 'Reading the builds folder…'}</div>
    );
  }

  const total = snapshot.entries.filter((e) => e.kind === 'build').length;

  return (
    <div className={styles.view}>
      <section className={styles.panel}>
        <h3 className={styles.title}>
          Save
          {unsavedFlag && <span className={styles.unsaved}>unsaved changes</span>}
        </h3>

        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={busy || !snapshot.openPath}
            title={
              snapshot.openPath
                ? `Overwrite ${snapshot.openPath}`
                : 'This build has never been saved; give it a name first'
            }
            onClick={() => void run(() => bridge.act('saveBuild'))}
          >
            Save {buildName ? <strong>{buildName}</strong> : ''}
          </Button>

          <input
            className={styles.field}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Save as…"
            aria-label="New build name"
          />
          <select
            className={styles.field}
            value={saveFolder}
            onChange={(e) => setSaveFolder(e.target.value)}
            aria-label="Folder"
          >
            <option value="">(no folder)</option>
            {groups
              .map(([subPath]) => subPath)
              .filter(Boolean)
              .map((subPath) => (
                <option key={subPath} value={subPath}>
                  {subPath}
                </option>
              ))}
          </select>
          <Button
            disabled={busy || !saveName.trim()}
            onClick={() =>
              void run(async () => {
                await bridge.act('saveBuildAs', { name: saveName.trim(), folder: saveFolder });
                setSaveName('');
              })
            }
          >
            Save a copy
          </Button>
        </div>

        {!snapshot.openPath && (
          <p className={styles.hint}>
            This build has never been saved. Give it a name on the right and it lands in{' '}
            <code className={styles.path}>{snapshot.buildPath}</code>.
          </p>
        )}
      </section>

      {refusal && (
        <div className={styles.refusal} role="status">
          {refusal}
          <button className={styles.dismiss} onClick={() => setRefusal(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <section className={styles.panel}>
        <h3 className={styles.title}>
          Builds <span className={styles.count}>{total}</span>
          <div className={styles.titleActions}>
            <Segmented
              aria-label="Sort"
              value={sort}
              onChange={(value) => void setSort(value)}
              options={SORTS.map((s) => ({ value: s.value, label: s.label, title: s.title }))}
            />
            <Button variant="ghost" onClick={() => setShowNewFolder((open) => !open)}>
              New folder
            </Button>
          </div>
        </h3>

        {showNewFolder && (
          <div className={styles.actions}>
            <input
              className={styles.field}
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Folder name"
              aria-label="New folder name"
            />
            <Button
              disabled={busy || !folderName.trim()}
              onClick={() =>
                void run(async () => {
                  await bridge.act('newBuildFolder', { name: folderName.trim() });
                  setFolderName('');
                  setShowNewFolder(false);
                })
              }
            >
              Create
            </Button>
          </div>
        )}

        {total === 0 && (
          <p className={styles.hint}>
            Nothing saved yet. The folder is{' '}
            <code className={styles.path}>{snapshot.buildPath}</code> — the one the desktop
            app uses, so anything saved there shows up here.
          </p>
        )}

        {groups.map(([subPath, entries]) => (
          <div key={subPath || '(root)'} className={styles.group}>
            {subPath && <div className={styles.folder}>{subPath.replace(/\/$/, '')}</div>}
            {entries.length === 0 && subPath && (
              <p className={styles.emptyFolder}>empty</p>
            )}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={styles.row}
                data-open={entry.open ? 'true' : undefined}
              >
                <button
                  className={styles.name}
                  disabled={busy || entry.open}
                  title={entry.open ? 'Already open' : `Open ${entry.path}`}
                  onClick={() => void run(() => bridge.openBuild(entry.path!))}
                >
                  {entry.name}
                </button>
                <span className={styles.meta}>
                  {[entry.ascendancy ?? entry.class, entry.level && `level ${entry.level}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className={styles.modified}>{when(entry.modified)}</span>
                {/* Deleting a file is not undoable, so it asks once rather
                    than behind a dialog the engine would have to draw. */}
                {confirming === entry.path ? (
                  <button
                    className={styles.confirm}
                    disabled={busy}
                    onClick={() => void run(() => bridge.act('deleteBuild', { path: entry.path }))}
                  >
                    Delete for good
                  </button>
                ) : (
                  <button
                    className={styles.delete}
                    disabled={busy || entry.open}
                    title={entry.open ? 'Open another build first' : 'Delete this file'}
                    onClick={() => setConfirming(entry.path ?? null)}
                    aria-label={`Delete ${entry.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
