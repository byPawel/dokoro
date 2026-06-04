/**
 * Built-in Themes for DevLog MCP
 *
 * Four themes ported from tachibot-mcp:
 * - nebula: Modern SaaS look, soft pastels (default)
 * - cyberpunk: High contrast neon on black
 * - minimal: Swiss typography, mostly monochrome
 * - ocean: Cool blues and teals
 */

import { Theme, ThemeName } from './types.js';

// ============================================================================
// THEME: NEBULA (Default - Modern SaaS)
// ============================================================================
// Inspired by VS Code, Linear, Vercel
// Soft pastels, desaturated colors, easy on the eyes

export const nebulaTheme: Theme = {
  name: 'nebula',
  description: 'Modern SaaS look with soft pastels (default)',

  colors: {
    primary: '#5F87FF',    // Soft blue
    secondary: '#5FAF5F',  // Soft green
    accent: '#FFAF5F',     // Warm gold
    success: '#5FAF5F',
    warning: '#FFAF5F',
    error: '#FF5F5F',
    info: '#5F87FF',
    muted: '#666666',
  },

  status: {
    success: { bg: '#5FAF5F', fg: '#000000' },
    error: { bg: '#FF5F5F', fg: '#FFFFFF' },
    warning: { bg: '#FFAF5F', fg: '#000000' },
    info: { bg: '#5F87FF', fg: '#FFFFFF' },
    active: { bg: '#87AFD7', fg: '#000000' },
  },

  text: {
    heading: '#FFFFFF',
    body: '#E0E0E0',
    code: '#87AFD7',
    link: '#5F87FF',
    muted: '#666666',
  },

  borders: {
    default: 'round',
    card: 'round',
    code: 'single',
    blockquote: 'single',
  },

  borderColors: {
    default: '#5F87FF',
    success: '#5FAF5F',
    error: '#FF5F5F',
    warning: '#FFAF5F',
    info: '#5F87FF',
    muted: '#444444',
  },

  bullets: {
    level1: { char: '●', color: '#5FAFFF' },
    level2: { char: '◆', color: '#FFAF5F' },
    level3: { char: '▸', color: '#5FAF5F' },
  },

  gradients: {
    header: 'vice',
    divider: 'mind',
    accent: 'cristal',
  },

  modelBadges: {
    gemini: { bg: '#4285F4', fg: '#FFFFFF', icon: '✦' },
    grok: { bg: '#FF00FF', fg: '#000000', icon: '⚡' },
    openai: { bg: '#10A37F', fg: '#FFFFFF', icon: '◉' },
    perplexity: { bg: '#00CED1', fg: '#000000', icon: '◎' },
    kimi: { bg: '#FFD700', fg: '#000000', icon: '◈' },
    qwen: { bg: '#FF6B6B', fg: '#FFFFFF', icon: '⬡' },
    claude: { bg: '#D97706', fg: '#FFFFFF', icon: '●' },
  },
};

// ============================================================================
// THEME: CYBERPUNK (High Contrast Neon)
// ============================================================================
// Bold neon colors, heavy borders, HUD-style

export const cyberpunkTheme: Theme = {
  name: 'cyberpunk',
  description: 'High contrast neon on black - Blade Runner vibes',

  colors: {
    primary: '#FF00FF',    // Hot magenta
    secondary: '#00FFFF',  // Electric cyan
    accent: '#FFFF00',     // Neon yellow
    success: '#00FF00',
    warning: '#FFFF00',
    error: '#FF0000',
    info: '#00FFFF',
    muted: '#808080',
  },

  status: {
    success: { bg: '#00FF00', fg: '#000000' },
    error: { bg: '#FF0000', fg: '#FFFFFF' },
    warning: { bg: '#FFFF00', fg: '#000000' },
    info: { bg: '#00FFFF', fg: '#000000' },
    active: { bg: '#FF00FF', fg: '#000000' },
  },

  text: {
    heading: '#FF00FF',
    body: '#FFFFFF',
    code: '#00FF00',
    link: '#00FFFF',
    muted: '#808080',
  },

  borders: {
    default: 'double',
    card: 'double',
    code: 'bold',
    blockquote: 'single',
  },

  borderColors: {
    default: '#FF00FF',
    success: '#00FF00',
    error: '#FF0000',
    warning: '#FFFF00',
    info: '#00FFFF',
    muted: '#404040',
  },

  bullets: {
    level1: { char: '▸', color: '#FF00FF' },
    level2: { char: '▹', color: '#00FFFF' },
    level3: { char: '▪', color: '#FFFF00' },
  },

  gradients: {
    header: 'rainbow',
    divider: 'passion',
    accent: 'retro',
  },

  modelBadges: {
    gemini: { bg: '#00FFFF', fg: '#000000', icon: '◈' },
    grok: { bg: '#FF00FF', fg: '#000000', icon: '✦' },
    openai: { bg: '#00FF00', fg: '#000000', icon: '⚡' },
    perplexity: { bg: '#00FFFF', fg: '#000000', icon: '◉' },
    kimi: { bg: '#FFFF00', fg: '#000000', icon: '★' },
    qwen: { bg: '#FF0000', fg: '#FFFFFF', icon: '◆' },
    claude: { bg: '#FFA500', fg: '#000000', icon: '●' },
  },
};

// ============================================================================
// THEME: MINIMAL (Swiss Typography)
// ============================================================================
// Mostly monochrome, clean lines, professional

