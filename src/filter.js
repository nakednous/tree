/**
 * @file 1€ input filter — speed-adaptive first-order low-pass for noisy input.
 * @module tree/filter
 * @license AGPL-3.0-only
 *
 * A jitter conditioner for noisy / absolute input streams (the helm's optional
 * `filter` slot; sketch-side handle conditioning). It is NOT a deadzone
 * replacement: a low-pass passes DC, so a constant rest bias survives it and
 * still integrates to creep — only the deadzone's exact-zero clamp removes that.
 * The 1€ removes zero-mean jitter; the two are orthogonal and coexist, applied
 * filter → deadzone (condition the continuous signal first, then gate to zero).
 *
 * First-order low-pass whose cutoff rises with the signal's speed: slow (rest)
 * → low cutoff → heavy smoothing; fast (motion) → high cutoff → low lag. Tuned
 * by `minCutoff` (Hz, the rest cutoff) and `beta` (how fast the cutoff opens
 * with speed). Reimplemented from the paper's equations — `tree` is zero-dep, so
 * the ~one-page primitive is vendored, not depended on (the same call made for
 * quaternions over gl-matrix).
 *
 * Reference: Casiez, G., Roussel, N., & Vogel, D. (2012). 1€ Filter: A Simple
 * Speed-based Low-pass Filter for Noisy Input in Interactive Systems. CHI '12,
 * 2527–2530. DOI 10.1145/2207676.2208639 · https://gery.casiez.net/1euro/
 */

'use strict';

/**
 * Build a stateful 1€ filter as an out-first carrying function.
 *
 * The returned `f` carries the previous filtered value and derivative across
 * calls (one state slot per vector component), and is used in one of two forms:
 *
 *   - vec form    `f(out, raw, dt)` — `out`/`raw` are equal-length ArrayLikes;
 *                 writes the filtered vector into `out` and returns it.
 *                 Zero-allocation after the first call (state sized to `raw`).
 *   - scalar form `f(raw, dt)` — `raw` is a number; returns the filtered number.
 *
 * The form is chosen by the first argument's type (number ⇒ scalar). `minCutoff`,
 * `beta`, and `dCutoff` are live-mutable on the returned function (`f.minCutoff`,
 * `f.beta`, `f.dCutoff`) and read every call, so a panel can tune them against
 * live noise. `f.reset()` drops the carried state at a discontinuity (a
 * re-acquired source, a helm `home()`); smear across one and the output lurches.
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.minCutoff=1]  Minimum (rest) cutoff frequency, in Hz.
 * @param {number}  [opts.beta=0]       Speed coefficient (cutoff = minCutoff +
 *                                       beta·|filtered derivative|); unitless.
 * @param {number}  [opts.dCutoff=1]    Derivative cutoff frequency, in Hz.
 * @returns {Function} A carrying filter `f(out, raw, dt)` / `f(raw, dt)` with a
 *                      `reset()` method and live `minCutoff` / `beta` / `dCutoff`.
 */
export function oneEuro(opts) {
  opts = opts || {};

  // Carried state: previous filtered value + previous filtered derivative.
  // number (scalar form) | number[] (vec form). primed = state is seeded.
  let xPrev = null;
  let dxPrev = null;
  let primed = false;

  // Low-pass smoothing factor for a sample period `dt` and a cutoff frequency
  // (the paper's α = 1 / (1 + τ/Te), τ = 1 / (2π·cutoff)).
  const alpha = (dt, cutoff) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  const smooth = (a, x, xp) => a * x + (1 - a) * xp;

  const scalar = (x, dt) => {
    if (!primed) { xPrev = x; dxPrev = 0; primed = true; return x; }
    const dx  = (x - xPrev) / dt;
    const edx = smooth(alpha(dt, f.dCutoff), dx, dxPrev);
    const a   = alpha(dt, f.minCutoff + f.beta * Math.abs(edx));
    const xh  = smooth(a, x, xPrev);
    xPrev = xh; dxPrev = edx;
    return xh;
  };

  const vec = (out, raw, dt) => {
    const n = raw.length;
    if (!primed) {
      if (!Array.isArray(xPrev) || xPrev.length !== n) {
        xPrev = new Array(n); dxPrev = new Array(n);
      }
      for (let i = 0; i < n; i++) { xPrev[i] = raw[i]; dxPrev[i] = 0; out[i] = raw[i]; }
      primed = true;
      return out;
    }
    for (let i = 0; i < n; i++) {
      const dx  = (raw[i] - xPrev[i]) / dt;
      const edx = smooth(alpha(dt, f.dCutoff), dx, dxPrev[i]);
      const a   = alpha(dt, f.minCutoff + f.beta * Math.abs(edx));
      const xh  = smooth(a, raw[i], xPrev[i]);
      xPrev[i] = xh; dxPrev[i] = edx;
      out[i] = xh;
    }
    return out;
  };

  const f = (out, raw, dt) =>
    (typeof out === 'number') ? scalar(out, raw) : vec(out, raw, dt);

  f.minCutoff = (opts.minCutoff != null) ? opts.minCutoff : 1;
  f.beta      = (opts.beta      != null) ? opts.beta      : 0;
  f.dCutoff   = (opts.dCutoff   != null) ? opts.dCutoff   : 1;

  /** Drop the carried state — call at a discontinuity (re-acquire / home). */
  f.reset = () => { primed = false; return f; };

  return f;
}
