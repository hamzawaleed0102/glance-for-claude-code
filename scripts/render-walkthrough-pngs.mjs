#!/usr/bin/env node
// Rasterize media/walkthrough/*.svg to PNG. VS Code walkthroughs render
// PNG cleanly; SVG is supported but flickers on theme change in some
// builds — same reason resources/readme is rasterized for the README.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'media', 'walkthrough');

const SCALE = 2;

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.svg')) continue;
  const svg = readFileSync(join(dir, f), 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: SCALE } });
  const png = resvg.render().asPng();
  const out = join(dir, basename(f, '.svg') + '.png');
  writeFileSync(out, png);
  console.log(`rendered ${f} -> ${basename(out)} (${png.length} bytes)`);
}
