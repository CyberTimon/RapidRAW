import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { toolDefinitions } from '../dist/tools.js';

test('every native bridge method is exposed by the Node MCP host', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src-tauri/src/mcp_bridge/operations.rs', import.meta.url)),
    'utf8',
  );
  const inventory = source.match(/pub\(super\) const METHODS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(inventory, 'native method inventory must be readable');
  const native = [...inventory[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  const host = toolDefinitions.map((definition) => definition.method);
  const hostOnly = [
    'start_operation',
    'get_operation_job',
    'list_operation_jobs',
    'cancel_operation_job',
    'resume_operation_job',
  ];
  assert.deepEqual(
    native.filter((method) => !host.includes(method)),
    [],
  );
  assert.deepEqual(host.filter((method) => !native.includes(method)).sort(), hostOnly.sort());
  assert.equal(new Set(host).size, host.length, 'host methods must be unique');
});
