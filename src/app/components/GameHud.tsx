import type { AppPresentation } from '../appStore';

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((elapsedMs % 1000) / 10);

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds
    .toString()
    .padStart(2, '0')}`;
}

export interface GameHudProps {
  courseName: string;
  presentation: AppPresentation;
  onPause: () => void;
  pauseLabel?: string;
}

export function GameHud({
  courseName,
  presentation,
  onPause,
  pauseLabel = 'Pause run',
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
        <button className="secondary-button" onClick={onPause} type="button">
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
    </section>
  );
}
