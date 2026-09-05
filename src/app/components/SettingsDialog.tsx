import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import type { SettingsStore } from '../../settings/SettingsStore';
import { AudioNotice, type ShellAudio } from './AudioNotice';

interface SettingsDialogProps {
  store: SettingsStore;
  onClose: () => void;
  onModalChange?: (open: boolean) => void;
  audio?: ShellAudio;
}

export function SettingsDialog({
  store,
  onClose,
  onModalChange,
  audio,
}: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const settings = snapshot.settings;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) throw new Error('Settings dialog is not mounted.');
    const opener = document.activeElement;
    onModalChange?.(true);
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      dialog.close();
      onModalChange?.(false);
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [onModalChange]);

  function ownKeyboard(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const controls = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = controls[0];
      const last = controls.at(-1);
      const focus = document.activeElement;
      if (
        event.shiftKey
          ? focus === first || focus === event.currentTarget
          : focus === last || focus === event.currentTarget
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  }

  function changeAudio(patch: unknown) {
    store.update(patch);
    void audio?.unlockAudio();
  }

  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-labelledby="settings-heading"
      aria-describedby="settings-description"
      tabIndex={-1}
      onKeyDown={ownKeyboard}
      onKeyUp={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="settings-header">
        <div>
          <p className="eyebrow">Your expedition</p>
          <h2 id="settings-heading">Settings</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onClose}>
          Close settings
        </button>
      </header>
      <p id="settings-description" className="settings-description">
        Make the water your own. Changes apply immediately.
      </p>
      <fieldset className="settings-group">
        <legend>Sound</legend>
        <label className="range-setting">
          <span>
            Master volume{' '}
            <span aria-hidden="true">
              {Math.round(settings.masterVolume * 100)}%
            </span>
          </span>
          <input
            aria-label="Master volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.masterVolume}
            onChange={(event) =>
              changeAudio({ masterVolume: event.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label className="toggle-setting">
          <span>Sound effects</span>
          <input
            type="checkbox"
            checked={settings.sfxEnabled}
            onChange={(event) =>
              changeAudio({ sfxEnabled: event.currentTarget.checked })
            }
          />
        </label>
        <label className="toggle-setting">
          <span>Ambience</span>
          <input
            type="checkbox"
            checked={settings.musicEnabled}
            onChange={(event) =>
              changeAudio({ musicEnabled: event.currentTarget.checked })
            }
          />
        </label>
      </fieldset>
      <fieldset className="settings-group">
        <legend>In the water</legend>
        <label className="toggle-setting">
          <span>Mouse steering</span>
          <input
            type="checkbox"
            checked={settings.mouseSteering}
            onChange={(event) =>
              store.update({ mouseSteering: event.currentTarget.checked })
            }
          />
        </label>
        <label className="range-setting">
          <span>
            Mouse sensitivity{' '}
            <span aria-hidden="true">
              {settings.mouseSensitivity.toFixed(2)}x
            </span>
          </span>
          <input
            aria-label="Mouse sensitivity"
            type="range"
            min="0.25"
            max="2"
            step="0.05"
            value={settings.mouseSensitivity}
            onChange={(event) =>
              store.update({
                mouseSensitivity: event.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
        <label className="toggle-setting">
          <span>Invert mouse pitch</span>
          <input
            type="checkbox"
            checked={settings.invertMouseY}
            onChange={(event) =>
              store.update({ invertMouseY: event.currentTarget.checked })
            }
          />
        </label>
        <label className="toggle-setting">
          <span>
            Reduced effects{' '}
            <small id="reduced-effects-description">
              Still water, less decorative motion. System preference also
              applies.
            </small>
          </span>
          <input
            aria-label="Reduced effects"
            aria-describedby="reduced-effects-description"
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={(event) =>
              store.update({ reducedMotion: event.currentTarget.checked })
            }
          />
        </label>
      </fieldset>
      {snapshot.notice && (
        <p className="service-notice" role="alert">
          {snapshot.notice}
        </p>
      )}
      {audio && <AudioNotice host={audio} />}
    </dialog>
  );
}
