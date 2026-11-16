// Newest first. Add a new entry at the top each time the app changes.
export const VERSIONS = [
  {
    number: 'V4',
    date: '2026-11-16',
    title: 'Update pop-up and a friendlier look',
    changes: [
      'After the app updates, a pop-up shows the new version number and what changed, so you know the update worked.',
      'Friendlier, cooler look: a warm greeting, softer cards, smoother motion, and clearer buttons.',
      'Adding an activity and setting a goal are now separate: “New activity” creates the thing you track, and each activity has its own “Set a goal” button.',
      'The new-activity form is split into clear steps: what you track, an optional starting record, and either a goal or track only.',
      'Log an attempt straight from the dashboard with the button on each activity.',
      'A fresh welcome screen that explains the three steps: add an activity, log attempts, set a goal.',
      'Fixed the home screen icon so the flame is centred with no white border (new full-bleed icons, including a maskable one for Android).',
      '“Version history” is now “Version History”.',
    ],
  },
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
      'Menu with Ideas (copy them all to paste into Claude), Version History, and Sync settings.',
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
