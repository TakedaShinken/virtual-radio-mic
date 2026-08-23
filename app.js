/**
 * Virtual Radio Mic
 * クライアントサイド Web Audio API による低遅延擬似スピーカー＆ラジオFXミキサー
 */

class AudioManager {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.sourceNode = null;
    
    // Core Nodes
    this.hpfNode = null;
    this.micGainNode = null;
    this.eqLowNode = null;
    this.eqMidNode = null;
    this.eqHighNode = null;
    this.limiterNode = null;
    this.muteGainNode = null;
    this.masterGainNode = null;
    this.analyserNode = null;

    // FX Bus Nodes
    this.dryGainNode = null;
    this.fxMixBus = null;

    // 1. Echo Nodes
    this.echoDelayNode = null;
    this.echoFeedbackNode = null;
    this.echoWetGainNode = null;

    // 2. AM Radio Nodes
    this.radioFilterNode = null;
    this.radioDistortionNode = null;
    this.radioWetGainNode = null;

    // 3. Robot Voice Nodes
    this.robotOscNode = null;
    this.robotModGainNode = null;
    this.robotWetGainNode = null;

    // 4. Studio Reverb Nodes
    this.reverbNode = null;
    this.reverbWetGainNode = null;

    // FX Active States
    this.fxState = {
      echo: false,
      radio: false,
      robot: false,
      reverb: false
    };

