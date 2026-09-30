(() => {
  "use strict";

  // ============================================================
  // Cardioa device configuration
  // BLE values are developer-only and are NOT exposed in the UI.
  // Display values below are editable by the user under the chart.
  // ============================================================
  const CONFIG = {
    serviceUuid: "4fafc201-1fb5-459e-8fcc-c5c9c331914b",
    characteristicUuid: "beb5483e-36e1-4688-b7f5-ea07361b26a8",
    dataFormat: "UINT16_LE",
    sampleRateHz: 250,
    windowSeconds: 8,
    autoScale: true,
    fixedCenter: 2048,
    fixedSpan: 1200
  };

  const DISPLAY_SETTINGS_KEY = "cardioa-display-settings-v4";

  const $ = (id) => document.getElementById(id);
  const ui = {
    connectBtn: $("connectBtn"),
    disconnectBtn: $("disconnectBtn"),
    demoBtn: $("demoBtn"),
    statsToggleBtn: $("statsToggleBtn"),
    statsGrid: $("statsGrid"),
    clearBtn: $("clearBtn"),
    recordBtn: $("recordBtn"),
    exportBtn: $("exportBtn"),
    printBtn: $("printBtn"),
    message: $("message"),
    connectionBadge: $("connectionBadge"),
    connectionText: $("connectionText"),
    deviceName: $("deviceName"),
    heartRate: $("heartRate"),
    lastValue: $("lastValue"),
    sampleCount: $("sampleCount"),
    packetCount: $("packetCount"),
    rxRate: $("rxRate"),
    recordState: $("recordState"),
    minValue: $("minValue"),
    maxValue: $("maxValue"),
    bufferSize: $("bufferSize"),
    canvas: $("ecgCanvas"),
    emptyHint: $("emptyHint"),
    sampleRateControl: $("sampleRateControl"),
    windowSecondsControl: $("windowSecondsControl"),
    autoScaleControl: $("autoScaleControl"),
    fixedCenterControl: $("fixedCenterControl"),
    fixedSpanControl: $("fixedSpanControl"),
    fixedCenterSetting: $("fixedCenterSetting"),
    fixedSpanSetting: $("fixedSpanSetting")
  };

  const ctx = ui.canvas.getContext("2d");

  let bluetoothDevice = null;
  let gattServer = null;
  let ecgCharacteristic = null;

  let samples = [];
  let totalSamples = 0;
  let packets = 0;

  let lastRateTime = performance.now();
  let samplesAtLastRate = 0;

  let recording = false;
  let recorded = [];
  let recordStart = 0;

  let demoTimer = null;
  let demoIndex = 0;
  let demoNextTime = 0;

  // ============================================================
  // Heart-rate detector
  //
  // Pipeline:
  // DC removal -> derivative -> square -> moving integration
  // -> adaptive threshold -> refractory period -> RR intervals.
  //
  // The result is an estimate and depends on ECG quality and an
  // accurate sample-rate setting.
  // ============================================================
  const hrState = {
    sampleIndex: 0,
    baseline: null,
    hpPrevious: 0,
    energyQueue: [],
    energySum: 0,
    envelopeMean: 0,
    envelopeVariance: 0,
    inQrs: false,
    lastBeatSample: null,
    rrIntervals: [],
    bpm: null
  };

  function resetHeartRateDetector() {
    hrState.sampleIndex = 0;
    hrState.baseline = null;
    hrState.hpPrevious = 0;
    hrState.energyQueue = [];
    hrState.energySum = 0;
    hrState.envelopeMean = 0;
    hrState.envelopeVariance = 0;
    hrState.inQrs = false;
    hrState.lastBeatSample = null;
    hrState.rrIntervals = [];
    hrState.bpm = null;
    ui.heartRate.textContent = "—";
  }

  function median(values) {
    if (!values.length) return NaN;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function processHeartRateSample(value) {
    const fs = Math.max(1, CONFIG.sampleRateHz);
    hrState.sampleIndex++;

    if (hrState.baseline === null) {
      hrState.baseline = value;
      hrState.hpPrevious = 0;
      return;
    }

    // Slow DC/baseline tracking. A QRS complex remains in the high-pass signal.
    const baselineAlpha = 1 - Math.exp(-1 / (fs * 0.65));
    hrState.baseline += baselineAlpha * (value - hrState.baseline);

    const highPassed = value - hrState.baseline;
    const derivative = highPassed - hrState.hpPrevious;
    hrState.hpPrevious = highPassed;

    const energy = derivative * derivative;

    // About 80 ms moving integration.
    const integrationSamples = Math.max(3, Math.round(fs * 0.08));
    hrState.energyQueue.push(energy);
    hrState.energySum += energy;

    if (hrState.energyQueue.length > integrationSamples) {
      hrState.energySum -= hrState.energyQueue.shift();
    }

    const envelope = hrState.energySum / hrState.energyQueue.length;

    // Adaptive noise floor / threshold.
    const beta = 1 - Math.exp(-1 / (fs * 2.0));
    const delta = envelope - hrState.envelopeMean;
    hrState.envelopeMean += beta * delta;
    hrState.envelopeVariance += beta * ((delta * delta) - hrState.envelopeVariance);

    const envelopeStd = Math.sqrt(Math.max(0, hrState.envelopeVariance));
    const threshold = hrState.envelopeMean + 3.2 * envelopeStd;

    // Let the adaptive threshold learn the signal for the first ~2 s.
    if (hrState.sampleIndex < fs * 2) return;

    const refractorySamples = Math.max(1, Math.round(fs * 0.28));
    const enoughTimeSinceBeat =
      hrState.lastBeatSample === null ||
      (hrState.sampleIndex - hrState.lastBeatSample) > refractorySamples;

    if (envelope > threshold && !hrState.inQrs && enoughTimeSinceBeat) {
      if (hrState.lastBeatSample !== null) {
        const rr = hrState.sampleIndex - hrState.lastBeatSample;
        const instantBpm = 60 * fs / rr;

        // Ignore implausible intervals, then use a median of recent RR intervals.
        if (instantBpm >= 30 && instantBpm <= 220) {
          hrState.rrIntervals.push(rr);
          if (hrState.rrIntervals.length > 7) hrState.rrIntervals.shift();

          const rrMedian = median(hrState.rrIntervals);
          const bpm = 60 * fs / rrMedian;

          if (Number.isFinite(bpm)) {
            hrState.bpm = Math.round(bpm);
            ui.heartRate.textContent = String(hrState.bpm);
          }
        }
      }

      hrState.lastBeatSample = hrState.sampleIndex;
      hrState.inQrs = true;
    }

    // Re-arm detector after the energy has fallen sufficiently.
    if (hrState.inQrs && envelope < threshold * 0.55) {
      hrState.inQrs = false;
    }
  }

  function updateHeartRateTimeout() {
    if (hrState.lastBeatSample === null) return;
    const samplesSinceBeat = hrState.sampleIndex - hrState.lastBeatSample;
    if (samplesSinceBeat > CONFIG.sampleRateHz * 3.2) {
      hrState.bpm = null;
      ui.heartRate.textContent = "—";
    }
  }

  function setMessage(text, type = "info") {
    if (!text) {
      ui.message.hidden = true;
      ui.message.textContent = "";
      ui.message.className = "message";
      return;
    }
    ui.message.hidden = false;
    ui.message.className = `message ${type}`;
    ui.message.textContent = text;
  }

  function setConnectionState(state, label) {
    ui.connectionBadge.className = `badge ${state}`;
    ui.connectionText.textContent = label;
  }

  function currentSampleRate() {
    return CONFIG.sampleRateHz;
  }

  function maxBufferSamples() {
    return Math.max(100, Math.floor(CONFIG.sampleRateHz * CONFIG.windowSeconds));
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function saveDisplaySettings() {
    localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify({
      sampleRateHz: CONFIG.sampleRateHz,
      windowSeconds: CONFIG.windowSeconds,
      autoScale: CONFIG.autoScale,
      fixedCenter: CONFIG.fixedCenter,
      fixedSpan: CONFIG.fixedSpan
    }));
  }

  function loadDisplaySettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || "null");
      if (!saved) return;

      CONFIG.sampleRateHz = clampNumber(saved.sampleRateHz, 50, 2000, CONFIG.sampleRateHz);
      CONFIG.windowSeconds = clampNumber(saved.windowSeconds, 2, 30, CONFIG.windowSeconds);
      CONFIG.autoScale = typeof saved.autoScale === "boolean" ? saved.autoScale : CONFIG.autoScale;

      const center = Number(saved.fixedCenter);
      if (Number.isFinite(center)) CONFIG.fixedCenter = center;

      CONFIG.fixedSpan = clampNumber(saved.fixedSpan, 1, 1000000, CONFIG.fixedSpan);
    } catch (_) {
      // Ignore invalid browser storage.
    }
  }

  function syncDisplayControlsFromConfig() {
    ui.sampleRateControl.value = String(CONFIG.sampleRateHz);
    ui.windowSecondsControl.value = String(CONFIG.windowSeconds);
    ui.autoScaleControl.checked = CONFIG.autoScale;
    ui.fixedCenterControl.value = String(CONFIG.fixedCenter);
    ui.fixedSpanControl.value = String(CONFIG.fixedSpan);
    updateFixedScaleState();
  }

  function updateFixedScaleState() {
    const disabled = CONFIG.autoScale;

    ui.fixedCenterControl.disabled = disabled;
    ui.fixedSpanControl.disabled = disabled;

    ui.fixedCenterSetting.classList.toggle("disabled", disabled);
    ui.fixedSpanSetting.classList.toggle("disabled", disabled);
  }

  function trimSampleBuffer() {
    const limit = maxBufferSamples();
    if (samples.length > limit) {
      samples.splice(0, samples.length - limit);
    }
    ui.bufferSize.textContent = samples.length.toLocaleString("en-US");
  }

  function isProbablyAscii(bytes) {
    if (!bytes.length) return false;
    let printable = 0;

    for (const b of bytes) {
      if ((b >= 32 && b <= 126) || b === 10 || b === 13 || b === 9) {
        printable++;
      }
    }

    return printable / bytes.length > 0.88;
  }

  function parseData(dataView, mode) {
    const bytes = new Uint8Array(
      dataView.buffer,
      dataView.byteOffset,
      dataView.byteLength
    );

    let actualMode = mode;

    if (actualMode === "AUTO") {
      if (isProbablyAscii(bytes)) actualMode = "ASCII";
      else if (dataView.byteLength % 2 === 0) actualMode = "UINT16_LE";
      else actualMode = "UINT8";
    }

    const out = [];

    if (actualMode === "ASCII") {
      const text = new TextDecoder().decode(bytes);

      for (const part of text.trim().split(/[\s,;|]+/)) {
        if (!part) continue;
        const n = Number(part);
        if (Number.isFinite(n)) out.push(n);
      }
    } else if (actualMode === "UINT8") {
      for (let i = 0; i < dataView.byteLength; i++) {
        out.push(dataView.getUint8(i));
      }
    } else if (actualMode === "UINT16_LE") {
      for (let i = 0; i + 1 < dataView.byteLength; i += 2) {
        out.push(dataView.getUint16(i, true));
      }
    } else if (actualMode === "INT16_LE") {
      for (let i = 0; i + 1 < dataView.byteLength; i += 2) {
        out.push(dataView.getInt16(i, true));
      }
    } else if (actualMode === "FLOAT32_LE") {
      for (let i = 0; i + 3 < dataView.byteLength; i += 4) {
        const n = dataView.getFloat32(i, true);
        if (Number.isFinite(n)) out.push(n);
      }
    }

    return out;
  }

  function formatValue(n) {
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 100) return Math.round(n).toString();
    return n.toFixed(3);
  }

  function addSamples(newSamples) {
    if (!newSamples.length) return;

    const limit = maxBufferSamples();

    for (const value of newSamples) {
      if (!Number.isFinite(value)) continue;

      samples.push(value);
      totalSamples++;

      processHeartRateSample(value);

      if (recording) {
        recorded.push({
          index: totalSamples,
          t_ms: performance.now() - recordStart,
          value
        });
      }
    }

    if (samples.length > limit) {
      samples.splice(0, samples.length - limit);
    }

    ui.lastValue.textContent = formatValue(samples[samples.length - 1]);
    ui.sampleCount.textContent = totalSamples.toLocaleString("en-US");
    ui.bufferSize.textContent = samples.length.toLocaleString("en-US");
    ui.emptyHint.style.display = samples.length ? "none" : "grid";
    ui.printBtn.disabled = samples.length < 2;

    updateStats();
  }

  function updateStats() {
    if (!samples.length) {
      ui.minValue.textContent = "—";
      ui.maxValue.textContent = "—";
      updateHeartRateTimeout();
      return;
    }

    let min = Infinity;
    let max = -Infinity;

    for (const v of samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }

    ui.minValue.textContent = formatValue(min);
    ui.maxValue.textContent = formatValue(max);

    const now = performance.now();
    const elapsed = (now - lastRateTime) / 1000;

    if (elapsed >= 1) {
      const rxRate = (totalSamples - samplesAtLastRate) / elapsed;
      samplesAtLastRate = totalSamples;
      lastRateTime = now;
      ui.rxRate.textContent = `${rxRate.toFixed(0)} Hz`;
    }

    updateHeartRateTimeout();
  }

  function handleCharacteristicValueChanged(event) {
    packets++;
    ui.packetCount.textContent = packets.toLocaleString("en-US");
    addSamples(parseData(event.target.value, CONFIG.dataFormat));
  }

  async function connectBle() {
    if (!window.isSecureContext) {
      setMessage(
        "اتصال Bluetooth در این آدرس در دسترس نیست. برنامه را از localhost یا نسخه HTTPS اجرا کنید.",
        "error"
      );
      return;
    }

    if (!navigator.bluetooth) {
      setMessage(
        "مرورگر فعلی از اتصال Bluetooth این برنامه پشتیبانی نمی‌کند.",
        "error"
      );
      return;
    }

    stopDemo();
    resetHeartRateDetector();
    setConnectionState("connecting", "در حال اتصال...");
    ui.connectBtn.disabled = true;
    setMessage("دستگاه Cardioa را از پنجره Bluetooth انتخاب کنید.", "info");

    try {
      bluetoothDevice = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [CONFIG.serviceUuid]
      });

      bluetoothDevice.addEventListener(
        "gattserverdisconnected",
        handleDisconnected
      );

      gattServer = await bluetoothDevice.gatt.connect();

      const service = await gattServer.getPrimaryService(CONFIG.serviceUuid);
      ecgCharacteristic = await service.getCharacteristic(
        CONFIG.characteristicUuid
      );

      const props = ecgCharacteristic.properties || {};

      if (!props.notify && !props.indicate) {
        throw new Error(
          "ECG characteristic does not support notify/indicate"
        );
      }

      ecgCharacteristic.addEventListener(
        "characteristicvaluechanged",
        handleCharacteristicValueChanged
      );

      await ecgCharacteristic.startNotifications();

      ui.deviceName.textContent =
        bluetoothDevice.name || "Cardioa Device";

      ui.disconnectBtn.disabled = false;
      setConnectionState("online", "متصل");
      setMessage("اتصال برقرار شد. در انتظار دریافت ECG...", "success");
    } catch (err) {
      console.error(err);
      cleanupBle(false);
      setConnectionState("offline", "قطع");
      setMessage(humanizeBleError(err), "error");
    } finally {
      ui.connectBtn.disabled = false;
    }
  }

  function humanizeBleError(err) {
    const name = err?.name || "";
    const msg = err?.message || String(err);

    if (name === "NotFoundError") {
      return "دستگاهی انتخاب نشد یا دستگاه سازگار پیدا نشد.";
    }

    if (name === "SecurityError") {
      return "مرورگر اجازه دسترسی به Bluetooth را نداد.";
    }

    if (/service/i.test(msg)) {
      return "سرویس ارتباطی دستگاه پیدا نشد. Firmware را بررسی کنید.";
    }

    if (/characteristic/i.test(msg)) {
      return "کانال دریافت ECG پیدا نشد. Firmware را بررسی کنید.";
    }

    if (/GATT/i.test(msg)) {
      return "اتصال Bluetooth با خطای GATT روبه‌رو شد. یک‌بار دستگاه را خاموش و روشن کنید.";
    }

    return `اتصال انجام نشد: ${msg}`;
  }

  function handleDisconnected() {
    cleanupBle(false);
    resetHeartRateDetector();
    setConnectionState("offline", "قطع");
    setMessage("ارتباط با دستگاه قطع شد.", "warning");
  }

  function cleanupBle(disconnectGatt = true) {
    try {
      ecgCharacteristic?.removeEventListener(
        "characteristicvaluechanged",
        handleCharacteristicValueChanged
      );
    } catch (_) {}

    try {
      if (disconnectGatt && bluetoothDevice?.gatt?.connected) {
        bluetoothDevice.gatt.disconnect();
      }
    } catch (_) {}

    ecgCharacteristic = null;
    gattServer = null;
    bluetoothDevice = null;
    ui.disconnectBtn.disabled = true;
    ui.deviceName.textContent = "—";
  }

  function disconnectBle() {
    cleanupBle(true);
    resetHeartRateDetector();
    setConnectionState("offline", "قطع");
    setMessage("اتصال با دستگاه قطع شد.", "info");
  }

  function clearData() {
    samples = [];
    totalSamples = 0;
    packets = 0;
    samplesAtLastRate = 0;
    lastRateTime = performance.now();

    resetHeartRateDetector();

    ui.lastValue.textContent = "—";
    ui.sampleCount.textContent = "0";
    ui.packetCount.textContent = "0";
    ui.rxRate.textContent = "0 Hz";
    ui.minValue.textContent = "—";
    ui.maxValue.textContent = "—";
    ui.bufferSize.textContent = "0";
    ui.emptyHint.style.display = "grid";
    ui.printBtn.disabled = true;
  }

  function syntheticEcg(phase) {
    const gauss = (x, mu, sigma, amp) =>
      amp * Math.exp(-0.5 * Math.pow((x - mu) / sigma, 2));

    return (
      gauss(phase, 0.18, 0.025, 0.12) +
      gauss(phase, 0.37, 0.012, -0.18) +
      gauss(phase, 0.40, 0.010, 1) +
      gauss(phase, 0.43, 0.014, -0.30) +
      gauss(phase, 0.66, 0.055, 0.28) +
      0.015 * Math.sin(phase * Math.PI * 2)
    );
  }

  function startDemo() {
    if (demoTimer) {
      stopDemo();
      setMessage("");
      return;
    }

    if (bluetoothDevice?.gatt?.connected) {
      disconnectBle();
    }

    resetHeartRateDetector();

    ui.demoBtn.textContent = "توقف تست";
    ui.deviceName.textContent = "ECG Simulator";
    setConnectionState("online", "Demo");
    setMessage("حالت تست نمودار فعال است. Heart Rate آزمایشی حدود 72 BPM است.", "success");

    const fs = currentSampleRate();
    const periodMs = 1000 / fs;
    const beatSeconds = 60 / 72;

    demoNextTime = performance.now();
    demoIndex = 0;

    const tick = () => {
      if (!demoTimer) return;

      const now = performance.now();
      const chunk = [];

      while (demoNextTime <= now + 12) {
        const t = demoIndex / fs;
        const phase = (t % beatSeconds) / beatSeconds;

        chunk.push(
          2048 +
          syntheticEcg(phase) * 900 +
          (Math.random() - 0.5) * 12
        );

        demoIndex++;
        demoNextTime += periodMs;

        if (chunk.length > 100) break;
      }

      if (chunk.length) {
        packets++;
        ui.packetCount.textContent = packets.toLocaleString("en-US");
        addSamples(chunk);
      }

      demoTimer = requestAnimationFrame(tick);
    };

    demoTimer = requestAnimationFrame(tick);
  }

  function stopDemo() {
    if (!demoTimer) return;

    cancelAnimationFrame(demoTimer);
    demoTimer = null;

    ui.demoBtn.textContent = "تست نمودار";

    if (!bluetoothDevice?.gatt?.connected) {
      ui.deviceName.textContent = "—";
      setConnectionState("offline", "قطع");
    }
  }

  function restartDemoIfRunning() {
    if (!demoTimer) return;
    stopDemo();
    startDemo();
  }

  function toggleRecording() {
    if (!recording) {
      recorded = [];
      recordStart = performance.now();
      recording = true;

      ui.recordBtn.textContent = "توقف ضبط";
      ui.recordState.textContent = "روشن";
      ui.exportBtn.disabled = true;

      setMessage("ضبط سیگنال شروع شد.", "success");
    } else {
      recording = false;

      ui.recordBtn.textContent = "شروع ضبط";
      ui.recordState.textContent = "متوقف";
      ui.exportBtn.disabled = recorded.length === 0;

      setMessage(
        `${recorded.length.toLocaleString("en-US")} Sample برای خروجی آماده است.`,
        "info"
      );
    }
  }

  function exportCsv() {
    if (!recorded.length) return;

    const lines = ["sample_index,time_ms,value"];

    for (const row of recorded) {
      lines.push(
        `${row.index},${row.t_ms.toFixed(3)},${row.value}`
      );
    }

    const blob = new Blob(
      [lines.join("\n")],
      { type: "text/csv;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download =
      `cardioa-ecg-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getDisplayRange(data) {
    if (!data.length) {
      return {
        min: CONFIG.fixedCenter - CONFIG.fixedSpan,
        max: CONFIG.fixedCenter + CONFIG.fixedSpan
      };
    }

    if (!CONFIG.autoScale) {
      return {
        min: CONFIG.fixedCenter - CONFIG.fixedSpan,
        max: CONFIG.fixedCenter + CONFIG.fixedSpan
      };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const value of data) {
      if (value < min) min = value;
      if (value > max) max = value;
    }

    let span = max - min;

    if (!Number.isFinite(span) || span < 1e-9) {
      span = 1;
    }

    const pad = span * 0.18;

    return {
      min: min - pad,
      max: max + pad
    };
  }

  function createPrintImage() {
    const data = samples.slice();

    if (data.length < 2) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;

    const c = canvas.getContext("2d");

    // White page for cleaner physical printing.
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, canvas.width, canvas.height);

    c.fillStyle = "#0b1711";
    c.font = "700 54px Segoe UI, Arial, sans-serif";
    c.fillText("Cardioa", 80, 82);

    c.fillStyle = "#49806a";
    c.font = "24px Segoe UI, Arial, sans-serif";
    c.fillText("Single-channel ECG", 80, 120);

    c.textAlign = "right";
    c.fillStyle = "#16251e";
    c.font = "700 28px Segoe UI, Arial, sans-serif";
    c.fillText(
      hrState.bpm ? `Heart Rate: ${hrState.bpm} BPM` : "Heart Rate: —",
      1520,
      74
    );

    c.fillStyle = "#5d6e65";
    c.font = "20px Segoe UI, Arial, sans-serif";
    c.fillText(
      `${CONFIG.sampleRateHz} Hz   |   ${CONFIG.windowSeconds} s   |   ${new Date().toLocaleString()}`,
      1520,
      112
    );

    c.textAlign = "left";

    const chart = {
      x: 70,
      y: 160,
      width: 1460,
      height: 650
    };

    c.fillStyle = "#fbfffc";
    c.fillRect(chart.x, chart.y, chart.width, chart.height);

    // Printable ECG-style grid.
    const minor = 16;
    const major = 80;

    c.lineWidth = 1;
    c.strokeStyle = "rgba(104, 239, 173, .14)";
    c.beginPath();

    for (let x = chart.x; x <= chart.x + chart.width; x += minor) {
      c.moveTo(x, chart.y);
      c.lineTo(x, chart.y + chart.height);
    }

    for (let y = chart.y; y <= chart.y + chart.height; y += minor) {
      c.moveTo(chart.x, y);
      c.lineTo(chart.x + chart.width, y);
    }

    c.stroke();

    c.strokeStyle = "rgba(40, 130, 88, .28)";
    c.beginPath();

    for (let x = chart.x; x <= chart.x + chart.width; x += major) {
      c.moveTo(x, chart.y);
      c.lineTo(x, chart.y + chart.height);
    }

    for (let y = chart.y; y <= chart.y + chart.height; y += major) {
      c.moveTo(chart.x, y);
      c.lineTo(chart.x + chart.width, y);
    }

    c.stroke();

    const { min, max } = getDisplayRange(data);
    const range = Math.max(1e-12, max - min);

    c.strokeStyle = "#087a49";
    c.lineWidth = 3;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();

    const denominator = Math.max(1, data.length - 1);

    for (let i = 0; i < data.length; i++) {
      const x = chart.x + (i / denominator) * chart.width;
      const normalized = (data[i] - min) / range;
      const y = chart.y + chart.height - normalized * chart.height;

      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }

    c.stroke();

    c.strokeStyle = "#c7d8cf";
    c.lineWidth = 2;
    c.strokeRect(chart.x, chart.y, chart.width, chart.height);

    c.fillStyle = "#60736a";
    c.font = "18px Segoe UI, Arial, sans-serif";
    c.fillText(
      "Cardioa ECG snapshot — estimated heart rate; not intended for medical diagnosis.",
      80,
      858
    );

    return canvas.toDataURL("image/png");
  }

  function printEcg() {
    const imageUrl = createPrintImage();

    if (!imageUrl) {
      setMessage("برای پرینت ابتدا باید سیگنال روی نمودار وجود داشته باشد.", "warning");
      return;
    }

    const printWindow = window.open(
      "",
      "_blank",
      "width=1200,height=850"
    );

    if (!printWindow) {
      setMessage(
        "مرورگر پنجره پرینت را مسدود کرد. Pop-up را برای این سایت مجاز کنید.",
        "warning"
      );
      return;
    }

    printWindow.document.open();
    printWindow.document.write(`
<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<title>Cardioa ECG Print</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    font-family: Arial, sans-serif;
  }
  .page {
    width: 100%;
    padding: 16px;
    box-sizing: border-box;
  }
  img {
    display: block;
    width: 100%;
    height: auto;
  }
  @page {
    size: landscape;
    margin: 8mm;
  }
  @media print {
    .page { padding: 0; }
  }
</style>
</head>
<body>
  <div class="page">
    <img id="ecgPrintImage" src="${imageUrl}" alt="Cardioa ECG">
  </div>
</body>
</html>
    `);
    printWindow.document.close();

    const image = printWindow.document.getElementById("ecgPrintImage");

    image.addEventListener("load", () => {
      setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 180);
    });
  }

  function resizeCanvas() {
    const rect = ui.canvas.getBoundingClientRect();
    const dpr = Math.max(
      1,
      Math.min(2, window.devicePixelRatio || 1)
    );

    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (ui.canvas.width !== w || ui.canvas.height !== h) {
      ui.canvas.width = w;
      ui.canvas.height = h;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return {
      width: rect.width,
      height: rect.height
    };
  }

  function drawGrid(width, height) {
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);

    const minor = 10;
    const major = 50;

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(104,239,173,.035)";
    ctx.beginPath();

    for (let x = 0; x <= width; x += minor) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }

    for (let y = 0; y <= height; y += minor) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }

    ctx.stroke();

    ctx.strokeStyle = "rgba(104,239,173,.105)";
    ctx.beginPath();

    for (let x = 0; x <= width; x += major) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }

    for (let y = 0; y <= height; y += major) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }

    ctx.stroke();
  }

  function drawWaveform(width, height) {
    if (samples.length < 2) return;

    const { min, max } = getDisplayRange(samples);
    const range = Math.max(1e-12, max - min);
    const leftPad = 4;
    const usableW = width - 8;

    ctx.strokeStyle = "#68efad";
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(104,239,173,.34)";
    ctx.shadowBlur = 5;
    ctx.beginPath();

    const denominator = Math.max(1, samples.length - 1);

    for (let i = 0; i < samples.length; i++) {
      const x = leftPad + (i / denominator) * usableW;
      const y =
        height -
        ((samples[i] - min) / range) * height;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function renderLoop() {
    const { width, height } = resizeCanvas();

    drawGrid(width, height);
    drawWaveform(width, height);

    requestAnimationFrame(renderLoop);
  }

  function bindDisplayControls() {
    ui.sampleRateControl.addEventListener("change", () => {
      const value = clampNumber(
        ui.sampleRateControl.value,
        50,
        2000,
        CONFIG.sampleRateHz
      );

      CONFIG.sampleRateHz = Math.round(value);
      ui.sampleRateControl.value = String(CONFIG.sampleRateHz);

      trimSampleBuffer();
      resetHeartRateDetector();
      saveDisplaySettings();
      restartDemoIfRunning();
    });

    ui.windowSecondsControl.addEventListener("change", () => {
      const value = clampNumber(
        ui.windowSecondsControl.value,
        2,
        30,
        CONFIG.windowSeconds
      );

      CONFIG.windowSeconds = value;
      ui.windowSecondsControl.value = String(CONFIG.windowSeconds);

      trimSampleBuffer();
      saveDisplaySettings();
    });

    ui.autoScaleControl.addEventListener("change", () => {
      CONFIG.autoScale = ui.autoScaleControl.checked;
      updateFixedScaleState();
      saveDisplaySettings();
    });

    ui.fixedCenterControl.addEventListener("change", () => {
      const value = Number(ui.fixedCenterControl.value);

      if (Number.isFinite(value)) {
        CONFIG.fixedCenter = value;
      }

      ui.fixedCenterControl.value =
        String(CONFIG.fixedCenter);

      saveDisplaySettings();
    });

    ui.fixedSpanControl.addEventListener("change", () => {
      CONFIG.fixedSpan = clampNumber(
        ui.fixedSpanControl.value,
        1,
        1000000,
        CONFIG.fixedSpan
      );

      ui.fixedSpanControl.value =
        String(CONFIG.fixedSpan);

      saveDisplaySettings();
    });
  }

  function toggleStats() {
    const willShow = ui.statsGrid.hidden;
    ui.statsGrid.hidden = !willShow;
    ui.statsToggleBtn.setAttribute("aria-pressed", String(willShow));
  }

  function bindEvents() {
    ui.connectBtn.addEventListener("click", connectBle);
    ui.disconnectBtn.addEventListener("click", disconnectBle);
    ui.demoBtn.addEventListener("click", startDemo);
    ui.statsToggleBtn.addEventListener("click", toggleStats);
    ui.clearBtn.addEventListener("click", clearData);
    ui.recordBtn.addEventListener("click", toggleRecording);
    ui.exportBtn.addEventListener("click", exportCsv);
    ui.printBtn.addEventListener("click", printEcg);

    bindDisplayControls();

    window.addEventListener("beforeunload", () => {
      try {
        if (bluetoothDevice?.gatt?.connected) {
          bluetoothDevice.gatt.disconnect();
        }
      } catch (_) {}
    });
  }

  async function init() {
    loadDisplaySettings();
    syncDisplayControlsFromConfig();
    resetHeartRateDetector();
    bindEvents();
    renderLoop();
    setMessage("");

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (_) {}
    }
  }

  init();
})();
