#!/usr/bin/env node
// node-pty's prebuilt `spawn-helper` ships without the executable bit set
// (the npm tarball strips file modes), which makes `posix_spawnp` fail
// inside VS Code's hardened runtime. We chmod +x it on every install.

import fs from 'node:fs';
import path from 'node:path';

const platform = `${process.platform}-${process.arch}`;
const helper = path.join(
  process.cwd(),
  'node_modules',
  'node-pty',
  'prebuilds',
  platform,
  'spawn-helper',
);

if (fs.existsSync(helper)) {
  fs.chmodSync(helper, 0o755);
  console.log(`[fix-pty] chmod +x ${helper}`);
} else {
  // Not fatal — on Windows this path won't exist.
  console.log(`[fix-pty] no helper at ${helper} (skipping)`);
}
