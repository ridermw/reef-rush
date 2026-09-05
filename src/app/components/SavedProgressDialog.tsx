import { useEffect, useRef, useState } from 'react';
import type {
  GameHost,
  ProgressRecoveryResult,
} from '../../game/core/GameHost';
import { serializeProgressBackup } from '../../game/save/progressStorage';
import { NativeDialog } from './NativeDialog';

type RecoveryController = Pick<
  GameHost,
  | 'inspectSavedProgress'
  | 'replaceSavedProgress'
  | 'retrySaving'
  | 'setSettingsOpen'
>;

function replacementFeedback(result: ProgressRecoveryResult): string {
  switch (result.status) {
    case 'replaced':
      return 'Saved current session progress. The inspected invalid save was replaced.';
    case 'changed':
      return 'Saved data changed and was not replaced. Review this fresh inspection and acknowledge again.';
    case 'loaded':
      return 'A valid save is now present and was not replaced. Retry saving to merge current session records.';
    case 'empty':
      return 'The save is now empty and was not replaced. Retry saving to keep current session records.';
    case 'unsupported-version':
      return 'The save belongs to another version and was not replaced. Keep a backup and use a compatible game version.';
    case 'cancelled':
      return 'Replacement cancelled. No save was replaced by this request.';
    case 'unavailable':
    case 'write-failed':
    case 'invalid-request':
    case 'failed':
      return `Save not replaced: ${result.cause instanceof Error ? result.cause.message : String(result.cause)}`;
  }
}

export function SavedProgressDialog({
  host,
  onClose,
}: {
  host: RecoveryController;
  onClose: () => void;
}) {
  const [inspection, setInspection] = useState(() =>
    host.inspectSavedProgress(),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    success: boolean;
    text: string;
  } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const backupURL = useRef<string | null>(null);

  function releaseBackup() {
    if (backupURL.current !== null) {
      URL.revokeObjectURL(backupURL.current);
      backupURL.current = null;
    }
  }

  useEffect(
    () => () => {
      request.current?.abort();
      releaseBackup();
    },
    [],
  );

  function close() {
    request.current?.abort();
    onClose();
  }

  function inspect() {
    releaseBackup();
    setInspection(host.inspectSavedProgress());
    setAcknowledged(false);
    setBackupError(null);
  }

  function downloadBackup() {
    if (inspection.status !== 'invalid') return;
    const link = document.createElement('a');
    try {
      const url = URL.createObjectURL(
        new Blob([serializeProgressBackup(inspection.raw)], {
          type: 'application/json',
        }),
      );
      releaseBackup();
      backupURL.current = url;
      link.href = url;
      link.download = 'reef-rush-progress-backup-v1.json';
      document.body.append(link);
      link.click();
      setBackupError(null);
    } catch (cause) {
      setBackupError(
        `Could not create the local backup (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    } finally {
      link.remove();
    }
  }

  async function replace() {
    if (inspection.status !== 'invalid' || !acknowledged || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFeedback(null);
    const result = await host.replaceSavedProgress(
      inspection.raw,
      controller.signal,
    );
    // The host reports committed writes even if closing subsequently aborted this UI request.
    if (controller.signal.aborted) return;
    request.current = null;
    inspect();
    setBusy(false);
    setFeedback({
      success: result.status === 'replaced',
      text: replacementFeedback(result),
    });
  }

  async function retry() {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFeedback(null);
    const result = await host.retrySaving();
    // Ordinary persistence remains durable after closing; only this UI update is discarded.
    if (controller.signal.aborted) return;
    request.current = null;
    inspect();
    setBusy(false);
    setFeedback({
      success: result.status === 'saved',
      text:
        result.status === 'saved'
          ? 'Saved current session progress, merged with valid saved records.'
          : `Could not save progress (${result.cause instanceof Error ? result.cause.message : String(result.cause)}).`,
    });
  }

  const invalid = inspection.status === 'invalid' ? inspection : null;
  const replaceable =
    invalid !== null && invalid.reason !== 'unsupported-version';
  return (
    <NativeDialog
      labelledBy="saved-progress-heading"
      describedBy="saved-progress-description"
      onClose={close}
      onModalChange={host.setSettingsOpen}
    >
      <header className="settings-header">
        <div>
          <p className="eyebrow">Your expedition</p>
          <h2 id="saved-progress-heading">Saved progress</h2>
        </div>
        <button className="secondary-button" type="button" onClick={close}>
          Close saved progress
        </button>
      </header>
      <p id="saved-progress-description" className="settings-description">
        Your records stay protected. Inspect this browser&apos;s save before
        choosing what happens next.
      </p>
      <section className="settings-group" aria-label="Save inspection">
        <h3>Current saved data</h3>
        {inspection.status === 'loaded' && (
          <p>
            Valid saved progress. Saving merges your current session records
            without resetting existing records.
          </p>
        )}
        {inspection.status === 'empty' && (
          <p>
            No saved progress in this browser. You can save records from this
            session.
          </p>
        )}
        {inspection.status === 'unavailable' && (
          <p className="recovery-warning">
            Progress storage is unavailable. Allow local storage for this site,
            then retry saving or inspect again. Your session records are
            retained.
          </p>
        )}
        {invalid && (
          <>
            <p className="recovery-warning">
              {invalid.reason === 'unsupported-version'
                ? 'This save uses a newer or different version. This game cannot replace it. Download a backup and open it with a compatible game version; do not clear site data.'
                : invalid.reason === 'malformed-json'
                  ? 'Malformed JSON: the saved data cannot be read. The original is protected and ordinary saving is blocked.'
                  : 'Invalid save schema: the saved data does not match this version. The original is protected and ordinary saving is blocked.'}
            </p>
            <h3>Keep a backup first</h3>
            <p>
              The local JSON backup contains the exact original saved text.
              Nothing is uploaded. Keep the file somewhere safe before replacing
              the original.
            </p>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={downloadBackup}
            >
              Download backup
            </button>
            <pre className="recovery-preview" aria-label="Saved data preview">
              {invalid.raw.slice(0, 4096)}
            </pre>
            <p className="recovery-count">
              Showing {Math.min(invalid.raw.length, 4096)} of{' '}
              {invalid.raw.length} UTF-16 code units
              {invalid.raw.length > 4096
                ? ' (preview truncated).'
                : ' (complete preview).'}
            </p>
          </>
        )}
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => {
            inspect();
            setFeedback(null);
          }}
        >
          Inspect again
        </button>
      </section>
      {replaceable && (
        <fieldset className="settings-group">
          <legend>Replace only this invalid save</legend>
          <p>
            This replaces the original with progress actually earned in the
            current session. Records that cannot be read from the original will
            not be recovered. If you have not finished a run, the replacement
            may contain no records.
          </p>
          <label className="toggle-setting">
            <span>
              I understand: replace the original invalid save with current
              session progress.
            </span>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
          </label>
          <button
            className="primary-button recovery-confirm"
            type="button"
            disabled={!acknowledged || busy || backupError !== null}
            onClick={() => void replace()}
          >
            Replace invalid save
          </button>
        </fieldset>
      )}
      {!invalid && (
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void retry()}
        >
          Retry saving
        </button>
      )}
      {busy && (
        <p className="service-notice" role="status">
          Waiting for safe save access. Closing cancels an uncommitted
          replacement, not ordinary saving.
        </p>
      )}
      {feedback && (
        <p
          className="service-notice"
          role={feedback.success ? 'status' : 'alert'}
        >
          {feedback.text}
        </p>
      )}
      {backupError && (
        <p className="service-notice" role="alert">
          {backupError}
        </p>
      )}
    </NativeDialog>
  );
}
