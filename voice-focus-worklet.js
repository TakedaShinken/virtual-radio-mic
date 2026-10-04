/**
 * Voice Focus AudioWorklet
 * 低性能端末の全指向性マイク向け 軽量ボイスクリーンアップ
 *
 *  1. 適応ノイズゲート
 *     直近 3 秒の最小レベルからノイズフロアを自動推定し、話していない間の環境音を下げる。
 *     端末ごとのマイク感度差があっても手動調整なしで動く。
 *  2. 残響テール抑制 (2 バンド・減衰加速エキスパンダー)
 *     レベルが減衰し続けている区間 (= 部屋の響き) だけを、直前のピークからの落差に比例して
 *     追加で減衰させ、響きの尾を短くする。定常的な母音・立ち上がり・小さめの次の音節には作用しない。
 *     低域 (～1.2kHz) の響きは後続の子音を覆い隠すので強めに、子音のある高域はごく控えめに処理する。
 *     乾いた声では音節の谷が深くなるが、これは会場の残響で谷が埋まる分を前もって補う効果になる。
 *
 * 負荷: 1 サンプルあたり四則演算数十回。log / pow は 16 サンプルごとの制御レートでのみ計算。
 * 遅延: 0 (先読みなし)。
 */

const CONTROL_INTERVAL = 16;      // 制御レート (サンプル)
const CROSSOVER_HZ = 1200;        // 低域 / 高域の分割周波数
const FLOOR_SUBWINDOW_SEC = 0.25; // ノイズフロア最小値追跡のサブ窓
const FLOOR_SUBWINDOWS = 12;      // サブ窓数 (= 3 秒窓。息継ぎ程度の間があれば正しく追従する)
const FLOOR_INITIAL_DB = -60;
const FLOOR_RISE_SEC = 0.4;       // ノイズフロアが上がる時の追従時定数 (下がる時は即時)
const WARMUP_SEC = 0.1;           // 起動直後はエンベロープが立ち上がり中なのでフロア推定に使わない
const SILENCE_DB = -90;           // デジタル無音は「雑音レベル」として扱わない
const THRESHOLD_MIN_DB = -66;
const THRESHOLD_MAX_DB = -30;     // これ以上うるさい環境ではゲートを開いたままにする
const HYSTERESIS_DB = 3;
const GATE_ATTACK_MS = 3;         // ゲートが開く速さ
const DETECT_ATTACK_SEC = 0.005;  // ゲート検出エンベロープ (雑音のピークで揺れにくく、声の立ち上がりには十分速い)
const DETECT_RELEASE_SEC = 0.040;
const BAND_ATTACK_SEC = 0.002;    // 帯域エンベロープ: 立ち上がりは速く (子音・音節の頭を潰さない)
const PEAK_DECAY_LOW_DB_PER_SEC = 20;
const PEAK_DECAY_HIGH_DB_PER_SEC = 25;
const DECAY_WINDOW_SEC = 0.04;    // 「減衰中」の判定窓: この間に DECAY_DETECT_DB 以上下がっていれば響きの尾とみなす
const DECAY_DETECT_DB = 0.8;      // = 20 dB/s (母音のゆるい揺らぎより速く、部屋の残響より遅い)
const PEAK_RELAX_SEC = 0.04;      // 減衰していない時は基準ピークを現在レベルへ素早く戻す (小さい音節を巻き込まない)
const METER_INTERVAL_SEC = 0.12;

const DEFAULT_CONFIG = { // = app.js の「標準」
  margin: 9,
  gateRange: 18,
  holdMs: 150,
  releaseMs: 120,
  lowSlope: 3.0,
  lowFloor: -14,
  highSlope: 0.4,
  highFloor: -3,
  tailDeadband: 1.5, // ピークからこの落差までは抑制しない (母音の揺らぎ対策)
  bandReleaseMs: 15  // 帯域エンベロープの減衰側の平滑化 (残響の細かな揺れでゲインが暴れないように)
};

function onePoleCoef(seconds) {
  return 1 - Math.exp(-1 / (seconds * sampleRate));
}

class VoiceFocusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dtc = CONTROL_INTERVAL / sampleRate;

    // 2次バターワース LPF (RBJ) — high = x - low の相補分割なので両バンドの和は原音に一致する
    const w0 = (2 * Math.PI * CROSSOVER_HZ) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw) / 2) / a0;
    this.b1 = (1 - cosw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;

    this.gateAtkCoef = onePoleCoef(DETECT_ATTACK_SEC);
    this.gateRelCoef = onePoleCoef(DETECT_RELEASE_SEC);
    this.bandAtkCoef = onePoleCoef(BAND_ATTACK_SEC);
    this.floorRiseCoef = 1 - Math.exp(-this.dtc / FLOOR_RISE_SEC);

    this.relaxCoef = 1 - Math.exp(-this.dtc / PEAK_RELAX_SEC);
    this.decayLen = Math.max(1, Math.round(DECAY_WINDOW_SEC / this.dtc));

    this.subLen = Math.max(1, Math.round(FLOOR_SUBWINDOW_SEC / this.dtc));
    this.warmupLen = Math.max(1, Math.round(WARMUP_SEC / this.dtc));
    this.meterLen = Math.max(1, Math.round(METER_INTERVAL_SEC / this.dtc));

    this.config = Object.assign({}, DEFAULT_CONFIG);
    this.applyConfig((options && options.processorOptions && options.processorOptions.config) || {});
    this.resetState();

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'config') {
        this.applyConfig(msg.config || {});
        if (msg.reset) this.resetState();
      }
    };
  }

  applyConfig(cfg) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (typeof cfg[key] === 'number' && isFinite(cfg[key])) {
        this.config[key] = cfg[key];
      }
    }
    const c = this.config;
    this.holdTicks = Math.max(0, Math.round((c.holdMs / 1000) / this.dtc));
    this.gateOpenStep = (c.gateRange / (GATE_ATTACK_MS / 1000)) * this.dtc;
    this.gateCloseStep = (c.gateRange / Math.max(0.005, c.releaseMs / 1000)) * this.dtc;
    this.bandRelCoef = onePoleCoef(Math.max(0.002, c.bandReleaseMs / 1000));
  }

  resetState() {
    this.z1 = 0;
    this.z2 = 0;
    this.envGate = 0;
    this.envLow = 0;
    this.envHigh = 0;
    this.tick = 0;

    this.noiseFloor = FLOOR_INITIAL_DB;
    this.warmup = this.warmupLen;
    this.curMin = 0;
    this.ringMin = 0;
    this.minRing = new Float32Array(FLOOR_SUBWINDOWS); // 0 dB = 未観測
    this.ringIdx = 0;
    this.subCount = 0;

    this.isOpen = false;
    this.holdCount = 0;
    this.gateDb = 0;
    this.peakLow = -120;
    this.peakHigh = -120;
    this.histLow = new Float32Array(this.decayLen).fill(-120);
    this.histHigh = new Float32Array(this.decayLen).fill(-120);
    this.histIdx = 0;

    this.gainLow = 1;
    this.gainHigh = 1;
    this.targetLow = 1;
    this.targetHigh = 1;
    this.stepLow = 0;
    this.stepHigh = 0;
    this.meterCount = 0;
  }

  updateControl() {
    const c = this.config;
    const levelGate = 10 * Math.log10(this.envGate + 1e-12);
    const levelLow = 10 * Math.log10(this.envLow + 1e-12);
    const levelHigh = 10 * Math.log10(this.envHigh + 1e-12);

    // --- ノイズフロア推定 (サブ窓最小値のリングで 3 秒窓の最小値を追跡) ---
    if (this.warmup > 0) {
      this.warmup--;
    } else if (levelGate > SILENCE_DB && levelGate < this.curMin) {
      this.curMin = levelGate;
    }
    if (++this.subCount >= this.subLen) {
      this.minRing[this.ringIdx] = this.curMin;
      this.ringIdx = (this.ringIdx + 1) % FLOOR_SUBWINDOWS;
      let m = 0;
      for (let k = 0; k < FLOOR_SUBWINDOWS; k++) {
        if (this.minRing[k] < m) m = this.minRing[k];
      }
      this.ringMin = m;
      this.curMin = 0;
      this.subCount = 0;
    }
    const floorTarget = Math.min(this.ringMin, this.curMin);
    if (floorTarget < 0) { // 0 dB = まだ観測値なし
      if (floorTarget < this.noiseFloor) {
        this.noiseFloor = floorTarget;
      } else {
        this.noiseFloor += (floorTarget - this.noiseFloor) * this.floorRiseCoef;
      }
    }
    // デジタル無音の後でも閾値の下限付近から追従を再開できるようにする
    const floorMin = THRESHOLD_MIN_DB - c.margin;
    if (this.noiseFloor < floorMin) this.noiseFloor = floorMin;

    // --- 適応ノイズゲート (ヒステリシス + ホールド) ---
    let openThreshold = this.noiseFloor + c.margin;
    if (openThreshold < THRESHOLD_MIN_DB) openThreshold = THRESHOLD_MIN_DB;
    if (openThreshold > THRESHOLD_MAX_DB) openThreshold = THRESHOLD_MAX_DB;
    const closeThreshold = openThreshold - HYSTERESIS_DB;

    if (levelGate >= openThreshold) {
      this.isOpen = true;
      this.holdCount = this.holdTicks;
    } else if (this.isOpen) {
      if (levelGate >= closeThreshold) {
        this.holdCount = this.holdTicks;
      } else if (this.holdCount > 0) {
        this.holdCount--;
      } else {
        this.isOpen = false;
      }
    }
    const gateTarget = this.isOpen ? 0 : -c.gateRange;
    if (gateTarget > this.gateDb) {
      this.gateDb = Math.min(gateTarget, this.gateDb + this.gateOpenStep);
    } else {
      this.gateDb = Math.max(gateTarget, this.gateDb - this.gateCloseStep);
    }

    // --- 残響テール抑制: 減衰が続いている間だけ、ピークからの落差に比例して減衰を加速 ---
    const lowBefore = this.histLow[this.histIdx];
    const highBefore = this.histHigh[this.histIdx];
    this.histLow[this.histIdx] = levelLow;
    this.histHigh[this.histIdx] = levelHigh;
    this.histIdx = (this.histIdx + 1) % this.decayLen;
    this.peakLow = this.trackPeak(this.peakLow, levelLow, lowBefore - levelLow > DECAY_DETECT_DB, PEAK_DECAY_LOW_DB_PER_SEC);
    this.peakHigh = this.trackPeak(this.peakHigh, levelHigh, highBefore - levelHigh > DECAY_DETECT_DB, PEAK_DECAY_HIGH_DB_PER_SEC);
    let tailLow = c.lowSlope * (levelLow - this.peakLow + c.tailDeadband);
    let tailHigh = c.highSlope * (levelHigh - this.peakHigh + c.tailDeadband);
    if (tailLow > 0) tailLow = 0;
    if (tailLow < c.lowFloor) tailLow = c.lowFloor;
    if (tailHigh > 0) tailHigh = 0;
    if (tailHigh < c.highFloor) tailHigh = c.highFloor;

    // ゲートとテール抑制は「深い方」を採用 (足し合わせると発話後に雑音が持ち上がって聞こえるため)
    const lowDb = Math.min(this.gateDb, tailLow);
    const highDb = Math.min(this.gateDb, tailHigh);

    if (++this.meterCount >= this.meterLen) {
      this.meterCount = 0;
      this.port.postMessage({
        type: 'meter',
        open: this.isOpen,
        reductionDb: (lowDb + highDb) / 2,
        noiseFloorDb: this.noiseFloor
      });
    }

    // オーディオスレッドでの GC を避けるため配列は返さずフィールドに書く
    this.targetLow = Math.pow(10, lowDb / 20);
    this.targetHigh = Math.pow(10, highDb / 20);
  }

  trackPeak(peak, level, decaying, decayDbPerSec) {
    if (level >= peak) return level;
    if (decaying) return peak - decayDbPerSec * this.dtc;
    return peak + (level - peak) * this.relaxCoef;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const out = output && output[0];
    if (!out) return true;
    if (!input || input.length === 0 || !input[0]) {
      out.fill(0);
      return true;
    }
    const x = input[0];
    const n = out.length;

    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    const gateAtk = this.gateAtkCoef, gateRel = this.gateRelCoef;
    const bandAtk = this.bandAtkCoef, bandRel = this.bandRelCoef;
    let z1 = this.z1, z2 = this.z2;
    let envGate = this.envGate, envLow = this.envLow, envHigh = this.envHigh;
    let gL = this.gainLow, gH = this.gainHigh;
    let dgL = this.stepLow, dgH = this.stepHigh;
    let tick = this.tick;

    for (let i = 0; i < n; i++) {
      if (tick === 0) {
        this.envGate = envGate;
        this.envLow = envLow;
        this.envHigh = envHigh;
        this.updateControl();
        // 次の制御周期の間でゲインを直線補間 (ジッパーノイズ防止)
        dgL = (this.targetLow - gL) / CONTROL_INTERVAL;
        dgH = (this.targetHigh - gH) / CONTROL_INTERVAL;
      }
      if (++tick >= CONTROL_INTERVAL) tick = 0;

      const s = x[i];
      const low = b0 * s + z1;
      z1 = b1 * s - a1 * low + z2;
      z2 = b2 * s - a2 * low;
      const high = s - low;

      const p = s * s;
      envGate += (p > envGate ? gateAtk : gateRel) * (p - envGate);
      const pl = low * low;
      const ph = high * high;
      envLow += (pl > envLow ? bandAtk : bandRel) * (pl - envLow);
      envHigh += (ph > envHigh ? bandAtk : bandRel) * (ph - envHigh);

      gL += dgL;
      gH += dgH;
      out[i] = gL * low + gH * high;
    }

    // 無音が続いたときのデノーマル化を防ぐ
    if (Math.abs(z1) < 1e-20) z1 = 0;
    if (Math.abs(z2) < 1e-20) z2 = 0;
    if (envGate < 1e-30) envGate = 0;
    if (envLow < 1e-30) envLow = 0;
    if (envHigh < 1e-30) envHigh = 0;

    this.z1 = z1;
    this.z2 = z2;
    this.envGate = envGate;
    this.envLow = envLow;
    this.envHigh = envHigh;
    this.gainLow = gL;
    this.gainHigh = gH;
    this.stepLow = dgL;
    this.stepHigh = dgH;
    this.tick = tick;
    return true;
  }
}

registerProcessor('voice-focus-processor', VoiceFocusProcessor);
