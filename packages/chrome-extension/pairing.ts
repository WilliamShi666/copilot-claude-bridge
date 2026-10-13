export const OFFICE_ORIGINS = ['https://fa000000124.officeapps.live.com/*', 'https://excel.officeapps.live.com/*'];
export interface PairIntent { url: string; code: string; tabId: number; created: number }
export interface PairingDependencies {
  read(): Promise<PairIntent | undefined>;
  write(value: PairIntent): Promise<void>;
  clear(): Promise<void>;
  hasPermissions(): Promise<boolean>;
  checkTab(tabId: number): Promise<void>;
  commit(value: PairIntent): Promise<void>;
  status(phase: string, error?: string): Promise<void>;
  now(): number;
}
export function validateIntent(value: unknown, now: number): PairIntent {
  const input = value as Partial<PairIntent> | undefined;
  if (!input || typeof input.url !== 'string' || typeof input.code !== 'string' || !/^[a-f0-9]{40}$/.test(input.code) || !Number.isInteger(input.tabId) || input.tabId! < 0) throw new Error('Enter the local pairing code and select an Excel workbook tab');
  const url = new URL(input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Gateway must be http://127.0.0.1:<port>');
  return { url: url.origin, code: input.code, tabId: input.tabId!, created: now };
}
export function pairingCoordinator(deps: PairingDependencies) {
  let completing = false;
  async function resume() {
    if (completing) return;
    completing = true;
    try {
      const intent = await deps.read(); if (!intent) return;
      if (deps.now() - intent.created > 5 * 60000) { await deps.clear(); await deps.status('failed', 'Pending pairing expired. Open the extension and pair again.'); return; }
      if (!(await deps.hasPermissions())) { await deps.status('awaiting_office_permission'); return; }
      await deps.checkTab(intent.tabId);
      await deps.status('pairing_gateway'); await deps.commit(intent); await deps.clear(); await deps.status('paired');
    } catch (error) { await deps.clear(); await deps.status('failed', error instanceof Error ? error.message : 'Pairing failed'); }
    finally { completing = false; }
  }
  async function prepare(value: unknown) {
    const intent = validateIntent(value, deps.now());
    await deps.checkTab(intent.tabId); await deps.write(intent);
    // Permissions may have been granted while write awaited; re-check after saving.
    await resume(); return { ok: true };
  }
  return { prepare, resume };
}
