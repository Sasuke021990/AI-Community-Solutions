import type { AcsApi } from '../../preload/index.js';

export {};

declare global {
  interface Window {
    acs: AcsApi;
  }
}