    this.echoDepth = 0.45; // 0.1 - 0.8
    this.isMicActive = false;
    this.selectedDeviceId = '';
    this.selectedOutputDeviceId = '';
    this.isLowCutEnabled = true;
    this.isLimiterEnabled = true;
  }

  async setOutputDevice(deviceId) {
    this.selectedOutputDeviceId = deviceId || '';
    if (!this.ctx) return;
    if (typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(this.selectedOutputDeviceId);
        console.log("AudioContext output sink set to:", this.selectedOutputDeviceId || 'default');
      } catch (err) {
        console.warn("AudioContext setSinkId failed:", err);
      }
    }
  }

  async init(deviceId = '') {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({
        latencyHint: 'interactive',
        sampleRate: 48000
      });
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.selectedDeviceId = deviceId;
    await this.setupAudioGraph();
    await this.connectMicrophone();
  }

  async setupAudioGraph() {
    if (!this.ctx) return;

    // 1. HPF (80Hz ローカットフィルター: ポップノイズ・吹かれ低減)
    this.hpfNode = this.ctx.createBiquadFilter();
    this.hpfNode.type = 'highpass';
    this.hpfNode.frequency.value = 80;
    this.hpfNode.Q.value = 0.707;

    // 2. マイク入力ゲイン (0.0 - 3.0)
    this.micGainNode = this.ctx.createGain();
    this.micGainNode.gain.value = 1.0;

    // 3. FX ミキサーバス & Dry Gain
    this.dryGainNode = this.ctx.createGain();
    this.dryGainNode.gain.value = 1.0;

    this.fxMixBus = this.ctx.createGain();
    this.fxMixBus.gain.value = 1.0;

    // --- FX 1: エコー (Echo / Delay) ---
    this.echoDelayNode = this.ctx.createDelay(1.0);
    this.echoDelayNode.delayTime.value = 0.30; // 300ms ディレイ

    this.echoFeedbackNode = this.ctx.createGain();
    this.echoFeedbackNode.gain.value = this.echoDepth;

    this.echoWetGainNode = this.ctx.createGain();
    this.echoWetGainNode.gain.value = 0.0; // 初期OFF

    // Echo feedback loop
    this.echoDelayNode.connect(this.echoFeedbackNode);
    this.echoFeedbackNode.connect(this.echoDelayNode);
    this.echoDelayNode.connect(this.echoWetGainNode);
    this.echoWetGainNode.connect(this.fxMixBus);

    // --- FX 2: AMラジオ / トランシーバー (Lo-Fi Radio) ---
    this.radioFilterNode = this.ctx.createBiquadFilter();
    this.radioFilterNode.type = 'bandpass';
    this.radioFilterNode.frequency.value = 1600;
    this.radioFilterNode.Q.value = 2.2;

    this.radioDistortionNode = this.ctx.createWaveShaper();
    this.radioDistortionNode.curve = this.createDistortionCurve(25);
    this.radioDistortionNode.oversample = '2x';

    this.radioWetGainNode = this.ctx.createGain();
    this.radioWetGainNode.gain.value = 0.0; // 初期OFF

    this.radioFilterNode.connect(this.radioDistortionNode);
    this.radioDistortionNode.connect(this.radioWetGainNode);
    this.radioWetGainNode.connect(this.fxMixBus);

    // --- FX 3: ロボットボイス (Robot Voice / Ring Modulator) ---
    this.robotOscNode = this.ctx.createOscillator();
    this.robotOscNode.type = 'sine';
    this.robotOscNode.frequency.value = 65; // 65Hz キャリア周波数
    this.robotOscNode.start();

    this.robotModGainNode = this.ctx.createGain();
    this.robotModGainNode.gain.value = 0.0; // マイク入力信号で振幅変調

    this.robotWetGainNode = this.ctx.createGain();
    this.robotWetGainNode.gain.value = 0.0; // 初期OFF

    this.robotOscNode.connect(this.robotModGainNode.gain);
    this.robotModGainNode.connect(this.robotWetGainNode);
    this.robotWetGainNode.connect(this.fxMixBus);

    // --- FX 4: スタジオ残響 (Studio Reverb) ---
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.createReverbImpulse(1.6, 2.8);

    this.reverbWetGainNode = this.ctx.createGain();
    this.reverbWetGainNode.gain.value = 0.0; // 初期OFF

    this.reverbNode.connect(this.reverbWetGainNode);
    this.reverbWetGainNode.connect(this.fxMixBus);

    // Dry Connect
    this.dryGainNode.connect(this.fxMixBus);

    // 4. 3バンド イコライザー
    this.eqLowNode = this.ctx.createBiquadFilter();
    this.eqLowNode.type = 'lowshelf';
    this.eqLowNode.frequency.value = 200;
    this.eqLowNode.gain.value = 0;

    this.eqMidNode = this.ctx.createBiquadFilter();
    this.eqMidNode.type = 'peaking';
    this.eqMidNode.frequency.value = 1500;
    this.eqMidNode.Q.value = 1.0;
    this.eqMidNode.gain.value = 0;

    this.eqHighNode = this.ctx.createBiquadFilter();
    this.eqHighNode.type = 'highshelf';
    this.eqHighNode.frequency.value = 5000;
    this.eqHighNode.gain.value = 0;

    // 5. リミッター & コンプレッサー (音割れ・スピーカー保護)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -6;
    this.limiterNode.knee.value = 10;
    this.limiterNode.ratio.value = 12;
    this.limiterNode.attack.value = 0.003;
    this.limiterNode.release.value = 0.1;

    // 6. トーク Mute Gain (クリックノイズなしのスムーズフェード)
    this.muteGainNode = this.ctx.createGain();
    this.muteGainNode.gain.value = 0.0;

    // 7. マスター音量
    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = 1.0;

    // 8. アナライザー (VUメーター)
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 512;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // 配線
    this.connectPipeline();
  }

  connectPipeline() {
    if (!this.ctx || !this.micGainNode) return;

    // MicGain -> Dry + 各FX入力
    this.micGainNode.connect(this.dryGainNode);
    this.micGainNode.connect(this.echoDelayNode);
    this.micGainNode.connect(this.radioFilterNode);
    this.micGainNode.connect(this.robotModGainNode);
    this.micGainNode.connect(this.reverbNode);

    // FXMixBus -> EQLow -> EQMid -> EQHigh
    this.fxMixBus.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);

    // EQHigh -> Limiter -> MuteGain -> MasterGain -> Destination & Analyser
    if (this.isLimiterEnabled) {
      this.eqHighNode.connect(this.limiterNode);
      this.limiterNode.connect(this.muteGainNode);
    } else {
      this.eqHighNode.connect(this.muteGainNode);
    }

    this.muteGainNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.ctx.destination);
    this.masterGainNode.connect(this.analyserNode);
  }

  async connectMicrophone() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }

    const constraints = {
      audio: {
        deviceId: this.selectedDeviceId ? { exact: this.selectedDeviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0
      }
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.sourceNode) {
        this.sourceNode.disconnect();
      }
      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      if (this.isLowCutEnabled) {
        this.sourceNode.connect(this.hpfNode);
        this.hpfNode.connect(this.micGainNode);
      } else {
        this.sourceNode.connect(this.micGainNode);
      }
    } catch (err) {
      console.error("マイク接続エラー:", err);
      throw err;
    }
  }

  setMicActive(active) {
    if (!this.ctx || !this.muteGainNode) return;
    this.isMicActive = active;
    const now = this.ctx.currentTime;
    this.muteGainNode.gain.cancelScheduledValues(now);
    if (active) {
      this.muteGainNode.gain.setValueAtTime(this.muteGainNode.gain.value, now);
      this.muteGainNode.gain.linearRampToValueAtTime(1.0, now + 0.03);
    } else {
      this.muteGainNode.gain.setValueAtTime(this.muteGainNode.gain.value, now);
      this.muteGainNode.gain.linearRampToValueAtTime(0.0, now + 0.03);
    }
  }

  setMicGain(value) {
    if (this.micGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      this.micGainNode.gain.setValueAtTime(this.micGainNode.gain.value, now);
      this.micGainNode.gain.linearRampToValueAtTime(value, now + 0.02);
    }
  }

  setMasterVolume(value) {
    if (this.masterGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGainNode.gain.setValueAtTime(this.masterGainNode.gain.value, now);
      this.masterGainNode.gain.linearRampToValueAtTime(value, now + 0.02);
    }
  }

  // --- FX トグル制御 ---
  toggleFX(fxName) {
    if (!this.ctx) return false;
    this.fxState[fxName] = !this.fxState[fxName];
    const now = this.ctx.currentTime;
    const active = this.fxState[fxName];

    switch (fxName) {
      case 'echo':
        if (this.echoWetGainNode) {
          this.echoWetGainNode.gain.linearRampToValueAtTime(active ? 0.65 : 0.0, now + 0.03);
        }
        break;

      case 'radio':
        if (this.radioWetGainNode) {
          this.radioWetGainNode.gain.linearRampToValueAtTime(active ? 1.0 : 0.0, now + 0.03);
          // AMラジオ時は原音Dryを下げてローファイ感を強調
          this.dryGainNode.gain.linearRampToValueAtTime(active ? 0.0 : 1.0, now + 0.03);
        }
        break;

      case 'robot':
        if (this.robotWetGainNode) {
          this.robotWetGainNode.gain.linearRampToValueAtTime(active ? 1.0 : 0.0, now + 0.03);
          // ロボット時は原音Dryを下げて変調音を強調
          if (!this.fxState.radio) {
            this.dryGainNode.gain.linearRampToValueAtTime(active ? 0.1 : 1.0, now + 0.03);
          }
        }
        break;

      case 'reverb':
        if (this.reverbWetGainNode) {
          this.reverbWetGainNode.gain.linearRampToValueAtTime(active ? 0.55 : 0.0, now + 0.03);
        }
        break;
    }

    return active;
  }

  setEchoDepth(depth) {
    this.echoDepth = depth;
    if (this.echoFeedbackNode && this.ctx) {
      const now = this.ctx.currentTime;
      this.echoFeedbackNode.gain.linearRampToValueAtTime(depth, now + 0.02);
    }
  }

  resetAllFX() {
    Object.keys(this.fxState).forEach(k => {
      if (this.fxState[k]) {
        this.toggleFX(k);
      }
    });
  }

  setEQ(low, mid, high) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.eqLowNode) this.eqLowNode.gain.linearRampToValueAtTime(low, now + 0.02);
    if (this.eqMidNode) this.eqMidNode.gain.linearRampToValueAtTime(mid, now + 0.02);
    if (this.eqHighNode) this.eqHighNode.gain.linearRampToValueAtTime(high, now + 0.02);
  }

  setLowCut(enabled) {
    this.isLowCutEnabled = enabled;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      if (enabled) {
        this.sourceNode.connect(this.hpfNode);
      } else {
        this.sourceNode.connect(this.micGainNode);
      }
    }
  }

  setLimiter(enabled) {
    this.isLimiterEnabled = enabled;
    if (this.eqHighNode) {
      this.eqHighNode.disconnect();
      if (enabled) {
        this.eqHighNode.connect(this.limiterNode);
        this.limiterNode.connect(this.muteGainNode);
      } else {
        this.eqHighNode.connect(this.muteGainNode);
      }
    }
  }

  createReverbImpulse(duration = 1.6, decay = 2.8) {
    if (!this.ctx) return null;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = length - i;
      const factor = Math.pow(n / length, decay);
      left[i] = (Math.random() * 2 - 1) * factor;
      right[i] = (Math.random() * 2 - 1) * factor;
    }
    return impulse;
  }

  createDistortionCurve(amount = 25) {
    const k = typeof amount === 'number' ? amount : 25;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }
}

