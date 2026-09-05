export const COURSE_IDS = [
  'sunlit-shoals',
  'kelpworks',
  'blacksmoker-run',
] as const;

export type CourseId = (typeof COURSE_IDS)[number];

export interface CourseSummary {
  id: CourseId;
  name: string;
  summary: string;
  available: boolean;
}

export const COURSES: readonly CourseSummary[] = [
  {
    id: 'sunlit-shoals',
    available: true,
    name: 'Sunlit Shoals',
    summary: 'A bright opening sprint that rewards smooth reef lines.',
  },
  {
    id: 'kelpworks',
    available: true,
    name: 'Kelpworks',
    summary: 'Dense kelp lanes and drifting corners raise the pace.',
  },
  {
    id: 'blacksmoker-run',
    available: false,
    name: 'Blacksmoker Run',
    summary: 'A volatile trench descent built for high-pressure finishes.',
  },
];

export const COURSE_NAMES: Record<CourseId, string> = {
  'sunlit-shoals': 'Sunlit Shoals',
  kelpworks: 'Kelpworks',
  'blacksmoker-run': 'Blacksmoker Run',
};
