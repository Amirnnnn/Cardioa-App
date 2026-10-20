/* Cardioa BLE V3 decoder - one 20-byte notification = 12 unsigned 12-bit samples.
   Pure JS: loaded in browser and usable with Node.js for protocol tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CardioaEcgV3 = api;
})(typeof window === "object" ? window : null, function () {
  "use strict";
  const SAMPLE_RATE_HZ = 200;
  const PACKET_LENGTH = 20;
  const SAMPLES_PER_PACKET = 12;

  function asBytes(data) {
    if (data instanceof DataView) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError("DataView / Uint8Array / ArrayBuffer expected");
  }

  function decodeNotification(data) {
    const b = asBytes(data);
    if (b.length !== PACKET_LENGTH) {
      throw new RangeError(`V3: expected ${PACKET_LENGTH} bytes, got ${b.length}`);
    }
    const firstIndex = b[0] | (b[1] << 8);
    const samples = [];
    for (let i = 2; i < PACKET_LENGTH; i += 3) {
      samples.push(b[i] | ((b[i + 1] & 0x0f) << 8));
      samples.push((b[i + 1] >> 4) | (b[i + 2] << 4));
    }
    return { firstIndex, samples };
  }

  function createTracker() {
    let nextIndex = null;
    let nextPosition = 0; // unwrapped sample clock, prevents timestamp collapse on BLE packets

    return {
      reset() { nextIndex = null; nextPosition = 0; },
      accept(frame) {
        if (!frame || !Number.isInteger(frame.firstIndex) ||
            !Array.isArray(frame.samples) || frame.samples.length !== SAMPLES_PER_PACKET) {
          throw new TypeError("Invalid V3 frame");
        }
        let missing = 0;
        if (nextIndex !== null) {
          missing = (frame.firstIndex - nextIndex + 65536) & 0xffff;
          // Duplicate or old frame. Forward gaps must be under half a u16 cycle.
          if (missing >= 32768) return { accepted: false, missing: 0, startPosition: -1 };
        }
        const startPosition = nextPosition + missing;
        nextPosition = startPosition + frame.samples.length;
        nextIndex = (frame.firstIndex + frame.samples.length) & 0xffff;
        return { accepted: true, missing, startPosition };
      }
    };
  }

  return { SAMPLE_RATE_HZ, PACKET_LENGTH, SAMPLES_PER_PACKET,
           decodeNotification, createTracker };
});
