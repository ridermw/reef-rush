export interface PauseScreenProps {
  courseName: string;
  onResume: () => void;
  onSettings: () => void;
  onReturnToTitle: () => void;
}

export function PauseScreen({
  courseName,
  onResume,
  onSettings,
  onReturnToTitle,
}: PauseScreenProps) {
  return (
    <section className="overlay-card overlay-card--modal pause-card">
      <p className="eyebrow">Run paused</p>
      <h2>{courseName}</h2>
      <p>Take a breath. The clock is still, and the reef will wait.</p>
      <div className="button-row">
        <button className="primary-button" onClick={onResume} type="button">
          Resume
        </button>
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
