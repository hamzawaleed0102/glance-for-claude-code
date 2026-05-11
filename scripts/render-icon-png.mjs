#!/usr/bin/env node
// Rasterize resources/icon-source.svg to resources/icon.png at 256x256.
// The Marketplace expects an opaque, full-bleed icon — the source SVG
// renders the gradient + glyph edge-to-edge so the PNG has no
// transparent corners that would reveal the listing background.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'resources', 'icon-source.svg');
const out = join(here, '..', 'resources', 'icon.png');

const svg = readFileSync(src, 'utf8');
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } });
const png = resvg.render().asPng();
writeFileSync(out, png);
console.log(`rendered ${out} (${png.length} bytes)`);
