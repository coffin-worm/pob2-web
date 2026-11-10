import { useEffect, useMemo, useState } from 'react';
import { useBridgeStore } from '../pob/bridgeStore';
import { useConfigStore } from '../pob/configStore';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { WhatIf } from '../ui/WhatIf';
import { bridge } from '../pob/bridge';
import type { ConfigOption } from '../pob/types';
import styles from './ConfigView.module.css';

/**
 * The Configuration tab.
 *
 * The interesting thing about this screen is how much of it is usually not
 * on it. PoB declares 663 options and asks a given build about seventy,
 * because an option only appears when the build could answer it: the
 * conditions the calculation actually used, the flags on the mod list, the
 * active skill's data, the allocated tree. That gating is a function of the
 * whole calculation, so every option's visibility is the engine's answer,
 * not a rule repeated here.
 *
 * Two parts of it are worth knowing. An option that no longer applies is
 * still shown when its value differs from the default, so a setting cannot
 * go on affecting the build from somewhere you cannot see it. And "show
 * all" reveals the build-gated options but deliberately not the ones gated
 * on another option being set, because those would have nothing to attach
 * to.
 */

/** A number field's ceiling, by option type. PoB does not declare one. */
const MAX = 1_000_000;

function Option({
  option,
  onSet,
}: {
  option: ConfigOption;
  onSet: (value: boolean | number | string | null) => void;
}) {
  const title = option.tooltip?.join('\n');

  if (option.type === 'check') {
    return (
      <div className={styles.check} title={title} data-changed={option.changed || undefined}>
        <input
          id={`cfg-${option.var}`}
          type="checkbox"
          checked={option.value === true}
          onChange={(e) => onSet(e.target.checked)}
        />
        <label className={styles.label} htmlFor={`cfg-${option.var}`}>
          {option.label}
        </label>
        {/* Only the checkboxes: for a list or a count there is no "the
            other way round" to compare against. */}
        <WhatIf label={option.label} ask={() => bridge.configWhatIf(option.var)} />
      </div>
    );
  }

  if (option.type === 'list') {
    return (
      <div className={styles.row} title={title} data-changed={option.changed || undefined}>
        <span className={styles.label}>{option.label}</span>
        <Select
          value={
            // The engine's list values are numbers or strings; Select is
            // keyed by index into the options it is given.
            Math.max(
              0,
              (option.list ?? []).findIndex((entry) => entry.value === option.value),
            )
          }
          options={(option.list ?? []).map((entry, index) => ({
            id: index,
            name: entry.label,
          }))}
          onChange={(index) => onSet((option.list ?? [])[index]?.value ?? null)}
          aria-label={option.label}
        />
      </div>
    );
  }

  if (option.type === 'text') {
    return (
      <div className={styles.rowStacked} title={title} data-changed={option.changed || undefined}>
        <span className={styles.label}>{option.label}</span>
        <textarea
          className={styles.text}
          defaultValue={String(option.value ?? '')}
          placeholder={option.placeholder === undefined ? '' : String(option.placeholder)}
          rows={3}
          aria-label={option.label}
          // Committed on blur: every keystroke is a whole recalculation.
          onBlur={(e) => {
            if (e.target.value !== String(option.value ?? '')) onSet(e.target.value);
          }}
        />
      </div>
    );
  }

  // count, countAllowZero, integer, float
  const min = option.type === 'count' ? 0 : -MAX;
  return (
    <div className={styles.row} title={title} data-changed={option.changed || undefined}>
      <span className={styles.label}>{option.label}</span>
      <NumberField
        value={Number(option.value ?? option.placeholder ?? option.default ?? 0)}
        min={min}
        max={MAX}
        width={96}
        onChange={(n) => onSet(n)}
        aria-label={option.label}
      />
      {option.changed && (
        <button
          className={styles.reset}
          onClick={() => onSet(null)}
          title="Back to the default"
          aria-label={`Reset ${option.label}`}
        >
          ↺
        </button>
      )}
    </div>
  );
}

