// Drives the MCP server the way a client does: real stdio, real protocol.
// Prints each answer's size and a capped excerpt, so a 40 kB stat sheet does
// not have to be read in full to know it is right.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CAP = Number(process.env.CAP ?? 900);
const SERVER = process.argv[2];
const PLAN = JSON.parse(process.argv[3] ?? '[]');

const client = new Client({ name: 'probe', version: '0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: 'pipe',
});

transport.stderr?.on('data', (d) => process.stderr.write(String(d)));

await client.connect(transport);
console.log('connected');

const tools = await client.listTools();
console.log(`\ntools (${tools.tools.length}):`);
for (const tool of tools.tools) {
  const keys = Object.keys(tool.inputSchema?.properties ?? {});
  console.log(`  ${tool.name}(${keys.join(', ')})`);
}

for (const step of PLAN) {
  const { name, args = {}, label } = step;
  const started = Date.now();
  let text = '';
  let flag = '';
  try {
    const result = await client.callTool({ name, arguments: args });
    text = result.content.map((part) => part.text ?? '').join('\n');
    flag = result.isError ? ' ERROR' : '';
  } catch (error) {
    text = `threw: ${error.message}`;
    flag = ' THREW';
  }
  const ms = Date.now() - started;
  console.log(
    `\n===== ${label ?? name} ${JSON.stringify(args)} ` +
      `[${text.length} chars, ${ms} ms${flag}] =====`,
  );
  console.log(text.length > CAP ? `${text.slice(0, CAP)}\n... (+${text.length - CAP})` : text);
}

await client.close();
console.log('\nclosed');
