export interface LoadingScreenProps {
  courseName: string;
  onCancel: () => void;
}

export function LoadingScreen({ courseName, onCancel }: LoadingScreenProps) {
  return (
    <section className="overlay-card overlay-card--centered" role="status">
      <p className="eyebrow">Preparing dive</p>
      <h1>{courseName}</h1>
      <p>Charting the pearl trail. Your next expedition is almost ready.</p>
      <div aria-hidden="true" className="loading-wave" />
      <button className="secondary-button" onClick={onCancel} type="button">
        Cancel loading
      </button>
    </section>
  );
}
