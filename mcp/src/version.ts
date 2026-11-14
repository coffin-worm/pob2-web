import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRoot } from './engine.js';

/**
 * When this server was built, and whether the checkout has moved since.
 *
 * A client holds the tool list it was given at `initialize` and has no way
 * to tell that the process answering it predates the work it is asking
 * about. That failure is invisible from the inside: tools behave, they just
 * behave like an older version, so a fix that landed an hour ago looks like
 * a fix that did not work. The one case that proved it was a chat session
 * reporting three bugs that had been fixed before it wrote the report.
 *
 * A notification cannot help. Nothing changes inside a process, so there is
 * nothing to notify about, and a rebuilt server is a different process whose
 * handshake the client may or may not apply to a conversation already open.
 * What was missing was never a message but a fact, so the server states it.
 *
 * Both halves are read at runtime rather than stamped in at build time,
 * which keeps the build a plain `tsc` with no generated file to commit or
 * ignore. The cost is that the comparison is a timestamp against a commit
 * date rather than a commit against a commit, so it answers "probably
 * stale" rather than "stale". That is the honest shape of what can be known
 * here, and it is enough: a rebuild moves the first half past the second.
 */

interface Build {
  /** When the running code was written to disk. */
  builtAt: Date;
  /** The checkout's latest commit, when git is there to ask. */
  head?: { sha: string; at: Date };
  /** The checkout has commits this build cannot contain. */
  stale: boolean;
}

let builtOnce: Date | null = null;
let headSeen: { read: number; value: { sha: string; at: Date } | undefined } | null = null;

/**
 * How long a reading of the checkout's HEAD is trusted for.
 *
 * Short, because the case this exists for is a server left running while
 * the checkout moves underneath it, and 30 seconds of staleness in the
 * staleness report is not worth a git call per tool call.
 */
const HEAD_TTL_MS = 30_000;

/** The newest mtime among the files that make up the running server. */
function builtAt(): Date {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let newest = 0;
  for (const name of ['index.js', 'tools.js', 'render.js', 'client.js', 'engine.js']) {
    try {
      const at = statSync(path.join(here, name)).mtimeMs;
      if (at > newest) newest = at;
    } catch {
      // A file that is not there cannot be the newest one.
    }
  }
  // Nothing readable means this is not a built tree, so the module's own
  // timestamp is the best available answer.
  return new Date(newest || statSync(fileURLToPath(import.meta.url)).mtimeMs);
}

/**
 * The checkout's latest commit.
 *
 * `git` rather than reading `.git` by hand, because a commit's date lives
 * in a zlib-compressed object and the whole point of this is to be a cheap
 * fact rather than a second implementation of anything. Absent git, absent
 * repository, or a shell that will not run it: no answer, and no comparison
 * drawn from one.
 */
function head(root: string): { sha: string; at: Date } | undefined {
  try {
    const run = spawnSync('git', ['-C', root, 'log', '-1', '--format=%h %cI'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5_000,
    });
    if (run.status !== 0) return undefined;
    const [sha, when] = run.stdout.trim().split(/\s+/);
    if (!sha || !when) return undefined;
    const at = new Date(when);
    return Number.isNaN(at.getTime()) ? undefined : { sha, at };
  } catch {
    return undefined;
  }
}

/**
 * One half read once, the other kept fresh.
 *
 * What this process is running cannot change while it runs, so the build
 * time is read once and kept. The checkout's HEAD is the opposite: commits
 * land while the server sits there, and an earlier version of this cached
 * both, which meant a server started before the work went on reporting
 * "after the checkout's latest commit" however far behind it fell. A client
 * asking that server what it was missing was told nothing was missing.
 */
export function serverBuild(): Build {
  builtOnce ??= builtAt();
  const now = Date.now();
  if (headSeen === null || now - headSeen.read > HEAD_TTL_MS) {
    headSeen = { read: now, value: head(findRoot()) };
  }
  const latest: { sha: string; at: Date } | undefined = headSeen.value;
  return {
    builtAt: builtOnce,
    ...(latest ? { head: latest } : {}),
    // A minute of slack, because the two clocks being compared are a file
    // timestamp and a commit date, and a commit made seconds before the
    // build it is part of should not read as newer than it.
    stale: latest !== undefined && latest.at.getTime() > builtOnce.getTime() + 60_000,
  };
}

/** One line for the end of an answer, or two when it looks out of date. */
export function buildLine(): string {
  const build = serverBuild();
  const when = build.builtAt.toISOString().slice(0, 16).replace('T', ' ');
  if (!build.head) return `Server built ${when}.`;
  const commit = build.head.at.toISOString().slice(0, 16).replace('T', ' ');
  if (!build.stale) {
    return `Server built ${when}, after the checkout's latest commit ${build.head.sha}.`;
  }
  return (
    `Server built ${when}, but the checkout is at ${build.head.sha} from ` +
    `${commit}. This server cannot contain that work, so a tool missing or ` +
    'refusing an argument is the likely reason: rebuild `mcp/` and restart ' +
    'the client.'
  );
}