/**
 * Web Audio API ネイティブ PCM 直接録音＆プレビュー再生
 * MediaRecorder のブラウザ非互換性を完全排除
 */
class MicChecker {
  constructor(audioManager) {
    this.audioManager = audioManager;
    this.recordedPCM = []; // Array of Float32Array
    this.recordedBuffer = null;
    this.processorNode = null;
    this.playbackSource = null;
    this.isRecording = false;
    this.isPlaying = false;
    this.recordTimer = null;
    this.onStateChange = null;
    this.onProgress = null;
  }

  async startTestRecording(durationSeconds = 3) {
    if (!this.audioManager.stream) {
      await this.audioManager.init();
    }

    const ctx = this.audioManager.ctx;
    if (!ctx) return;

    // 録音初期化
    this.recordedPCM = [];
    this.recordedBuffer = null;
    this.isRecording = true;
    if (this.onStateChange) this.onStateChange('recording');

    // ScriptProcessor による PCM キャプチャ (4096サンプルバッファ)
    this.processorNode = ctx.createScriptProcessor(4096, 1, 1);
    this.processorNode.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.recordedPCM.push(copy);
    };

    // マイクソース -> プロセッサー -> ゼロ出力 (ダミー接続)
    if (this.audioManager.sourceNode) {
      this.audioManager.sourceNode.connect(this.processorNode);
      this.processorNode.connect(ctx.destination);
    }

