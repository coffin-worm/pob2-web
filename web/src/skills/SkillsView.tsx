import { useEffect, useRef, useState } from 'react';
import { useBridgeStore } from '../pob/bridgeStore';
import { useSkillsStore } from '../pob/skillsStore';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { WhatIf } from '../ui/WhatIf';
import { bridge } from '../pob/bridge';
import type { ItemLine } from '../pob/types';
import styles from './SkillsView.module.css';

/**
 * The Skills tab.
 *
 * Socket groups and the gems in them. As with the items, the engine does
 * the describing: a group's label is `displayLabel`, built during the
 * calculation pass out of the skills it actually grants; the panel for a
 * group is `AddSocketGroupTooltip`; the panel for a gem is
 * `GemTooltip.AddGemTooltip`, which knows how a granted effect's levels and
 * stat sets resolve at this level and quality. None of that is reproduced
 * here.
 *
 * What this file adds is that the list and the editor are on screen at the
 * same time. PoB shows one socket group at a time in a column of controls;
 * clicking between groups here keeps the list in place.
 */

function Lines({ lines }: { lines: ItemLine[] }) {
  return (
    <>
      {lines.map((line, i) =>
        line.separator ? (
          <hr key={i} className={styles.rule} />
        ) : (
          <div
            key={i}
            className={styles.line}
            data-tone={line.tone}
            data-size={line.size && line.size >= 20 ? 'title' : undefined}
          >
            {line.text}
          </div>
        ),
      )}
    </>
  );
}

