export interface LoadingScreenProps {
  courseName: string;
}

export function LoadingScreen({ courseName }: LoadingScreenProps) {
  return (
    <section className="overlay-card overlay-card--centered" role="status">
      <p className="eyebrow">Preparing dive</p>
      <h1>{courseName}</h1>
      <p>
        The React shell is holding the loading state while the future gameplay
        runtime claims the render surface below.
      </p>
      <div aria-hidden="true" className="loading-wave" />
    </section>
  );
}
