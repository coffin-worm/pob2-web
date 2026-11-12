import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Keep one refresh token across restarts, encrypted to the Windows user.
 *
 * The sign-in it saves is an OAuth refresh token that can read somebody's
 * account, so the question is not whether to store it but what storing it
 * costs. PoB upstream answers that by writing `lastToken` and
 * `lastRefreshToken` into Settings.xml in the clear (`Main.lua:789`), where
 * anything running as that user, and anything that reads that folder, can
 * have them. This does the same job through DPAPI instead: the ciphertext is
 * bound to the Windows account that wrote it, so a copy taken off the
 * machine, or read by another user, is so much noise.
 *
 * DPAPI is reached through PowerShell rather than a native module, because
 * `ConvertFrom-SecureString` with no key argument is exactly
 * `CryptProtectData` at `CurrentUser` scope, and that is one spawn against a
 * dependency with a compiler in it. The plaintext goes in through an
 * environment variable, never an argument: a command line is readable by
 * every process on the machine, and an environment block is not.
 *
 * Only the refresh token is kept. The access token beside it lasts ten
 * minutes, so saving it would buy nothing and widen what a stolen file is
 * worth. Startup therefore always spends the refresh grant, which has the
 * useful side effect of proving the saved sign-in still works before the UI
 * claims to be signed in.
 *
 * Every failure here is "not signed in" rather than an error. A file from
 * another user account, a file from before a Windows profile reset, a
 * truncated write, a PowerShell that will not run: none of them are worth
 * refusing to start over, and all of them are indistinguishable from never
 * having signed in, which is a state the UI already handles.
 */

/** What the file holds. Versioned so a format change is not a mystery. */
interface Saved {
  version: 1;
  /** DPAPI ciphertext, as the hex string PowerShell hands back. */
  refreshToken: string;
  /** Epoch ms, for a log line and nothing else. */
  savedAt: number;
}

export interface TokenStore {
  /** Where the file lives, for a log line. Never its contents. */
  readonly path: string;
  /** Whether this platform can keep anything at all. */
  readonly available: boolean;
  /** The saved refresh token, or null if there is not one to be had. */
  load(): string | null;
  save(refreshToken: string): void;
  forget(): void;
}

const SCRIPT_ENCRYPT =
  'ConvertTo-SecureString -String $env:POB_TOKEN_IN -AsPlainText -Force | ' +
  'ConvertFrom-SecureString';

const SCRIPT_DECRYPT =
  '$s = ConvertTo-SecureString -String $env:POB_TOKEN_IN; ' +
  '[Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
  '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';

/** One PowerShell round trip, with the secret passed out of band. */
function dpapi(script: string, input: string): string {
  const run = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf-8',
      env: { ...process.env, POB_TOKEN_IN: input },
      windowsHide: true,
    },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    // The message can carry the plaintext back in a quoted error, so only
    // the status goes anywhere a log might see it.
    throw new Error(`powershell exited ${String(run.status)}`);
  }
  const out = (run.stdout ?? '').trim();
  if (!out) throw new Error('powershell returned nothing');
  return out;
}

/**
 * Where to keep it.
 *
 * LocalAppData rather than Documents, because this is machine state and not
 * a document: Documents follows the user into OneDrive, and a token that
 * syncs to another machine is a token on two machines. Rather than TEMP,
 * which is the opposite mistake: the port file in `bridge/` belongs there
 * because it describes a process and should not survive a reboot, and this
 * is the one thing here that should.
 */
function storePath(): string {
  const override = process.env.POB_TOKEN_STORE;
  if (override) return override;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'pob2-web', 'poe-token.json');
}

export function tokenStore(log?: (message: string) => void): TokenStore {
  const file = storePath();
  const available = process.platform === 'win32';
  const say = (message: string) => log?.(message);

  return {
    path: file,
    available,

    load(): string | null {
      if (!available) return null;
      let saved: Saved;
      try {
        saved = JSON.parse(readFileSync(file, 'utf-8')) as Saved;
      } catch {
        // No file is the ordinary case, every day, and says nothing.
        return null;
      }
      if (saved.version !== 1 || typeof saved.refreshToken !== 'string') {
        say('the saved sign-in is in a format this does not read; ignoring it');
        return null;
      }
      try {
        return dpapi(SCRIPT_DECRYPT, saved.refreshToken);
      } catch {
        // Decryption fails when the file came from another Windows account
        // or another machine, which is the case this encryption exists for.
        say('the saved sign-in could not be decrypted on this account; ignoring it');
        return null;
      }
    },

    save(refreshToken: string): void {
      if (!available) return;
      try {
        const body: Saved = {
          version: 1,
          refreshToken: dpapi(SCRIPT_ENCRYPT, refreshToken),
          savedAt: Date.now(),
        };
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(body), { encoding: 'utf-8', mode: 0o600 });
      } catch (err) {
        // Being unable to save is a worse sign-in, not a failed one, so the
        // token in memory stands and the user signs in again next time.
        say(`could not save the sign-in: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    forget(): void {
      try {
        rmSync(file, { force: true });
      } catch {
        // Already gone is the outcome being asked for.
      }
    },
  };
}
