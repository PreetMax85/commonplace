// Reads the palette straight out of globals.css and checks every text pair the
// interface actually uses against WCAG AA (4.5:1 for normal text).
//
// The point is that "is this grey readable" stops being a matter of opinion.
// Run it after changing any colour: npm run check:contrast
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "globals.css"),
  "utf8"
);

// :root holds the light values and .dark overrides a subset of the same names.
function palette(blockName) {
  const start = css.indexOf(blockName);
  const block = css.slice(start, css.indexOf("\n}", start));
  const found = {};
  for (const [, name, l, c, h] of block.matchAll(
    /--color-([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g
  )) {
    found[name] = [Number(l) / 100, Number(c), Number(h)];
  }
  return found;
}

const light = palette(":root {");
const dark = { ...light, ...palette(".dark {") };

function linearRgb([L, C, hDeg]) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminance(colour) {
  const [r, g, b] = linearRgb(colour).map((x) => Math.min(1, Math.max(0, x)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Every combination the components actually put on screen.
const PAIRS = [
  ["ink", "paper"],
  ["ink", "paper-raised"],
  ["ink", "paper-sunken"],
  ["ink", "brand-wash"],
  ["ink-muted", "paper"],
  ["ink-muted", "paper-raised"],
  ["ink-muted", "paper-sunken"],
  ["ink-faint", "paper"],
  ["ink-faint", "paper-raised"],
  ["ink-faint", "paper-sunken"],
  ["brand", "paper"],
  ["brand", "paper-raised"],
  ["brand", "brand-wash"],
  ["brand-ink", "brand"],
  ["status-error", "paper"],
  ["status-error", "paper-raised"],
];

const AA = 4.5;
let failures = 0;

for (const [themeName, colours] of [
  ["light", light],
  ["dark", dark],
]) {
  console.log(`\n${themeName}`);
  for (const [fg, bg] of PAIRS) {
    if (!colours[fg] || !colours[bg]) {
      console.log(`  missing colour: ${fg} or ${bg}`);
      failures++;
      continue;
    }
    const ratio = contrast(colours[fg], colours[bg]);
    const ok = ratio >= AA;
    if (!ok) failures++;
    console.log(`  ${ratio.toFixed(2).padStart(6)}  ${ok ? "ok  " : "FAIL"}  ${fg} on ${bg}`);
  }
}

console.log(
  failures === 0
    ? `\nAll ${PAIRS.length * 2} pairs meet ${AA}:1.`
    : `\n${failures} pair(s) below ${AA}:1.`
);
process.exit(failures === 0 ? 0 : 1);
