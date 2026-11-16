// Newest first. Add a new entry at the top each time the app changes.
export const VERSIONS = [
  {
    number: 'V3',
    date: '2026-11-16',
    title: 'Ember icon and muted warm theme',
    changes: [
      'New home screen icon: the ember flame, centred.',
      'Softer warm colour theme, with muted amber accents on a dark brown background.',
    ],
  },
  {
    number: 'V2',
    date: '2026-11-16',
    title: 'Connection fix and new icon',
    changes: [
      'The dashboard now updates straight after connecting to GitHub, so the "Not connected" notice goes away.',
      'New home screen icon: a medal.',
      'Version shown at the bottom of the menu.',
    ],
  },
  {
    number: 'V1',
    date: '2026-11-15',
    title: 'First build',
    changes: [
      'Dashboard showing each activity’s current best, target, progress, and trend, with drag-to-reorder.',
      'Activity detail page with full attempt history, a trend chart, and edit and delete with undo.',
      'New personal bests are detected automatically, with beaten and goal-reached flags.',
      'Track-only activities with no target.',
      'Works offline and syncs to a private GitHub repository as one JSON file.',
      'Dark mode, and no notifications.',
      'Menu with Ideas (copy them all to paste into Claude), Version history, and Sync settings.',
    ],
  },
  {
    number: 'V0',
    date: '2026-11-15',
    title: 'Spec written',
    changes: [
      'Personal Best Tracker spec written in the Fitness Goals WebApp project.',
      'Covered platform, data storage and sync, activities, attempts, the dashboard, the detail view, and look and feel.',
    ],
  },
];