export function SkillsView() {
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const snapshot = useSkillsStore((s) => s.snapshot);
  const groupIndex = useSkillsStore((s) => s.groupIndex);
  const gemIndex = useSkillsStore((s) => s.gemIndex);
  const detail = useSkillsStore((s) => s.detail);
  const detailLoading = useSkillsStore((s) => s.detailLoading);
  const query = useSkillsStore((s) => s.query);
  const results = useSkillsStore((s) => s.results);
  const searchTotal = useSkillsStore((s) => s.searchTotal);
  const searching = useSkillsStore((s) => s.searching);
  const refresh = useSkillsStore((s) => s.refresh);
  const openGroup = useSkillsStore((s) => s.openGroup);
  const openGem = useSkillsStore((s) => s.openGem);
  const search = useSkillsStore((s) => s.search);
  const act = useSkillsStore((s) => s.act);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    void refresh();
  }, [outputRevision, refresh]);

  const run = async (action: string, value?: unknown) => {
    setRefusal(await act(action, value));
  };

  const onSearch = (value: string) => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void search(value), 180);
    useSkillsStore.setState({ query: value });
  };

  if (!snapshot) {
    return <div className={styles.empty}>Waiting for the engine…</div>;
  }

  const group = snapshot.groups.find((g) => g.index === groupIndex) ?? null;
  const gems = snapshot.gems ?? [];

  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        {snapshot.sets.length > 1 && (
          <Select
            value={snapshot.setId}
            options={snapshot.sets}
            onChange={(id) => void run('setSkillSet', id)}
            label="Skill set"
            aria-label="Skill set"
          />
        )}
        <div className={styles.barSpacer} />
        <Button onClick={() => void run('addSocketGroup')}>New group</Button>
      </div>

      {refusal && (
        <div className={styles.refusal} role="status">
          {refusal}
          <button className={styles.dismiss} onClick={() => setRefusal(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className={styles.columns}>
        <div className={styles.left}>
          <h3 className={styles.heading}>
            Socket groups <span className={styles.count}>{snapshot.groups.length}</span>
          </h3>

          {snapshot.groups.length === 0 && (
            <p className={styles.hint}>
              No socket groups yet. Make one, then add a skill gem to it.
            </p>
          )}

          {snapshot.groups.map((entry) => (
            <div
              key={entry.index}
              className={styles.group}
              data-selected={entry.index === groupIndex ? 'true' : undefined}
              data-disabled={!entry.enabled ? 'true' : undefined}
            >
              <button
                className={styles.groupName}
                onClick={() => void openGroup(entry.index === groupIndex ? null : entry.index)}
              >
                <span className={styles.groupLabel}>{entry.label}</span>
                <span className={styles.badges}>
                  {entry.main && <span className={styles.main}>main</span>}
                  {entry.fullDPS && <span className={styles.fullDps}>full DPS</span>}
                  {!entry.enabled && <span className={styles.off}>off</span>}
                  {entry.source && <span className={styles.granted}>{entry.source}</span>}
                </span>
              </button>

              {entry.index === groupIndex && (
                <div className={styles.groupBody}>
                  <div className={styles.groupControls}>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) =>
                          void run('setSocketGroupEnabled', {
                            group: entry.index,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      Enabled
                    </label>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={Boolean(entry.fullDPS)}
                        onChange={(e) =>
                          void run('setSocketGroupFullDPS', {
                            group: entry.index,
                            fullDPS: e.target.checked,
                          })
                        }
                      />
                      Full DPS
                    </label>
                    <Button
                      variant="ghost"
                      disabled={Boolean(entry.main)}
                      onClick={() => void run('setSocketGroup', entry.index)}
                      title="Use this group for the stats in the sidebar"
                    >
                      Set as main
                    </Button>
                    {/* What turning this group off would cost, asked of
                        the engine the same way the config options are. */}
                    <WhatIf
                      label={`the ${entry.label} group`}
                      ask={() => bridge.socketGroupWhatIf(entry.index)}
                    />
                    <Button
                      variant="ghost"
                      disabled={Boolean(entry.source)}
                      onClick={() => void run('deleteSocketGroup', entry.index)}
                      title={
                        entry.source
                          ? `Granted by ${entry.source}; PoB rebuilds it on every pass`
                          : 'Delete this group'
                      }
                    >
                      Delete
                    </Button>
                  </div>

                  {!entry.source && (
                    <input
                      className={styles.rename}
                      value={renaming ?? entry.name}
                      placeholder="Name this group (optional)"
                      aria-label="Socket group name"
                      onChange={(e) => setRenaming(e.target.value)}
                      // Committed on blur rather than per keystroke: each
                      // one is a recalculation of the whole build.
                      onBlur={() => {
                        if (renaming !== null && renaming !== entry.name) {
                          void run('setSocketGroupLabel', {
                            group: entry.index,
                            label: renaming,
                          });
                        }
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') {
                          setRenaming(null);
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  )}

                  {gems.length === 0 && (
                    <p className={styles.hint}>No gems in this group yet.</p>
                  )}

                  {gems.length > 0 && (
                    <div className={styles.gemHead} aria-hidden="true">
                      <span />
                      <span />
                      <span>level</span>
                      <span>qual</span>
                      <span />
                    </div>
                  )}

                  {gems.map((gem) => (
                    <div
                      key={gem.index}
                      className={styles.gem}
                      data-selected={gem.index === gemIndex ? 'true' : undefined}
                      data-off={!gem.enabled ? 'true' : undefined}
                    >
                      <input
                        type="checkbox"
                        className={styles.gemEnabled}
                        checked={gem.enabled}
                        onChange={(e) =>
                          void run('setGem', {
                            group: entry.index,
                            gem: gem.index,
                            enabled: e.target.checked,
                          })
                        }
                        aria-label={`${gem.name} enabled`}
                      />
                      <button
                        className={styles.gemName}
                        data-tone={gem.tone}
                        onClick={() => void openGem(gem.index === gemIndex ? null : gem.index)}
                        title={gem.tags}
                      >
                        {gem.name}
                        {gem.support && <span className={styles.support}>support</span>}
                      </button>
                      <NumberField
                        value={gem.level}
                        min={1}
                        max={(gem.maxLevel ?? 20) + 20}
                        width={62}
                        onChange={(level) =>
                          void run('setGem', { group: entry.index, gem: gem.index, level })
                        }
                        aria-label={`${gem.name} level`}
                      />
                      <NumberField
                        value={gem.quality}
                        min={0}
                        max={23}
                        width={62}
                        onChange={(quality) =>
                          void run('setGem', { group: entry.index, gem: gem.index, quality })
                        }
                        aria-label={`${gem.name} quality`}
                      />
                      <button
                        className={styles.remove}
                        onClick={() =>
                          void run('deleteGem', { group: entry.index, gem: gem.index })
                        }
                        aria-label={`Remove ${gem.name}`}
                      >
                        ×
                      </button>
                      {gem.error && <p className={styles.gemError}>{gem.error}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className={styles.right}>
          <form className={styles.search} onSubmit={(e) => e.preventDefault()}>
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search every gem"
              aria-label="Search the gem database"
              disabled={group === null}
            />
            {query.trim().length >= 2 && (
              <span className={styles.searchCount}>
                {searching ? '…' : `${searchTotal} found`}
              </span>
            )}
          </form>

          {group === null && (
            <p className={styles.hint}>Open a socket group to add gems to it.</p>
          )}

          {group !== null && results.length > 0 && (
            <div className={styles.results}>
              {results.map((result) => (
                <button
                  key={result.id}
                  className={styles.result}
                  onClick={() => void run('addGem', { group: group.index, gem: result.id })}
                  title={result.tags}
                >
                  <span className={styles.resultName}>{result.name}</span>
                  {result.support && <span className={styles.support}>support</span>}
                  {result.maxLevel && <span className={styles.resultMax}>max {result.maxLevel}</span>}
                </button>
              ))}
            </div>
          )}

          <div className={styles.detail}>
            {groupIndex !== null && detailLoading && !detail && (
              <p className={styles.hint}>Reading the engine…</p>
            )}
            {detail && !detail.ready && (
              <p className={styles.hint}>{detail.error ?? 'Nothing to show for that.'}</p>
            )}
            {detail?.ready && (
              <>
                <p className={styles.against}>
                  {gemIndex === null
                    ? `what ${group?.label ?? 'this group'} does`
                    : `${detail.name ?? 'this gem'}, at its current level and quality`}
                </p>
                <div className={styles.block}>
                  <Lines lines={detail.lines} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
