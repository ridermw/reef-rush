import { useSyncExternalStore } from 'react';
import type { SettingsStore } from '../../settings/SettingsStore';
import { AudioNotice, type ShellAudio } from './AudioNotice';
import { NativeDialog } from './NativeDialog';

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
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const settings = snapshot.settings;
  function changeAudio(patch: unknown) {
    store.update(patch);
    void audio?.unlockAudio();
  }

  return (
    <NativeDialog
      labelledBy="settings-heading"
      describedBy="settings-description"
      onClose={onClose}
      onModalChange={onModalChange}
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
    </NativeDialog>
  );
}
