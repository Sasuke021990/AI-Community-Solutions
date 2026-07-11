import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Strategy } from '../domain/enums.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SpacePresetAgent {
  name: string;
  role: string;
  systemPrompt: string;
  isOrchestrator: boolean;
}

export interface SpacePreset {
  id: string;
  name: string;
  description: string;
  strategy: Strategy;
  maxRounds: number;
  agents: SpacePresetAgent[];
}

let cache: SpacePreset[] | null = null;

/**
 * Static catalog of prebuilt Space presets, bundled with the package (same
 * pattern as role templates - see Decision #20 and the preset design's
 * Decision #6). Agent prompts are written inline here, not pulled from the
 * general role-template list, since preset agents are structure-locked and
 * reuse doesn't matter.
 */
export function listSpacePresets(): SpacePreset[] {
  if (!cache) {
    const raw = readFileSync(join(__dirname, 'presets.json'), 'utf-8');
    cache = JSON.parse(raw) as SpacePreset[];
  }
  return cache;
}
