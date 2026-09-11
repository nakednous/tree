/**
 * @file Asserts the core against its own golden vectors (`npm test`).
 *
 * Replays every fixture under golden/ — constants, function cases and class
 * transcripts — against src/, using the tolerance classes the fixtures carry
 * (see tools/golden.js for the format), and checks the coverage rule: every
 * export of src/index.js has a fixture.
 *
 * @module tree/test/golden
 * @license AGPL-3.0-only
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as tree from '../src/index.js';
import { decode, decodeArgs } from '../tools/golden.js';

const GOLDEN = new URL('../golden/', import.meta.url);

/**
 * Deep comparison under a tolerance: numbers pass when
 * |a − b| ≤ tol · max(1, |a|, |b|); everything else is exact.
 */
function close(actual, expected, tol, path) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: expected a number`);
    if (Number.isNaN(expected)) { assert.ok(Number.isNaN(actual), `${path}: expected NaN, got ${actual}`); return; }
    if (!Number.isFinite(expected)) { assert.equal(actual, expected, path); return; }
    const err = Math.abs(actual - expected);
    const lim = tol * Math.max(1, Math.abs(actual), Math.abs(expected));
    assert.ok(err <= lim, `${path}: ${actual} ≠ ${expected} (|Δ| = ${err} > ${lim})`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) || ArrayBuffer.isView(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    for (let i = 0; i < expected.length; i++) close(actual[i], expected[i], tol, `${path}[${i}]`);
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path}: expected an object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const k of Object.keys(expected)) close(actual[k], expected[k], tol, `${path}.${k}`);
    return;
  }
  assert.equal(actual, expected, path);
}

function runCase(name, c, tol, path) {
  const live = decodeArgs(c.args);
  const ret  = tree[name](...live);
  if ('out' in c) close(ret, decode(c.out), tol, `${path}.out`);
  for (const i of Object.keys(c.writes ?? {})) close(live[i], decode(c.writes[i]), tol, `${path}.writes[${i}]`);
}

function runTranscript(t, tolerance) {
  const ctx  = { hooks: [] };
  const ctor = tree[t.class];
  assert.equal(typeof ctor, 'function', `${t.class} is not exported`);
  const args = decodeArgs(t.args ?? [], ctx);
  const inst = /^[A-Z]/.test(t.class) ? new ctor(...args) : ctor(...args);
  t.steps.forEach((s, n) => {
    const path = `${t.name} #${n} ${s.call}`;
    const tol  = tolerance[s.tol ?? t.tol];
    const live = decodeArgs(s.args ?? [], ctx);
    let ret;
    if (s.call === '$get')      ret = live[0] === '$hooks' ? ctx.hooks.splice(0) : inst[live[0]];
    else if (s.call === '$set') inst[live[0]] = live[1];
    else if (s.call === 'f')    ret = inst(...live);
    else if (s.call === '$fn')  ret = tree[live[0]](inst, ...live.slice(1));
    else                        ret = inst[s.call](...live);
    if ('expect' in s) close(ret, decode(s.expect), tol, `${path}.expect`);
    for (const i of Object.keys(s.writes ?? {})) close(live[i], decode(s.writes[i]), tol, `${path}.writes[${i}]`);
  });
}

const files = readdirSync(GOLDEN).filter(f => f.endsWith('.json')).sort();
const covered = new Set();

for (const file of files) {
  const fx = JSON.parse(readFileSync(new URL(file, GOLDEN), 'utf8'));
  test(`golden/${file}`, async (t) => {
    for (const [name, value] of Object.entries(fx.constants ?? {})) {
      covered.add(name);
      await t.test(name, () => close(tree[name], decode(value), 0, name));
    }
    for (const [name, f] of Object.entries(fx.functions ?? {})) {
      covered.add(name);
      await t.test(name, () => {
        assert.equal(typeof tree[name], 'function', `${name} is not exported`);
        f.cases.forEach((c, i) => runCase(name, c, fx.tolerance[f.tol], `${name}[${i}]`));
      });
    }
    for (const tr of fx.transcripts ?? []) {
      covered.add(tr.class);
      for (const s of tr.steps) if (s.call === '$fn') covered.add(s.args[0]);
      await t.test(tr.name, () => runTranscript(tr, fx.tolerance));
    }
  });
}

test('coverage: every export has a fixture', () => {
  const missing = Object.keys(tree).filter(n => !covered.has(n)).sort();
  assert.deepEqual(missing, [], `exports without a fixture: ${missing.join(', ')}`);
});
