export interface PauseScreenProps {
  courseName: string;
  onResume: () => void;
  onReturnToTitle: () => void;
}

export function PauseScreen({
  courseName,
  onResume,
  onReturnToTitle,
}: PauseScreenProps) {
  return (
    <section className="overlay-card overlay-card--modal">
      <p className="eyebrow">Run paused</p>
      <h2>{courseName}</h2>
      <p>
        The shell keeps the render surface mounted so gameplay can resume
        without rebuilding the scene tree.
      </p>
      <div className="button-row">
        <button className="primary-button" onClick={onResume} type="button">
          Resume
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
