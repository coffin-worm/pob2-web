import { useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { useBridgeStore } from './bridgeStore';
import styles from './EngineDialog.module.css';

/**
 * The dialog PoB is waiting on, drawn as a dialog.
 *
 * PoB answers some commands with a modal rather than by doing the thing:
 * changing class with an allocated tree, Back with unsaved work, a build
 * that failed to load. Until this existed the UI could say the engine was
 * stuck and nothing more, which left a basic operation, changing class,
 * with no way through.
 *
 * Everything here is the engine's: the title, the message, the buttons and
 * their order, which one Enter presses and which one Escape does. Pressing
 * one calls that control's own `Click`, so a button the dialog has greyed
 * out stays greyed out and the handler behind it is PoB's.
 */
export function EngineDialog() {
  const popup = useBridgeStore((s) => s.popup);
  const answer = useBridgeStore((s) => s.answerPopup);
  const dismiss = useBridgeStore((s) => s.dismissPopup);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog when one opens, so the keyboard follows the
  // thing that is blocking everything else.
  useEffect(() => {
    if (popup) panelRef.current?.focus();
  }, [popup]);

  if (!popup) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && popup.cancelKey) {
      e.preventDefault();
      answer(popup.cancelKey);
    } else if (e.key === 'Enter' && popup.defaultKey) {
      e.preventDefault();
      answer(popup.defaultKey);
    }
  };

  return (
    <div className={styles.scrim} role="presentation">
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={popup.title}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <h2 className={styles.title}>{popup.title}</h2>

        {popup.lines.map((line, i) => (
          <p key={i} className={styles.line}>
            {line}
          </p>
        ))}

        {/* A dialog with a text field or a list is asking for something a
            button press cannot answer. Said, rather than offering a button
            that would commit a default nobody chose. */}
        {popup.needsInput && (
          <p className={styles.note}>
            This dialog also asks for something to be typed or chosen, which this UI
            cannot fill in yet. Answering it here uses whatever the engine already had.
          </p>
        )}

        <div className={styles.actions}>
          {popup.buttons.map((button) => (
            <Button
              key={button.key}
              variant={button.key === popup.defaultKey ? 'primary' : 'default'}
              disabled={!button.enabled}
              onClick={() => answer(button.key)}
            >
              {button.label}
            </Button>
          ))}
          {/* The way out when none of the above is right. It closes the
              dialog without running any of its handlers, which is what the
              engine's own ClosePopup does. */}
          <Button variant="ghost" onClick={dismiss}>
            Dismiss without answering
          </Button>
        </div>

        {popup.depth > 1 && (
          <p className={styles.note}>
            {popup.depth - 1} more {popup.depth === 2 ? 'dialog is' : 'dialogs are'} waiting
            behind this one.
          </p>
        )}
      </div>
    </div>
  );
}
