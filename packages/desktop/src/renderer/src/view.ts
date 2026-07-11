export type View =
  | { name: 'spaces' }
  | { name: 'builder'; spaceId: string | null }
  | { name: 'presets' }
  | { name: 'run'; spaceId: string }
  | { name: 'history'; spaceId: string }
  | { name: 'mcp' }
  | { name: 'settings' };

/** Which top-level sidebar item should be highlighted for a given view. */
export function topLevelFor(view: View): 'spaces' | 'mcp' | 'settings' {
  if (view.name === 'mcp') return 'mcp';
  if (view.name === 'settings') return 'settings';
  return 'spaces';
}
