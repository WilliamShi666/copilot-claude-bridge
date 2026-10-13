import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
test('advisor MCP speaks real stdio protocol and exposes plan/review without executing local code', async () => {
  const client = new Client({ name: 'advisor-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/packages/advisor/mcp.js'),'--workspace',process.cwd()], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(x=>x.name).sort(), ['copilot_conversations','copilot_plan','copilot_review']);
    const rejected = await client.callTool({ name: 'copilot_plan', arguments: { task: 'inspect', files: ['../.env'] } }); assert.equal(rejected.isError,true);
  } finally { await client.close(); }
});
