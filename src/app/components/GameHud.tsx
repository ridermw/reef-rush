import type { AppPresentation } from '../appStore';
import { formatElapsedMs } from '../formatElapsedMs';

export interface GameHudProps {
  courseName: string;
  presentation: AppPresentation;
  onPause: () => void;
  pauseLabel?: string;
  pauseDisabled?: boolean;
}

export function GameHud({
  courseName,
  presentation,
  onPause,
  pauseLabel = 'Pause run',
  pauseDisabled = false,
}: GameHudProps) {
  const dashPercent = Math.round(
    Math.max(0, Math.min(1, presentation.dashRatio)) * 100,
  );

  return (
    <section className="hud-shell" aria-label="Run heads-up display">
      <header className="hud-header">
        <div>
          <p className="eyebrow">Reef Rush</p>
          <h1 className="hud-course-name">{courseName}</h1>
        </div>
        <button
          className="secondary-button"
          disabled={pauseDisabled}
          onClick={onPause}
          type="button"
        >
          {pauseLabel}
        </button>
      </header>

      <div className="hud-grid">
        <article className="hud-card">
          <span>Time</span>
          <strong>{formatElapsedMs(presentation.elapsedMs)}</strong>
        </article>
        <article className="hud-card">
          <span>Checkpoints</span>
          <strong>
            {presentation.checkpointIndex} / {presentation.checkpointCount}
          </strong>
        </article>
        <article className="hud-card">
          <span>Pearls</span>
          <strong>{presentation.pearlCount}</strong>
        </article>
      </div>

      <article className="dash-meter">
        <div className="dash-meter__label">
          <span>Boost reserve</span>
          <strong>{dashPercent}%</strong>
        </div>
        <div
          aria-hidden="true"
          className="dash-meter__fill"
          style={{ width: `${dashPercent}%` }}
        />
      </article>
      <div className="hud-feedback">
        <p aria-hidden="true">
          {presentation.feedback?.text ?? 'Follow the checkpoint rings'}
        </p>
      </div>
    </section>
  );
}