export const minimalTheme: Theme = {
  name: 'minimal',
  description: 'Clean Swiss typography, minimal color usage',

  colors: {
    primary: '#FFFFFF',
    secondary: '#CCCCCC',
    accent: '#FFFFFF',
    success: '#00AA00',
    warning: '#AAAA00',
    error: '#AA0000',
    info: '#0000AA',
    muted: '#888888',
  },

  status: {
    success: { bg: '#000000', fg: '#00AA00' },
    error: { bg: '#000000', fg: '#AA0000' },
    warning: { bg: '#000000', fg: '#AAAA00' },
    info: { bg: '#000000', fg: '#0000AA' },
    active: { bg: '#000000', fg: '#FFFFFF' },
  },

  text: {
    heading: '#FFFFFF',
    body: '#CCCCCC',
    code: '#AAAAAA',
    link: '#FFFFFF',
    muted: '#666666',
  },

  borders: {
    default: 'single',
    card: 'single',
    code: 'single',
    blockquote: 'classic',
  },

  borderColors: {
    default: '#666666',
    success: '#00AA00',
    error: '#AA0000',
    warning: '#AAAA00',
    info: '#0000AA',
    muted: '#444444',
  },

  bullets: {
    level1: { char: '•', color: '#FFFFFF' },
    level2: { char: '◦', color: '#AAAAAA' },
    level3: { char: '-', color: '#888888' },
  },

  gradients: {
    header: 'mind',      // Subtle
    divider: 'mind',
    accent: 'mind',
  },

  modelBadges: {
    gemini: { bg: '#333333', fg: '#4285F4', icon: '◈' },
    grok: { bg: '#333333', fg: '#FF00FF', icon: '✦' },
    openai: { bg: '#333333', fg: '#10A37F', icon: '◉' },
    perplexity: { bg: '#333333', fg: '#00CED1', icon: '◎' },
    kimi: { bg: '#333333', fg: '#FFD700', icon: '★' },
    qwen: { bg: '#333333', fg: '#FF6B6B', icon: '◆' },
    claude: { bg: '#333333', fg: '#D97706', icon: '●' },
  },
};

// ============================================================================
// THEME: OCEAN (Cool Blues)
// ============================================================================
// Calming blue palette, professional look

export const oceanTheme: Theme = {
  name: 'ocean',
  description: 'Cool blues and teals - calm and professional',

  colors: {
    primary: '#00CED1',    // Teal
    secondary: '#4169E1',  // Royal blue
    accent: '#20B2AA',     // Light sea green
    success: '#00FA9A',
    warning: '#FFD700',
    error: '#FF6347',
    info: '#00CED1',
    muted: '#4A6FA5',
  },

  status: {
    success: { bg: '#00FA9A', fg: '#000000' },
    error: { bg: '#FF6347', fg: '#FFFFFF' },
    warning: { bg: '#FFD700', fg: '#000000' },
    info: { bg: '#00CED1', fg: '#000000' },
    active: { bg: '#4169E1', fg: '#FFFFFF' },
  },

  text: {
    heading: '#00CED1',
    body: '#B0C4DE',
    code: '#87CEEB',
    link: '#00CED1',
    muted: '#4A6FA5',
  },

  borders: {
    default: 'round',
    card: 'round',
    code: 'single',
    blockquote: 'single',
  },

  borderColors: {
    default: '#00CED1',
    success: '#00FA9A',
    error: '#FF6347',
    warning: '#FFD700',
    info: '#00CED1',
    muted: '#2F4F6F',
  },

  bullets: {
    level1: { char: '●', color: '#00CED1' },
    level2: { char: '◆', color: '#4169E1' },
    level3: { char: '▸', color: '#20B2AA' },
  },

  gradients: {
    header: 'atlas',
    divider: 'morning',
    accent: 'teen',
  },

  modelBadges: {
    gemini: { bg: '#4169E1', fg: '#FFFFFF', icon: '◈' },
    grok: { bg: '#9370DB', fg: '#FFFFFF', icon: '✦' },
    openai: { bg: '#00FA9A', fg: '#000000', icon: '◉' },
    perplexity: { bg: '#00CED1', fg: '#000000', icon: '◎' },
    kimi: { bg: '#FFD700', fg: '#000000', icon: '★' },
    qwen: { bg: '#FF6347', fg: '#FFFFFF', icon: '◆' },
    claude: { bg: '#FFA500', fg: '#000000', icon: '●' },
  },
};

// ============================================================================
// THEME REGISTRY
// ============================================================================

export const themes: Record<ThemeName, Theme> = {
  nebula: nebulaTheme,
  cyberpunk: cyberpunkTheme,
  minimal: minimalTheme,
  ocean: oceanTheme,
};

/**
 * Get theme by name (defaults to nebula)
 */
export function getTheme(name?: string): Theme {
  if (!name) {
    return nebulaTheme;
  }
  return themes[name as ThemeName] || nebulaTheme;
}

/**
 * Get current theme from environment variable DOKORO_THEME
 */
export function getCurrentTheme(): Theme {
  const themeName = process.env.DOKORO_THEME?.toLowerCase();
  return getTheme(themeName);
}

/**
 * List all available theme names
 */
export function listThemeNames(): ThemeName[] {
  return Object.keys(themes) as ThemeName[];
}
