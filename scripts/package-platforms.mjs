#!/usr/bin/env node
// Produces one .vsix per platform that node-pty ships prebuilds for.
// Each .vsix bundles ONLY the matching platform's prebuild, so a Mac
// user downloads ~250 KB of native code instead of the everything-
// bundled ~62 MB.
//
// Approach: for each target, temporarily move the unwanted prebuild
// directories out of node_modules/node-pty/prebuilds/ into a sibling
// backup dir, run `vsce package --target <target>`, then move them
// back. The try/finally restores on any failure (Ctrl-C, vsce error,
// etc.) so the repo is never left with missing prebuilds. A leftover
// backup dir on startup is also restored before doing anything else,
// covering the "killed mid-run" case across invocations.
//
// We previously tried doing this purely via .vscodeignore patterns
// appended at runtime, but vsce's minimatch doesn't re-exclude inside
// an already re-included directory (`!node_modules/node-pty/**` wins
// over a more specific exclude added after it). Physically moving the
// dirs sidesteps the rule-precedence gotcha entirely.
//
// Output: dist/<name>-<version>-<target>.vsix per platform.
// Run: pnpm run package-platforms

import { execSync } from 'node:child_process';
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const targets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'];

const distDir = 'dist';
const prebuildsDir = 'node_modules/node-pty/prebuilds';
// IMPORTANT: backup must live OUTSIDE node-pty. .vscodeignore re-includes
// the entire node-pty tree via `!node_modules/node-pty/**`, so a backup
// dir inside it gets bundled into the .vsix — exactly what we're trying
// to strip. node_modules/ itself is excluded and not re-included
// elsewhere, so a sibling at node_modules/.glancer-prebuilds-backup/
// stays out of the package.
const backupDir = 'node_modules/.glancer-prebuilds-backup';

mkdirSync(distDir, { recursive: true });

if (!existsSync(prebuildsDir)) {
  console.error(`Missing ${prebuildsDir} — run \`pnpm install\` first.`);
  process.exit(1);
}

// If a previous run was killed before its `restore()` finished, the
// backup dir may still hold prebuilds. Restore them before doing
// anything else so we always start from a clean node_modules state.
function restoreFromBackup() {
  if (!existsSync(backupDir)) return;
  // Restore stripped .pdb files first so the target prebuild dir is
  // whole again before we touch other-platform dirs (those use
  // rename-over-existing, which would clobber a partially-restored
  // target dir if order were reversed).
  const pdbsRoot = join(backupDir, '__pdbs');
  if (existsSync(pdbsRoot)) {
    for (const target of readdirSync(pdbsRoot)) {
      const targetBackup = join(pdbsRoot, target);
      const targetDir = join(prebuildsDir, target);
      mkdirSync(targetDir, { recursive: true });
      for (const f of readdirSync(targetBackup)) {
        renameSync(join(targetBackup, f), join(targetDir, f));
      }
    }
    rmSync(pdbsRoot, { recursive: true, force: true });
  }
  for (const name of readdirSync(backupDir)) {
    const src = join(backupDir, name);
    const dst = join(prebuildsDir, name);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    renameSync(src, dst);
  }
  rmSync(backupDir, { recursive: true, force: true });
}

restoreFromBackup();

const allPrebuilds = readdirSync(prebuildsDir);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

console.log(`Packaging ${pkg.name}@${pkg.version} for ${targets.length} platforms…\n`);

const results = [];

function moveAside(target) {
  mkdirSync(backupDir, { recursive: true });
  // Other-platform prebuild dirs: move out entirely.
  for (const dir of allPrebuilds) {
    if (dir === target) continue;
    const src = join(prebuildsDir, dir);
    const dst = join(backupDir, dir);
    if (existsSync(src)) renameSync(src, dst);
  }
  // Target-platform .pdb files: Windows debug symbols, ~27 MB per arch,
  // never loaded at runtime. Strip them too. They live under a __pdbs/
  // sub-directory in the backup so restoreFromBackup can route them
  // back to the right prebuild dir on cleanup. We can't drop them via
  // .vscodeignore because `!node_modules/node-pty/**` re-includes
  // everything in node-pty and vsce's minimatch doesn't honour later
  // re-excludes inside a re-included tree.
  const targetDir = join(prebuildsDir, target);
  if (!existsSync(targetDir)) return;
  const pdbsBackup = join(backupDir, '__pdbs', target);
  let movedAny = false;
  for (const f of readdirSync(targetDir)) {
    if (!f.endsWith('.pdb')) continue;
    if (!movedAny) {
      mkdirSync(pdbsBackup, { recursive: true });
      movedAny = true;
    }
    renameSync(join(targetDir, f), join(pdbsBackup, f));
  }
}

try {
  for (const target of targets) {
    if (!allPrebuilds.includes(target)) {
      console.warn(`! Skipping ${target}: no matching prebuild in ${prebuildsDir}`);
      continue;
    }

    moveAside(target);
    try {
      const outFile = join(distDir, `${pkg.name}-${pkg.version}-${target}.vsix`);
      console.log(`→ ${target}`);
      execSync(`npx @vscode/vsce package --target ${target} --out ${outFile}`, {
        stdio: 'inherit',
      });
      results.push({ target, outFile, sizeBytes: statSync(outFile).size });
    } finally {
      restoreFromBackup();
    }
  }
} finally {
  restoreFromBackup();
}

console.log('\nResults:');
for (const r of results) {
  const sizeMB = r.sizeBytes / 1024 / 1024;
  const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${(r.sizeBytes / 1024).toFixed(0)} KB`;
  console.log(`  ${r.target.padEnd(14)} ${sizeStr.padStart(10)}  ${r.outFile}`);
}
console.log(`\nDone. ${results.length} .vsix files in ${distDir}/`);
