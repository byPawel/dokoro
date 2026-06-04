/**
 * Smart Icon System for DevLog MCP
 * Ported from tachibot-mcp's ink-renderer.tsx
 *
 * Auto-detects Nerd Font support and falls back to Unicode
 */

// ============================================================================
// UNICODE ICONS (Fallback - works everywhere)
// ============================================================================

export const unicodeIcons = {
  // Status
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',

  // Progress
  active: '◉',
  paused: '◎',
  completed: '●',
  pending: '○',

  // Actions
  play: '▶',
  pause: '‖',
  stop: '■',
  refresh: '↻',
  sync: '⟳',

  // Objects
  file: '▤',
  folder: '▧',
  tag: '⏏',
  link: '⛓',
  clock: '◷',
  calendar: '▦',

  // UI
  arrowRight: '→',
  arrowLeft: '←',
  arrowUp: '↑',
  arrowDown: '↓',
  chevronRight: '›',

  // Data
  chart: '▊',
  database: '⛁',

  // Misc
  star: '★',
  heart: '♥',
  bolt: '⚡',
  sparkle: '✦',
  task: '◆',
  issue: '◇',
  branch: '├─',
  branchEnd: '└─',
  pipe: '│',
} as const;

// ============================================================================
// NERD FONT ICONS (Requires Nerd Font installed)
// ============================================================================

export const nerdIcons = {
  // Status
  success: '',      // fa-check
  error: '',        // fa-times
  warning: '',      // fa-warning
  info: '',         // fa-info-circle

  // Progress
  active: '',       // fa-circle (filled)
  paused: '',       // fa-pause-circle
  completed: '',    // fa-check-circle
  pending: '',      // fa-circle-o

  // Actions
  play: '',         // fa-play
  pause: '',        // fa-pause
  stop: '',         // fa-stop
  refresh: '',      // fa-refresh
  sync: '',         // fa-sync

  // Objects
  file: '',         // fa-file
  folder: '',       // custom-folder
  tag: '',          // fa-tag
  link: '',         // fa-link
  clock: '',        // fa-clock
  calendar: '',     // fa-calendar

  // UI
  arrowRight: '',   // fa-arrow-right
  arrowLeft: '',    // fa-arrow-left
  arrowUp: '',      // fa-arrow-up
  arrowDown: '',    // fa-arrow-down
  chevronRight: '', // fa-chevron-right

  // Data
  chart: '',        // fa-bar-chart
  database: '',     // fa-database

  // Misc
  star: '',         // fa-star
  heart: '',        // fa-heart
  bolt: '',         // fa-bolt
  sparkle: '',      // md-creation
  task: '',         // fa-tasks
  issue: '',        // fa-exclamation-circle
  branch: '',       // dev-git-branch
  branchEnd: '',    // dev-git-branch
  pipe: '│',

  // DevLog specific
  session: '󰧑',     // md-brain
  workspace: '',   // md-robot
  search: '',      // fa-search
  edit: '',        // fa-pencil
  save: '',        // fa-floppy
  trash: '',       // fa-trash
  copy: '',        // fa-copy
  terminal: '',    // dev-terminal
  code: '',        // fa-code
  cog: '',         // fa-cog
  user: '',        // fa-user
  lock: '',        // fa-lock
  unlock: '',      // fa-unlock
} as const;

export type IconName = keyof typeof unicodeIcons;
export type NerdIconName = keyof typeof nerdIcons;

// ============================================================================
// SMART DETECTION
// ============================================================================

let _nerdFontSupport: boolean | null = null;

/**
 * Check if terminal supports Nerd Fonts
 */
export function hasNerdFontSupport(): boolean {
  if (_nerdFontSupport !== null) return _nerdFontSupport;

  // Explicit enable/disable via env
  const explicit = process.env.DOKORO_ICON_MODE || process.env.NERD_FONTS;
  if (explicit === 'nerd' || explicit === '1' || explicit === 'true') {
    _nerdFontSupport = true;
    return true;
  }
  if (explicit === 'unicode' || explicit === 'emoji' || explicit === '0' || explicit === 'false') {
    _nerdFontSupport = false;
    return false;
  }

  // Auto-detect based on terminal
  const term = process.env.TERM_PROGRAM || '';
  const nerdTerminals = [
    'iTerm.app',
    'WezTerm',
    'kitty',
    'Alacritty',
    'Hyper',
    'vscode',
    'Tabby',
    'Warp',
  ];

  if (nerdTerminals.some(t => term.toLowerCase().includes(t.toLowerCase()))) {
    _nerdFontSupport = true;
    return true;
  }

  // Check for specific terminal env vars
  if (process.env.KITTY_WINDOW_ID || process.env.WEZTERM_PANE) {
    _nerdFontSupport = true;
    return true;
  }

  // Default: no Nerd Font (safe fallback)
  _nerdFontSupport = false;
  return false;
}

/**
 * Reset detection cache (for testing)
 */
export function resetIconCache(): void {
  _nerdFontSupport = null;
}

// ============================================================================
// UNIFIED ICON FUNCTION
// ============================================================================

/**
 * Get icon by name - auto-detects Nerd Font support
 *
 * @example
 * icon('success')  // '' or '✓'
 * icon('folder')   // '' or '▧'
 */
export function icon(name: string): string {
  const useNerd = hasNerdFontSupport();

  if (useNerd && name in nerdIcons) {
    return nerdIcons[name as NerdIconName];
  }

  if (name in unicodeIcons) {
    return unicodeIcons[name as IconName];
  }

  return '•';
}

/**
 * Get raw Nerd Font icon (no fallback)
 */
export function getNerdIcon(name: NerdIconName): string {
  return nerdIcons[name] || '';
}

/**
 * Get raw Unicode icon (no Nerd Font)
 */
export function getUnicodeIcon(name: IconName): string {
  return unicodeIcons[name] || '';
}

// ============================================================================
// ICON PROXY (Dynamic access)
// ============================================================================

/**
 * Icon proxy - access icons like Icon.success, Icon.folder
 * Auto-detects Nerd Font support
 */
export const Icon = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) {
    return icon(prop);
  },
});