    // プログレスバー & タイマー
    const startTime = Date.now();
    const durationMs = durationSeconds * 1000;

    clearInterval(this.recordTimer);
    this.recordTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(100, (elapsed / durationMs) * 100);
      if (this.onProgress) this.onProgress(progress);

      if (elapsed >= durationMs) {
        clearInterval(this.recordTimer);
        this.stopRecording();
      }
    }, 40);
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearInterval(this.recordTimer);

    // プロセッサーの切断
    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
        if (this.audioManager.sourceNode) {
          this.audioManager.sourceNode.disconnect(this.processorNode);
        }
      } catch (e) {
        // ignore
      }
      this.processorNode = null;
    }

    // PCM データを AudioBuffer に変換
    const ctx = this.audioManager.ctx;
    if (ctx && this.recordedPCM.length > 0) {
      let totalLength = 0;
      this.recordedPCM.forEach(chunk => { totalLength += chunk.length; });

      this.recordedBuffer = ctx.createBuffer(1, totalLength, ctx.sampleRate);
      const channelData = this.recordedBuffer.getChannelData(0);

      let offset = 0;
      this.recordedPCM.forEach(chunk => {
        channelData.set(chunk, offset);
        offset += chunk.length;
      });
    }

    if (this.onStateChange) this.onStateChange('recorded');
  }

  playTestAudio() {
    const ctx = this.audioManager.ctx;
    if (!ctx || !this.recordedBuffer) return;

    // 既に再生中の場合は停止
    this.stopPlayTestAudio();

    this.playbackSource = ctx.createBufferSource();
    this.playbackSource.buffer = this.recordedBuffer;

    // 再生音量ゲイン
    const playGain = ctx.createGain();
    playGain.gain.value = 1.0;

    this.playbackSource.connect(playGain);
    playGain.connect(this.audioManager.masterGainNode || ctx.destination);

    this.isPlaying = true;
    if (this.onStateChange) this.onStateChange('playing');

    this.playbackSource.onended = () => {
      this.isPlaying = false;
      if (this.onStateChange) this.onStateChange('recorded');
    };

    this.playbackSource.start(0);
  }

  stopPlayTestAudio() {
    if (this.playbackSource) {
      try {
        this.playbackSource.stop();
        this.playbackSource.disconnect();
      } catch (e) {
        // ignore
      }
      this.playbackSource = null;
    }
    this.isPlaying = false;
    if (this.onStateChange) this.onStateChange('recorded');
  }
}

