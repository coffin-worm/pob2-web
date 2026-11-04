import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Extract PoB's tree artwork on first run, if it is not there yet.
 *
 * `tools/tree_art.py` turns the game's zstd-compressed DDS texture arrays
 * into a WebP atlas the browser can draw. That takes about twenty seconds
 * and the result is a gitignored build product, so a fresh checkout would
 * otherwise show a tree of plain circles until someone noticed the hint in
 * the HUD and ran it by hand.
 *
 * The dev server does not wait for it: it comes up immediately, the tree
 * renders in its fallback form, and the art appears on the next reload:
 * a far better twenty seconds than a blank terminal. A build does wait,
 * because a build that quietly omits the artwork ships a tree of plain
 * circles with nothing to say why.
 */
export function treeArt(options: { repoRoot: string }): Plugin {
  const { repoRoot } = options;
  const out = resolve(repoRoot, 'web/public/tree-art');
  const args = [
    resolve(repoRoot, 'web/tools/tree_art.py'),
    '--tree-data',
    resolve(repoRoot, 'src/TreeData'),
    '--out',
    out,
  ];

  const extracted = () => existsSync(resolve(out, 'manifest.json'));

  /**
   * Extract and wait, for a build.
   *
   * Blocking is right here and wrong for the dev server. A build has one
   * job: produce the thing that ships, and a build that quietly omits
   * the artwork produces a tree of plain circles with nothing to say why.
   */
  const extractNow = () =>
    new Promise<void>((done) => {
      const child = spawnSync('python', args, { cwd: repoRoot, encoding: 'utf-8' });
      if (child.status !== 0) {
        console.warn(
          `[tree-art] extraction failed (exit ${child.status}); the built tree will ` +
            `draw circles. ${(child.stderr || '').trim()}`,
        );
      } else {
        // The script prints a line per atlas and a summary last; the
        // whole thing is a handful of lines and worth seeing on a build.
        console.info(`[tree-art] ${(child.stdout || '').trim()}`);
      }
      done();
    });

  return {
    name: 'pob-tree-art',

    /** A build waits for it; see extractNow. */
    async buildStart() {
      if (extracted()) return;
      await extractNow();
    },

    configureServer(server) {
      if (extracted()) return;

      server.config.logger.info('[tree-art] extracting passive tree artwork…');
      const child = spawn('python', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

      let lastLine = '';
      child.stdout.on('data', (chunk: Buffer) => {
        lastLine = chunk.toString().trim().split('\n').pop() ?? lastLine;
      });
      // Python's own message says what is missing (no interpreter, no
      // Pillow, the wrong version) and guessing at it here would only get
      // in the way of the real one.
      child.stderr.on('data', (chunk: Buffer) => {
        server.config.logger.warn(`[tree-art] ${chunk.toString().trim()}`);
      });
      child.on('error', (error) => {
        server.config.logger.warn(`[tree-art] could not run python: ${error.message}`);
      });
      child.on('exit', (code) => {
        if (code === 0) {
          server.config.logger.info(`[tree-art] ${lastLine} (reload to see it)`);
        } else {
          server.config.logger.warn(
            `[tree-art] extraction failed (exit ${code}); the tree will draw circles. ` +
              'Run `npm run tree-art` for the full output.',
          );
        }
      });
    },
  };
}
