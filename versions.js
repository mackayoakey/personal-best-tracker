// Newest first. Add a new entry at the top each time the app changes.
export const VERSIONS = [
  {
    number: 'v1.0',
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
    number: 'v0.1',
    date: '2026-11-15',
    title: 'Spec written',
    changes: [
      'Personal Best Tracker spec written in the Fitness Goals WebApp project.',
      'Covered platform, data storage and sync, activities, attempts, the dashboard, the detail view, and look and feel.',
    ],
  },
];
