import type { CourseId, CourseSummary } from '../../content/courses/courseIds';

export interface CourseSelectScreenProps {
  courses: readonly CourseSummary[];
  onBack: () => void;
  onSelectCourse: (courseId: CourseId) => void;
}

export function CourseSelectScreen({
  courses,
  onBack,
  onSelectCourse,
}: CourseSelectScreenProps) {
  return (
    <main className="screen screen--course-select">
      <section className="hero-panel hero-panel--compact">
        <p className="eyebrow">Shell transition check</p>
        <div className="panel-heading">
          <h1>Choose a course</h1>
          <p>
            Pick the next solo route. The shell loads the selected course while
            the future game runtime remains isolated to the render surface.
          </p>
        </div>
      </section>

      <section aria-label="Available Reef Rush courses" className="course-grid">
        {courses.map((course) => (
          <article className="course-card" key={course.id}>
            <div className="course-card__body">
              <h2>{course.name}</h2>
              <p>{course.summary}</p>
            </div>
            <button
              className="primary-button"
              onClick={() => onSelectCourse(course.id)}
              type="button"
            >
              Load {course.name}
            </button>
          </article>
        ))}
      </section>

      <div className="screen-footer">
        <button className="secondary-button" onClick={onBack} type="button">
          Back to title
        </button>
      </div>
    </main>
  );
}
