/**
 * matrix/sdk.ts — Matrix JS SDK loader and client factory.
 *
 * Properly imports and initializes the matrix-js-sdk so it is available
 * at runtime for features that require it (E2EE, /sync, etc.).
 *
 * The thin fetch wrapper in client.ts handles basic REST calls.
 * This module provides the full SDK client when encryption or real-time
 * sync is needed.
 */

import * as matrixcs from 'matrix-js-sdk';

// ── Global availability ──────────────────────────────────────────────────────
// Some consumers check `window.matrixcs` to detect whether the SDK is loaded.
// Setting it here ensures the check passes once this module is imported.
declare global {
  interface Window {
    matrixcs?: typeof matrixcs;
  }
}
window.matrixcs = matrixcs;

// ── SDK status ───────────────────────────────────────────────────────────────

let sdkReady = false;

try {
  sdkReady = typeof matrixcs.createClient === 'function';
} catch {
  sdkReady = false;
}

/** Returns true once the Matrix JS SDK has been successfully loaded. */
export function isSDKLoaded(): boolean {
  return sdkReady;
}

// ── Client factory ───────────────────────────────────────────────────────────

let activeClient: matrixcs.MatrixClient | null = null;

export interface SDKClientOpts {
  homeserver: string;
  accessToken?: string;
  userId?: string;
  deviceId?: string;
}

/**
 * Create (or replace) the singleton SDK client.
 * Call this after a successful Matrix login.
 */
export function createSDKClient(opts: SDKClientOpts): matrixcs.MatrixClient {
  if (activeClient) {
    activeClient.stopClient();
  }

  activeClient = matrixcs.createClient({
    baseUrl: opts.homeserver,
    accessToken: opts.accessToken,
    userId: opts.userId,
    deviceId: opts.deviceId,
  });

  return activeClient;
}

/** Return the current SDK client, or null if none has been created yet. */
export function getSDKClient(): matrixcs.MatrixClient | null {
  return activeClient;
}

/** Tear down the active client (call on logout). */
export function destroySDKClient(): void {
  if (activeClient) {
    activeClient.stopClient();
    activeClient = null;
  }
}

// Re-export the SDK namespace for direct access when needed
export { matrixcs };
