import type { CourseId, CourseSummary } from '../../content/courses/courseIds';

export interface CourseSelectScreenProps {
  courses: readonly CourseSummary[];
  unlockedCourseIds: readonly CourseId[];
  onBack: () => void;
  onSelectCourse: (courseId: CourseId) => void;
}

export function CourseSelectScreen({
  courses,
  unlockedCourseIds,
  onBack,
  onSelectCourse,
}: CourseSelectScreenProps) {
  return (
    <main className="screen screen--course-select">
      <section className="hero-panel hero-panel--compact">
        <p className="eyebrow">Chart your next expedition</p>
        <div className="panel-heading">
          <h1>Choose a course</h1>
          <p>
            Warm shallows today. Wilder waters ahead. Earn a medal in Sunlit
            Shoals to unlock Kelpworks, then a medal in Kelpworks to unlock
            Blacksmoker Run.
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
              disabled={
                !course.available || !unlockedCourseIds.includes(course.id)
              }
              onClick={() => onSelectCourse(course.id)}
              type="button"
            >
              {course.available
                ? `${unlockedCourseIds.includes(course.id) ? 'Load' : 'Locked:'} ${course.name}`
                : `${course.name} - not yet available`}
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