export function ConfigView() {
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const actEstimate = useBridgeStore((s) => s.act) ?? null;
  const characterLevel = useBridgeStore((s) => s.characterLevel);
  const estimatePenalty = useBridgeStore((s) => s.estimateResistancePenalty);
  // Somebody planning an endgame build at level 40 means the Endgame
  // penalty, and should be able to say so once.
  const [penaltyDismissed, setPenaltyDismissed] = useState(false);
  const snapshot = useConfigStore((s) => s.snapshot);
  const refresh = useConfigStore((s) => s.refresh);
  const setVar = useConfigStore((s) => s.set);
  const act = useConfigStore((s) => s.act);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void refresh();
  }, [outputRevision, refresh]);

  const run = async (promise: Promise<string | null>) => setRefusal(await promise);

  /**
   * Filtering by label, locally.
   *
   * PoB's own search box feeds the same `shown` closure the build gating
   * does, so searching there would mean a round trip and a recalculation
   * for every keystroke. The options are already here.
   */
  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = snapshot?.sections ?? [];
    if (!needle) return all;
    return all
      .map((section) => ({
        ...section,
        options: section.options.filter((option) =>
          option.label.toLowerCase().includes(needle),
        ),
      }))
      .filter((section) => section.options.length > 0);
  }, [snapshot, filter]);

  if (!snapshot) {
    return <div className={styles.empty}>Waiting for the engine…</div>;
  }

  const matching = sections.reduce((n, section) => n + section.options.length, 0);

  /**
   * Whether the resistance penalty disagrees with PoB's own act estimate.
   *
   * Both halves come from the engine: `act` is what EstimatePlayerProgress
   * worked out, and the option is whatever is set. PoB's list runs Act 1
   * at 0% down to Act 6 at -50%, with Endgame at -60%, so the act number
   * is the penalty's index and the arithmetic below is just that mapping
   * read the other way round.
   */
  const penaltyOption = snapshot.sections
    .flatMap((section) => section.options)
    .find((option) => option.var === 'resistancePenalty');
  const wanted =
    actEstimate === 'Endgame'
      ? -60
      : actEstimate
        ? -10 * (Number(actEstimate.replace('Act ', '')) - 1)
        : null;
  const penaltyMismatch =
    // Not on a build nobody has built yet. A new build is level 1 with no
    // points, which estimates to Act 1, and PoB's default of Endgame is a
    // deliberate choice for planning rather than a mistake: saying so on
    // every empty build would be a banner that is always there, which is
    // a banner nobody reads.
    characterLevel > 1 &&
    !penaltyDismissed &&
    actEstimate &&
    penaltyOption &&
    wanted !== null &&
    Number(penaltyOption.value) !== wanted
      ? {
          act: actEstimate,
          current: `${String(penaltyOption.value)}%`,
          suggested: `${wanted}%`,
        }
      : null;

  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        {snapshot.sets.length > 1 && (
          <Select
            value={snapshot.setId}
            options={snapshot.sets}
            onChange={(id) => void run(act('setConfigSet', id))}
            label="Config set"
            aria-label="Config set"
          />
        )}
        <input
          className={styles.filter}
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter options"
          aria-label="Filter configuration options"
        />
        <label className={styles.toggle} title="Reveal the options this build does not use">
          <input
            type="checkbox"
            checked={snapshot.showAll}
            onChange={(e) =>
              void run(act('setConfigShowAll', { showAll: e.target.checked }))
            }
          />
          Show all
        </label>
        <span
          className={styles.counts}
          title={`${snapshot.shown} of PoB's ${snapshot.total} options apply to this build`}
        >
          {filter.trim() ? `${matching} matching · ` : ''}
          {snapshot.shown} of {snapshot.total}
        </span>
      </div>

      {/* An upstream collision rather than a local one, and worth saying:
          two options declared with the same var write to one value, so one
          of the two questions can never be answered on its own. */}
      {snapshot.duplicates.length > 0 && (
        <p className={styles.note}>
          PoB declares {snapshot.duplicates.length === 1 ? 'an option' : 'options'} twice
          under the same name ({snapshot.duplicates.join(', ')}); the second copy is hidden
          here because both would write to one value.
        </p>
      )}

      {/* The resistance penalty is the one option that is usually wrong
          without anybody touching it. PoB works the act out from the
          allocated points, then fails to read its own answer back
          (bridge/api.lua says exactly how), so an import lands on Endgame
          and takes sixty points off every elemental resistance. That
          shows up as the whole build looking wrong rather than as one
          dropdown, so it says so here, where the dropdown is. */}
      {penaltyMismatch && (
        <div className={styles.mismatch} role="status">
          <span>
            PoB puts this character in <strong>{penaltyMismatch.act}</strong>, but the
            elemental resistance penalty is set to{' '}
            <strong>{penaltyMismatch.current}</strong>. Every elemental resistance on the
            left is reduced by that.
          </span>
          <span className={styles.mismatchActions}>
            <Button variant="primary" onClick={() => estimatePenalty()}>
              Use {penaltyMismatch.suggested}
            </Button>
            <button
              className={styles.dismiss}
              onClick={() => setPenaltyDismissed(true)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </span>
        </div>
      )}

      {refusal && (
        <div className={styles.refusal} role="status">
          {refusal}
          <button className={styles.dismiss} onClick={() => setRefusal(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {sections.length === 0 && (
        <p className={styles.hint}>
          Nothing matches. {!snapshot.showAll && 'Try “Show all”, which reveals the options this build does not currently use.'}
        </p>
      )}

      <div className={styles.columns}>
        {sections.map((section) => (
          <section key={section.name} className={styles.section}>
            <h3 className={styles.sectionTitle}>
              {section.name} <span className={styles.count}>{section.options.length}</span>
            </h3>
            {section.options.map((option) => (
              <Option
                key={option.var}
                option={option}
                onSet={(value) => void run(setVar(option.var, value))}
              />
            ))}
          </section>
        ))}
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          Custom modifiers
          <span className={styles.count}>{snapshot.customMods.length}</span>
        </h3>
        <p className={styles.hint}>
          Anything the options above have no question for. One modifier a line, in the
          game's own wording: PoB parses them exactly as it parses an item.
        </p>
        {snapshot.customMods.map((block) => (
          <div key={block.index} className={styles.modBlock}>
            <div className={styles.modHead}>
              <input
                type="checkbox"
                checked={block.enabled}
                onChange={(e) =>
                  void run(
                    act('setCustomMods', { index: block.index, enabled: e.target.checked }),
                  )
                }
                aria-label={`${block.title} enabled`}
              />
              <input
                className={styles.modTitle}
                defaultValue={block.title}
                placeholder="Group name"
                aria-label="Modifier group name"
                onBlur={(e) => {
                  if (e.target.value !== block.title) {
                    void run(act('setCustomMods', { index: block.index, title: e.target.value }));
                  }
                }}
              />
              <button
                className={styles.reset}
                onClick={() => void run(act('deleteCustomModBlock', block.index))}
                aria-label={`Delete ${block.title}`}
                title="Delete this group"
              >
                ×
              </button>
            </div>
            <textarea
              className={styles.modText}
              defaultValue={block.text}
              rows={3}
              placeholder={'+100 to maximum Life\n20% increased Attack Speed'}
              aria-label={`${block.title} modifiers`}
              onBlur={(e) => {
                if (e.target.value !== block.text) {
                  void run(act('setCustomMods', { index: block.index, text: e.target.value }));
                }
              }}
            />
          </div>
        ))}
        <div>
          <Button onClick={() => void run(act('addCustomModBlock'))}>Add a group</Button>
        </div>
      </section>
    </div>
  );
}
