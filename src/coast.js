/**
 * @file Coast — a rate that decays in time, the numeric half of an inertial gesture.
 * @module tree/coast
 * @license AGPL-3.0-only
 *
 * A gesture releases with a rate `v` (per second, any lanes). Each frame
 * `coastStep` writes the exact travel over `dt` under exponential decay with
 * time constant `tau` and decays the rate in place, so the total travel is
 * `v₀ · tau` at any frame rate; `coastAlive` says whether anything is left
 * to apply. A host owns the rate buffer, seeds it at release, adds impulses
 * (an impulse of travel Δ is a rate of Δ / tau) and cancels by zeroing it.
 */

'use strict';

/**
 * The travel over `dt` of a rate decaying with time constant `tau`, the rate
 * decayed in place.
 * @param {number[]} out  Destination, one lane per rate lane: v · tau · (1 − e^(−dt/tau)).
 * @param {number[]} rate  The rate per second, written: v · e^(−dt/tau).
 * @param {number} dt  Seconds; 0 or less writes zero travel and leaves the rate.
 * @param {number} tau  Seconds; 0 or less writes zero travel and zeroes the rate.
 * @returns {number[]} out
 */
export function coastStep(out, rate, dt, tau) {
  const n = rate.length;
  if (!(tau > 0)) { for (let i = 0; i < n; i++) { out[i] = 0; rate[i] = 0; } return out; }
  if (!(dt > 0)) { for (let i = 0; i < n; i++) out[i] = 0; return out; }
  const k = Math.exp(-dt / tau), travel = tau * (1 - k);
  for (let i = 0; i < n; i++) { out[i] = rate[i] * travel; rate[i] *= k; }
  return out;
}

/**
 * Whether a rate still has a lane at or above `eps` in magnitude.
 * @param {number[]} rate
 * @param {number} eps
 * @returns {boolean}
 */
export function coastAlive(rate, eps) {
  for (let i = 0; i < rate.length; i++) if (Math.abs(rate[i]) >= eps) return true;
  return false;
}
