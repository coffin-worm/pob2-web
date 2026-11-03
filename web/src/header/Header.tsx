import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { ArrowLeft } from '../ui/icons';
import { LEVEL_MAX, LEVEL_MIN, type HeaderActions, type HeaderState } from '../pob/types';
import { BuildTitle } from './BuildTitle';
import { PointBudgets } from './PointBudgets';
import styles from './Header.module.css';

type Props = HeaderState & HeaderActions;

/**
 * The top bar.
 *
 * Three groups, left to right: where you are (back, the build's name), who
 * the character is (level, class, ascendancy, loadout), and what the build
 * has spent (the point budgets) with the one primary action beside it.
 *
 * The Lua header put Save and Save As at the far left, the build name in
 * the middle of them and the point display, and the character controls
 * split across a centre divider -- an order that came from what was added
 * when rather than from what belongs together.
 */
export function Header(props: Props) {
  const {
    buildName,
    unsaved,
    dbFileName,
    characterLevel,
    levelAutoMode,
    classId,
    classes,
    ascendClassId,
    ascendancies,
    loadoutId,
    loadouts,
    points,
  } = props;

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Button variant="icon" onClick={props.back} title="Back to build list">
          <ArrowLeft />
        </Button>
        <BuildTitle name={buildName} unsaved={unsaved} onRename={props.setBuildName} />
      </div>

      <div className={styles.right}>
        <Segmented
          aria-label="Level mode"
          value={levelAutoMode ? 'auto' : 'manual'}
          onChange={(v) => props.setLevelAutoMode(v === 'auto')}
          options={[
            { value: 'auto', label: 'Auto', title: 'Level follows the passive tree' },
            { value: 'manual', label: 'Manual', title: 'Set the level by hand' },
          ]}
        />
        <NumberField
          label="Level"
          value={characterLevel}
          min={LEVEL_MIN}
          max={LEVEL_MAX}
          width={104}
          disabled={levelAutoMode}
          onChange={props.setCharacterLevel}
        />
        <Select
          aria-label="Class"
          value={classId}
          options={classes}
          onChange={props.setClass}
          width={132}
        />
        <Select
          aria-label="Ascendancy"
          value={ascendClassId}
          options={ascendancies}
          onChange={props.setAscendancy}
          width={176}
        />
        <Select
          label="Loadout"
          value={loadoutId}
          options={loadouts}
          onChange={props.setLoadout}
          width={180}
        />

        {/* Character identity on the left of this rule, what the build has
            spent and what to do about it on the right. */}
        <span className={styles.divider} />

        <PointBudgets points={points} />
        <Button variant="ghost" onClick={props.saveAs} disabled={!dbFileName}>
          Save as
        </Button>
        <Button variant="primary" onClick={props.save} disabled={!unsaved && !!dbFileName}>
          Save
        </Button>
      </div>
    </header>
  );
}