/**
 * Canvas VUメーター描画
 */
class Visualizer {
  constructor(canvasElement, audioManager) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.audioManager = audioManager;
    this.animationId = null;
    this.peakValue = 0;
    this.peakDecay = 0.95;
    this.dataArray = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1);
    this.canvas.height = rect.height * (window.devicePixelRatio || 1);
  }

  start() {
    if (this.animationId) return;
    this.draw();
  }

  draw() {
    this.animationId = requestAnimationFrame(() => this.draw());

    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);

    if (!this.audioManager.analyserNode || !this.audioManager.isMicActive) {
      this.peakValue *= 0.9;
      this.drawMeter(0, this.peakValue);
      const peakElem = document.getElementById('peak-indicator');
      if (peakElem) {
        peakElem.textContent = '-inf dB';
        peakElem.className = 'text-slate-400 font-mono';
      }
      return;
    }

    if (!this.dataArray) {
      this.dataArray = new Uint8Array(this.audioManager.analyserNode.frequencyBinCount);
    }

    this.audioManager.analyserNode.getByteTimeDomainData(this.dataArray);

    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const val = (this.dataArray[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / this.dataArray.length);

    const db = 20 * Math.log10(Math.max(rms, 0.0001));
    const normalized = Math.max(0, Math.min(1, (db + 48) / 48));

    if (normalized > this.peakValue) {
      this.peakValue = normalized;
    } else {
      this.peakValue = Math.max(normalized, this.peakValue * this.peakDecay);
    }

    this.drawMeter(normalized, this.peakValue);

    const peakDb = Math.round(db);
    const peakElem = document.getElementById('peak-indicator');
    if (peakElem) {
      if (peakDb >= -1) {
        peakElem.textContent = `${peakDb >= 0 ? '+' : ''}${peakDb} dB (CLIP)`;
        peakElem.className = 'text-red-600 font-bold font-mono';
      } else if (peakDb >= -6) {
        peakElem.textContent = `${peakDb} dB`;
        peakElem.className = 'text-amber-600 font-bold font-mono';
      } else {
        peakElem.textContent = `${peakDb} dB`;
        peakElem.className = 'text-slate-600 font-mono';
      }
    }
  }

  drawMeter(current, peak) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const segments = 36;
    const segWidth = (w - (segments - 1) * 2) / segments;

    for (let i = 0; i < segments; i++) {
      const segRatio = (i + 1) / segments;
      const x = i * (segWidth + 2);

      let color = '#22c55e';
      if (segRatio > 0.88) {
        color = '#ef4444';
      } else if (segRatio > 0.65) {
        color = '#f59e0b';
      }

      if (segRatio <= current) {
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, 0, segWidth, h);
      } else if (Math.abs(segRatio - peak) < 0.035 && peak > 0.05) {
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, 0, Math.max(2, segWidth), h);
      } else {
        this.ctx.fillStyle = '#e2e8f0';
        this.ctx.fillRect(x, 0, segWidth, h);
      }
    }
  }
}

