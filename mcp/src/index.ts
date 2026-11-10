#!/usr/bin/env node
/**
 * An MCP server over Path of Building's calc engine.
 *
 * The engine already answers JSON on loopback for the web UI (bridge/ in
 * the repository root). This exposes the reading half of that to an AI
 * client, plus the what-if routes, which are the interesting part: they ask
 * the engine to price a change and report the difference without touching
 * the build.
 *
 * Nothing here writes a build to disk. The one tool that changes engine
 * state is pob_open_build, and on an engine this process did not start it
 * refuses until told plainly to go ahead, because something may have a
 * window open on that build.
 *
 * Usage, in a client's server configuration:
 *
 *   "pob2": { "command": "node", "args": ["<checkout>/mcp/dist/index.js"] }
 *
 * See mcp/README.md.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Bridge } from './client.js';
import { register } from './tools.js';

const VERSION = '0.1.0';

function wants(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  // --own starts a private engine even when one is already up, which is
  // what you want when somebody is working in the app and should not have
  // the build changed under them.
  const own = wants('--own') || process.env.POB_MCP_OWN === '1';

  const bridge = new Bridge({ own });

  const server = new McpServer(
    { name: 'pob2', version: VERSION },
    {
      instructions:
        'Reads a Path of Building 2 build through the running calc engine. ' +
        'pob_build is the place to start. To judge whether a change is an ' +
        'improvement, use pob_what_if rather than reasoning about the ' +
        "modifiers: it runs the engine's own recalculation and reports the " +
        'difference, which is the same mechanism the app uses when you hover ' +
        'something. Every number comes from the engine; none of it is ' +
        'estimated here.',
    },
  );

  register(server, bridge);

  // The engine is a child process, and an orphan holds a port and a stale
  // build. It is announced in the port file, so the next run attaches to it
  // rather than piling up, but a clean exit should still take it with us.
  //
  // The teardown itself is in the `exit` handler and nowhere else. It is
  // synchronous, which is the only kind of work that handler may do, and
  // having one of them means a client that closes stdin, a client that
  // signals, and an uncaught failure all leave through the same door.
  process.on('exit', () => bridge.stop());
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  // stdin closing is how a client says it is done with a stdio server.
  process.stdin.once('close', () => process.exit(0));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[pob2-mcp] ready, version ${VERSION}\n`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pob2-mcp] could not start: ${reason}\n`);
  process.exit(1);
});
