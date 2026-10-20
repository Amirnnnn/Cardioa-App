/* Optional Cardioa visualization-only ECG denoiser.
   Symmetric binomial low-pass: gentle 5 taps (25 ms at 200 Hz),
   stronger 7 taps (35 ms). No phase shift for isolated symmetric waves.
   It can soften QRS and cannot recover ADC clipping or eliminate motion
   artifacts. Never use this output as a medical diagnostic signal.
   Pure JS; browser global + Node.js require for tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CardioaDisplayFilter = api;
})(typeof window === "object" ? window : null, function () {
  "use strict";
  const KERNELS = Object.freeze({
    gentle: Object.freeze([1, 4, 6, 4, 1]),
    stronger: Object.freeze([1, 6, 15, 20, 15, 6, 1])
  });

  function filter(samples, strength = "gentle") {
    if (!Array.isArray(samples)) throw new TypeError("Array expected");
    const kernel = KERNELS[strength] || KERNELS.gentle;
    const radius = Math.floor(kernel.length / 2);
    const out = new Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (!Number.isFinite(v)) {
        // Preserve missing sample gaps, rather than drawing fake voltages.
        out[i] = null;
        continue;
      }
      let weighted = kernel[radius] * v;
      let weightTotal = kernel[radius];

      // Stop on the first gap in each direction so we never smooth across
      // disconnected ECG segments, including wrap/gap placeholders.
      for (let offset = 1; offset <= radius; offset++) {
        const j = i - offset;
        if (j < 0 || !Number.isFinite(samples[j])) break;
        weighted += kernel[radius - offset] * samples[j];
        weightTotal += kernel[radius - offset];
      }
      for (let offset = 1; offset <= radius; offset++) {
        const j = i + offset;
        if (j >= samples.length || !Number.isFinite(samples[j])) break;
        weighted += kernel[radius + offset] * samples[j];
        weightTotal += kernel[radius + offset];
      }
      out[i] = weighted / weightTotal;
    }
    return out;
  }
  return { filter, KERNELS };
});