/**
 * アプリケーション コントローラー
 */
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) {
    lucide.createIcons();
  }

  const audioManager = new AudioManager();
  const micChecker = new MicChecker(audioManager);
  const visualizer = new Visualizer(document.getElementById('vu-canvas'), audioManager);
  visualizer.start();

  let talkMode = 'toggle'; // 'toggle' | 'ptt'
  let isInitialized = false;

  // DOM Elements
  const mainMicBtn = document.getElementById('main-mic-btn');
  const micStatusText = document.getElementById('mic-status-text');
  const micSubText = document.getElementById('mic-sub-text');
  const micIconWrapper = document.getElementById('mic-icon-wrapper');

  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  const modePttBtn = document.getElementById('mode-ptt-btn');

  // Sliders
  const sliderMicGain = document.getElementById('slider-mic-gain');
  const valMicGain = document.getElementById('val-mic-gain');
  const sliderMasterVol = document.getElementById('slider-master-vol');
  const valMasterVol = document.getElementById('val-master-vol');

  const sliderEqLow = document.getElementById('slider-eq-low');
  const valEqLow = document.getElementById('val-eq-low');
  const sliderEqMid = document.getElementById('slider-eq-mid');
  const valEqMid = document.getElementById('val-eq-mid');
  const sliderEqHigh = document.getElementById('slider-eq-high');
  const valEqHigh = document.getElementById('val-eq-high');

  const toggleLowcut = document.getElementById('toggle-lowcut');
  const toggleLimiter = document.getElementById('toggle-limiter');
  const btnResetMixer = document.getElementById('btn-reset-mixer');

  // FX Elements
  const fxEchoBtn = document.getElementById('fx-echo-btn');
  const fxRadioBtn = document.getElementById('fx-radio-btn');
  const fxRobotBtn = document.getElementById('fx-robot-btn');
  const fxReverbBtn = document.getElementById('fx-reverb-btn');
  const btnResetFx = document.getElementById('btn-reset-fx');
  const sliderEchoDepth = document.getElementById('slider-echo-depth');
  const valEchoDepth = document.getElementById('val-echo-depth');

  // Mic Check Elements
  const btnRecordCheck = document.getElementById('btn-record-check');
  const btnRecordCheckText = document.getElementById('btn-record-check-text');
  const btnPlayCheck = document.getElementById('btn-play-check');
  const btnPlayCheckText = document.getElementById('btn-play-check-text');
  const checkStatusBadge = document.getElementById('check-status-badge');
  const checkProgressContainer = document.getElementById('check-progress-container');
  const checkProgressBar = document.getElementById('check-progress-bar');

  // Modals
  const safetyModal = document.getElementById('safety-modal');
  const btnSafetyGuide = document.getElementById('btn-safety-guide');
  const btnCloseSafety = document.getElementById('btn-close-safety');

  const deviceModal = document.getElementById('device-modal');
  const btnDeviceSettings = document.getElementById('btn-device-settings');
  const btnCloseDeviceModal = document.getElementById('btn-close-device-modal');
  const selectAudioInput = document.getElementById('select-audio-input');
  const selectAudioOutput = document.getElementById('select-audio-output');
  const btnApplyDevice = document.getElementById('btn-apply-device');

  // 初回安全モーダル
  if (!localStorage.getItem('safety_agreed')) {
    safetyModal.classList.remove('hidden');
  }

  btnCloseSafety.addEventListener('click', () => {
    localStorage.setItem('safety_agreed', 'true');
    safetyModal.classList.add('hidden');
  });

  btnSafetyGuide.addEventListener('click', () => {
    safetyModal.classList.remove('hidden');
  });

  // 初期化関数
  async function ensureAudioReady() {
    if (!isInitialized) {
      try {
        await audioManager.init();
        isInitialized = true;
        await populateAudioDevices();
      } catch (err) {
        alert("マイクの使用が許可されませんでした。ブラウザのマイク権限を許可してください。");
        throw err;
      }
    }
  }

  async function populateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      // 1. 入力マイク
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      selectAudioInput.innerHTML = '<option value="">規定のマイク (Default)</option>';
      audioInputs.forEach((device, idx) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `マイク ${idx + 1}`;
        if (device.deviceId === audioManager.selectedDeviceId) {
          option.selected = true;
        }
        selectAudioInput.appendChild(option);
      });

      // 2. 出力スピーカー / イヤホン
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
      selectAudioOutput.innerHTML = '<option value="">規定のスピーカー (Default)</option>';
      audioOutputs.forEach((device, idx) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `スピーカー ${idx + 1}`;
        if (device.deviceId === audioManager.selectedOutputDeviceId) {
          option.selected = true;
        }
        selectAudioOutput.appendChild(option);
      });
    } catch (e) {
      console.warn("デバイス一覧取得失敗", e);
    }
  }

  btnDeviceSettings.addEventListener('click', async () => {
    await ensureAudioReady();
    await populateAudioDevices();
    deviceModal.classList.remove('hidden');
  });

  btnCloseDeviceModal.addEventListener('click', () => {
    deviceModal.classList.add('hidden');
  });

  btnApplyDevice.addEventListener('click', async () => {
    const inId = selectAudioInput.value;
    const outId = selectAudioOutput.value;
    await audioManager.init(inId);
    await audioManager.setOutputDevice(outId);
    deviceModal.classList.add('hidden');
  });

  // トークモード切り替え
  modeToggleBtn.addEventListener('click', () => {
    talkMode = 'toggle';
    modeToggleBtn.className = 'px-3 py-1 rounded-lg text-xs font-bold transition-all bg-white text-slate-800 shadow-sm';
    modePttBtn.className = 'px-3 py-1 rounded-lg text-xs font-medium text-slate-600 transition-all hover:text-slate-900';
    updateMicButtonUI(audioManager.isMicActive);
  });

  modePttBtn.addEventListener('click', () => {
    talkMode = 'ptt';
    modePttBtn.className = 'px-3 py-1 rounded-lg text-xs font-bold transition-all bg-white text-slate-800 shadow-sm';
    modeToggleBtn.className = 'px-3 py-1 rounded-lg text-xs font-medium text-slate-600 transition-all hover:text-slate-900';
    if (audioManager.isMicActive) {
      audioManager.setMicActive(false);
    }
    updateMicButtonUI(false);
  });

  function updateMicButtonUI(active) {
    if (active) {
      if (talkMode === 'ptt') {
        mainMicBtn.className = 'w-48 h-48 sm:w-56 sm:h-56 rounded-full border-4 flex flex-col items-center justify-center gap-2 transition-all duration-100 transform scale-102 shadow-lg ptt-active cursor-pointer';
        micStatusText.textContent = 'TALKING (PTT)';
        micSubText.textContent = '離すとミュート';
        micIconWrapper.innerHTML = '<i data-lucide="mic" class="w-8 h-8 sm:w-10 sm:h-10 text-white"></i>';
      } else {
        mainMicBtn.className = 'w-48 h-48 sm:w-56 sm:h-56 rounded-full border-4 flex flex-col items-center justify-center gap-2 transition-all duration-150 transform scale-102 shadow-lg active cursor-pointer';
        micStatusText.textContent = 'ON AIR';
        micSubText.textContent = 'タップでミュート';
        micIconWrapper.innerHTML = '<i data-lucide="mic" class="w-8 h-8 sm:w-10 sm:h-10 text-white"></i>';
      }
    } else {
      mainMicBtn.className = 'w-48 h-48 sm:w-56 sm:h-56 rounded-full border-4 flex flex-col items-center justify-center gap-2 transition-all duration-150 transform active:scale-95 shadow-md bg-slate-100 border-slate-300 text-slate-400 cursor-pointer';
      micStatusText.textContent = 'STANDBY';
      micSubText.textContent = talkMode === 'ptt' ? '長押しで発声 (PTT)' : 'タップしてマイク開始';
      micIconWrapper.innerHTML = '<i data-lucide="mic-off" class="w-8 h-8 sm:w-10 sm:h-10 text-slate-500"></i>';
    }
    if (window.lucide) {
      lucide.createIcons();
    }
  }

  // メインマイクボタン操作
  mainMicBtn.addEventListener('click', async () => {
    if (talkMode !== 'toggle') return;
    await ensureAudioReady();
    const nextState = !audioManager.isMicActive;
    audioManager.setMicActive(nextState);
    updateMicButtonUI(nextState);
  });

  const startPtt = async (e) => {
    if (talkMode !== 'ptt') return;
    e.preventDefault();
    await ensureAudioReady();
    audioManager.setMicActive(true);
    updateMicButtonUI(true);
  };

  const stopPtt = (e) => {
    if (talkMode !== 'ptt') return;
    e.preventDefault();
    if (audioManager.isMicActive) {
      audioManager.setMicActive(false);
      updateMicButtonUI(false);
    }
  };

  mainMicBtn.addEventListener('pointerdown', startPtt);
  window.addEventListener('pointerup', stopPtt);
  window.addEventListener('pointercancel', stopPtt);

  // --- FX ボタンイベント ---
  const bindFXButton = (btn, fxName) => {
    btn.addEventListener('click', async () => {
      await ensureAudioReady();
      const isActive = audioManager.toggleFX(fxName);
      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  };

  bindFXButton(fxEchoBtn, 'echo');
  bindFXButton(fxRadioBtn, 'radio');
  bindFXButton(fxRobotBtn, 'robot');
  bindFXButton(fxReverbBtn, 'reverb');

  btnResetFx.addEventListener('click', () => {
    audioManager.resetAllFX();
    [fxEchoBtn, fxRadioBtn, fxRobotBtn, fxReverbBtn].forEach(btn => btn.classList.remove('active'));
  });

  sliderEchoDepth.addEventListener('input', () => {
    const val = parseInt(sliderEchoDepth.value);
    valEchoDepth.textContent = `${val}%`;
    audioManager.setEchoDepth(val / 100);
  });

  // スライダーイベント
  sliderMicGain.addEventListener('input', () => {
    const val = parseInt(sliderMicGain.value);
    const dbVal = val > 0 ? Math.round(20 * Math.log10(val / 100)) : -Infinity;
    valMicGain.textContent = `${val}% (${dbVal >= 0 ? '+' : ''}${dbVal === -Infinity ? '-inf' : dbVal}dB)`;
    audioManager.setMicGain(val / 100);
  });

  sliderMasterVol.addEventListener('input', () => {
    const val = parseInt(sliderMasterVol.value);
    valMasterVol.textContent = `${val}%`;
    audioManager.setMasterVolume(val / 100);
  });

  function updateEQ() {
    const low = parseFloat(sliderEqLow.value);
    const mid = parseFloat(sliderEqMid.value);
    const high = parseFloat(sliderEqHigh.value);
    valEqLow.textContent = `${low >= 0 ? '+' : ''}${low}dB`;
    valEqMid.textContent = `${mid >= 0 ? '+' : ''}${mid}dB`;
    valEqHigh.textContent = `${high >= 0 ? '+' : ''}${high}dB`;
    audioManager.setEQ(low, mid, high);
  }

  sliderEqLow.addEventListener('input', updateEQ);
  sliderEqMid.addEventListener('input', updateEQ);
  sliderEqHigh.addEventListener('input', updateEQ);

  toggleLowcut.addEventListener('change', () => {
    audioManager.setLowCut(toggleLowcut.checked);
  });

  toggleLimiter.addEventListener('change', () => {
    audioManager.setLimiter(toggleLimiter.checked);
  });

  btnResetMixer.addEventListener('click', () => {
    sliderMicGain.value = 100;
    valMicGain.textContent = '100% (+0dB)';
    audioManager.setMicGain(1.0);

    sliderMasterVol.value = 100;
    valMasterVol.textContent = '100%';
    audioManager.setMasterVolume(1.0);

    sliderEqLow.value = 0;
    sliderEqMid.value = 0;
    sliderEqHigh.value = 0;
    updateEQ();

    toggleLowcut.checked = true;
    audioManager.setLowCut(true);

    toggleLimiter.checked = true;
    audioManager.setLimiter(true);
  });

  // マイクチェック機能
  btnRecordCheck.addEventListener('click', async () => {
    await ensureAudioReady();
    if (micChecker.isRecording) {
      micChecker.stopRecording();
    } else {
      checkProgressContainer.classList.remove('hidden');
      checkProgressBar.style.width = '0%';
      micChecker.startTestRecording(3);
    }
  });

  btnPlayCheck.addEventListener('click', () => {
    if (micChecker.isPlaying) {
      micChecker.stopPlayTestAudio();
    } else {
      micChecker.playTestAudio();
    }
  });

  micChecker.onStateChange = (state) => {
    if (state === 'recording') {
      btnRecordCheck.classList.add('bg-red-50', 'border-red-200', 'text-red-700');
      btnRecordCheckText.textContent = '録音中 (発声してください)...';
      checkStatusBadge.textContent = '録音中';
      checkStatusBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold recording-pulse';
      btnPlayCheck.disabled = true;
    } else if (state === 'recorded') {
      btnRecordCheck.classList.remove('bg-red-50', 'border-red-200', 'text-red-700');
      btnRecordCheckText.textContent = '再録音 (3秒)';
      checkStatusBadge.textContent = '録音完了';
      checkStatusBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold';
      btnPlayCheck.disabled = false;
      btnPlayCheck.className = 'py-3 px-4 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-sm flex items-center justify-center gap-2 transition-colors active:scale-98 cursor-pointer';
      btnPlayCheckText.textContent = 'テスト再生';
      checkProgressContainer.classList.add('hidden');
    } else if (state === 'playing') {
      btnPlayCheckText.textContent = '停止';
      checkStatusBadge.textContent = '再生中...';
      checkStatusBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold';
    }
  };

  micChecker.onProgress = (progress) => {
    checkProgressBar.style.width = `${progress}%`;
  };

  // Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.log('ServiceWorker registration skipped:', err);
      });
    });
  }
});
