export interface PauseScreenProps {
  courseName: string;
  onResume: () => void;
  graphicsLost: boolean;
  onRetryCourse: () => void;
  onSettings: () => void;
  onReturnToTitle: () => void;
}

export function PauseScreen({
  courseName,
  onResume,
  graphicsLost,
  onRetryCourse,
  onSettings,
  onReturnToTitle,
}: PauseScreenProps) {
  return (
    <section className="overlay-card overlay-card--modal pause-card">
      <p className="eyebrow">Run paused</p>
      <h2>{courseName}</h2>
      <p>Take a breath. The clock is still, and the reef will wait.</p>
      {graphicsLost && (
        <p>Retry restarts this attempt and preserves saved progress.</p>
      )}
      <div className="button-row">
        <button
          className="primary-button"
          disabled={graphicsLost}
          onClick={onResume}
          type="button"
        >
          Resume
        </button>
        {graphicsLost && (
          <button
            className="secondary-button"
            onClick={onRetryCourse}
            type="button"
          >
            Retry course
          </button>
        )}
        <button className="secondary-button" onClick={onSettings} type="button">
          Settings
        </button>
        <button
          className="secondary-button"
          onClick={onReturnToTitle}
          type="button"
        >
          Return to title
        </button>
      </div>
    </section>
  );
}
