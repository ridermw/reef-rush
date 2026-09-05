import { useSyncExternalStore } from 'react';
import type { GameHost } from '../../game/core/GameHost';

export type ShellAudio = Pick<
  GameHost,
  'getAudioNotice' | 'subscribeAudio' | 'unlockAudio' | 'retryAudioCleanup'
>;

export function AudioNotice({ host }: { host: ShellAudio }) {
  // A primitive snapshot keeps voice/step notifications out of React renders.
  const notice = useSyncExternalStore(
    host.subscribeAudio,
    host.getAudioNotice,
    host.getAudioNotice,
  );
  if (!notice) return null;
  return (
    <aside className="service-notice" aria-label="Audio">
      <p role="alert">{notice}</p>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void host.unlockAudio()}
        >
          Enable sound
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void host.retryAudioCleanup().catch((error: unknown) => {
              console.error('Reef Rush audio cleanup remains pending.', error);
            });
          }}
        >
          Retry audio cleanup
        </button>
      </div>
    </aside>
  );
}
