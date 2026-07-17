// Theme tokens and color-capability detection for the TUI.
//
// The product keeps its dark blue-purple identity through the full-color theme,
// but every essential meaning is also carried by a glyph or label so the
// reduced-color (no-hue) theme never loses information. Capability is detected
// from the environment (NO_COLOR / TERM / FORCE_COLOR) and can be overridden
// with OMC_THEME; a future layered settings layer can supersede this without
// changing the rendering call sites.

const ESC = '\x1b[';

// A theme is the set of semantic styling tokens the renderer uses. Keeping it a
// single injectable shape is what makes the palette "configurable".
export interface Theme {
  reset: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  white: (s: string) => string;
  red: (s: string) => string;
  magenta: (s: string) => string;
  reverse: (s: string) => string;
}

// Full-color theme: the established dark blue-purple identity.
export const fullTheme: Theme = {
  reset: (s) => `${ESC}0m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
  blue: (s) => `${ESC}34m${s}${ESC}0m`,
  cyan: (s) => `${ESC}36m${s}${ESC}0m`,
  gray: (s) => `${ESC}90m${s}${ESC}0m`,
  white: (s) => `${ESC}37m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`,
  magenta: (s) => `${ESC}35m${s}${ESC}0m`,
  reverse: (s) => `${ESC}7m${s}${ESC}0m`,
};

// Reduced-color theme: no hue, only intensity/structure. Bold, dim, and reverse
// remain so emphasis and selection are still visible on terminals without color
// (or when NO_COLOR is set). Meaning is carried by glyphs and labels, never hue.
export const monoTheme: Theme = {
  reset: (s) => s,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  green: (s) => s,
  yellow: (s) => s,
  blue: (s) => s,
  cyan: (s) => s,
  gray: (s) => s,
  white: (s) => s,
  red: (s) => s,
  magenta: (s) => s,
  reverse: (s) => `${ESC}7m${s}${ESC}0m`,
};

export type ColorCapability = 'full' | 'none';

// Detect the color capability the renderer should target. Honors NO_COLOR
// (https://no-color.org), a dumb/absent TERM, and FORCE_COLOR overrides.
export function detectColorCapability(
  env: NodeJS.ProcessEnv = process.env,
): ColorCapability {
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return 'full';
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return 'none';
  const term = env['TERM'];
  if (term === undefined || term === '' || term === 'dumb') return 'none';
  return 'full';
}

export function themeFor(capability: ColorCapability): Theme {
  return capability === 'none' ? monoTheme : fullTheme;
}

// Resolve the theme to use: an explicit OMC_THEME override wins, otherwise the
// detected capability decides. Unknown overrides fall back to auto-detection.
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const override = env['OMC_THEME'];
  if (override === 'full') return fullTheme;
  if (override === 'mono') return monoTheme;
  return themeFor(detectColorCapability(env));
}
