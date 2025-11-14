#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');

const scriptsDir = path.resolve(__dirname);
const env = { ...process.env };
env.PATH = `${scriptsDir}${path.delimiter}${env.PATH || ''}`;

const child = spawn('tauri', ['dev'], {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
