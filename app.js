/**
 * Virtual Radio Mic
 * クライアントサイド Web Audio API による低遅延擬似スピーカー＆ラジオFXミキサー
 */

/**
 * 声をクリアに（全指向性マイク向け 雑音・残響カット）の強さプリセット
 * hpfHz / mudDb / lpfHz はネイティブ BiquadFilter、それ以外は voice-focus-worklet.js が使う
 *   margin / gateRange / holdMs / releaseMs: 適応ノイズゲート
 *   low* / high* / tailDeadband / bandReleaseMs: 残響テール抑制 (子音を守るため高域は控えめ)
 */
const VOICE_FOCUS_PRESETS = {
  light:    { hpfHz: 100, mudDb: -2,   lpfHz: 10000, margin: 7,  gateRange: 10, holdMs: 220, releaseMs: 160, lowSlope: 1.5, lowFloor: -8,  highSlope: 0.3, highFloor: -2, tailDeadband: 2.5, bandReleaseMs: 15 },
  standard: { hpfHz: 120, mudDb: -3,   lpfHz: 8000,  margin: 9,  gateRange: 18, holdMs: 150, releaseMs: 120, lowSlope: 3.0, lowFloor: -14, highSlope: 0.4, highFloor: -3, tailDeadband: 1.5, bandReleaseMs: 15 },
  strong:   { hpfHz: 150, mudDb: -4.5, lpfHz: 7000,  margin: 11, gateRange: 26, holdMs: 110, releaseMs: 90,  lowSlope: 4.0, lowFloor: -18, highSlope: 0.6, highFloor: -5, tailDeadband: 1,   bandReleaseMs: 15 }
};

class AudioManager {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.sourceNode = null;
    
    // Core Nodes
    this.channelSplitterNode = null;
    this.ch1GainNode = null;
    this.ch2GainNode = null;
    this.inputBus = null;
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

    this.echoDepth = 0.50; // 0.0 - 1.0 (中心 50%)
    this.isMicActive = false;
    this.selectedDeviceId = '';
    this.selectedOutputDeviceId = '';
    this.micChannelMode = 'ch1'; // 'ch1' (Left / 規定) | 'ch2' (Right) | 'mix' (L+R)
    this.isLowCutEnabled = true;
    this.isLimiterEnabled = true;
    this.fxDisconnectTimers = {};

    // 声をクリアに（全指向性マイク向け 雑音・残響カット）
    this.voiceHpfNode = null;
    this.voiceMudNode = null;
    this.voiceLpfNode = null;
    this.voiceFocusNode = null; // AudioWorkletNode (非対応ブラウザでは null → EQ のみの簡易モード)
    this.voiceOutputNode = null; // 処理済みの声 (Dry / FX / マイクチェックの分岐点)
    this.voiceChain = [];
    this.voiceSwitchTimer = null;
    this.voiceFocusLevel = 'standard'; // 'off' | 'light' | 'standard' | 'strong'
    this.useNativeNoiseSuppression = true;
    this.nativeNoiseSuppressionSupported = false;
    this.nativeNoiseSuppressionActive = false;
    this.onVoiceFocusMeter = null;

    // 出力方式: 'context' (Web Audio 直接・低遅延) | 'media' (video 要素経由の互換モード)
    this.outputRoute = 'context';
    this.links = {};

    // Mobile/External Media Router (Video Hack) — 互換モード選択時のみ生成
    this.streamDestination = null;
    this.videoElement = null;
    this.dummyCanvas = null;
  }

  async kickAudioSession(isActive = true) {
    if ('audioSession' in navigator) {
      try {
        if (isActive) {
          navigator.audioSession.type = 'playback';
          await new Promise(r => setTimeout(r, 40));
          navigator.audioSession.type = 'play-and-record';
        } else {
          navigator.audioSession.type = 'playback';
          await new Promise(r => setTimeout(r, 40));
          navigator.audioSession.type = 'auto';
        }
      } catch (e) {
        console.warn("navigator.audioSession warning:", e);
      }
    }
  }

  async setOutputDevice(deviceId) {
    this.selectedOutputDeviceId = deviceId || '';
    if (this.videoElement && typeof this.videoElement.setSinkId === 'function') {
      try {
        await this.videoElement.setSinkId(this.selectedOutputDeviceId);
        console.log("VideoElement sink set to:", this.selectedOutputDeviceId || 'default');
      } catch (err) {
        console.warn("VideoElement setSinkId failed:", err);
      }
    }
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(this.selectedOutputDeviceId);
        console.log("AudioContext output sink set to:", this.selectedOutputDeviceId || 'default');
      } catch (err) {
        console.warn("AudioContext setSinkId failed:", err);
      }
    }
  }

  setMicChannelMode(mode) {
    this.micChannelMode = mode || 'ch1';
    if (!this.ch1GainNode || !this.ch2GainNode || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.ch1GainNode.gain.cancelScheduledValues(now);
    this.ch2GainNode.gain.cancelScheduledValues(now);

    if (this.micChannelMode === 'ch2') {
      this.ch1GainNode.gain.setValueAtTime(this.ch1GainNode.gain.value, now);
      this.ch1GainNode.gain.linearRampToValueAtTime(0.0, now + 0.02);
      this.ch2GainNode.gain.setValueAtTime(this.ch2GainNode.gain.value, now);
      this.ch2GainNode.gain.linearRampToValueAtTime(1.0, now + 0.02);
    } else if (this.micChannelMode === 'mix') {
      this.ch1GainNode.gain.setValueAtTime(this.ch1GainNode.gain.value, now);
      this.ch1GainNode.gain.linearRampToValueAtTime(0.707, now + 0.02);
      this.ch2GainNode.gain.setValueAtTime(this.ch2GainNode.gain.value, now);
      this.ch2GainNode.gain.linearRampToValueAtTime(0.707, now + 0.02);
    } else {
      // Default: 'ch1' (Left / チャンネル1: 有線イヤホン・通常マイク)
      this.ch1GainNode.gain.setValueAtTime(this.ch1GainNode.gain.value, now);
      this.ch1GainNode.gain.linearRampToValueAtTime(1.0, now + 0.02);
      this.ch2GainNode.gain.setValueAtTime(this.ch2GainNode.gain.value, now);
      this.ch2GainNode.gain.linearRampToValueAtTime(0.0, now + 0.02);
    }
  }

  async init(deviceId = '') {
    await this.kickAudioSession(true);

    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      // sampleRate は指定しない: 端末本来のレートで動かし、リサンプリング負荷と
      // Firefox の「サンプルレートの異なる MediaStream を接続できない」エラーを避ける
      try {
        this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
      } catch (e) {
        this.ctx = new AudioContextClass();
      }
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.selectedDeviceId = deviceId;
    if (!this.inputBus) {
      await this.setupAudioGraph();
    }
    await this.connectMicrophone();
  }

  async setupAudioGraph() {
    if (!this.ctx) return;

    // 0.5. 入力チャンネルルーター (有線イヤホン・モノラルマイク両耳ステレオ出力対応)
    this.channelSplitterNode = this.ctx.createChannelSplitter(2);
    this.ch1GainNode = this.ctx.createGain();
    this.ch2GainNode = this.ctx.createGain();
    this.inputBus = this.ctx.createGain();
    this.inputBus.channelCount = 1;
    this.inputBus.channelCountMode = 'explicit';
    this.inputBus.channelInterpretation = 'speakers';

    this.channelSplitterNode.connect(this.ch1GainNode, 0);
    this.channelSplitterNode.connect(this.ch2GainNode, 1);
    this.ch1GainNode.connect(this.inputBus);
    this.ch2GainNode.connect(this.inputBus);
    this.setMicChannelMode(this.micChannelMode);

    // 1. HPF (80Hz ローカットフィルター: ポップノイズ・吹かれ低減)
    this.hpfNode = this.ctx.createBiquadFilter();
    this.hpfNode.type = 'highpass';
    this.hpfNode.frequency.value = 80;
    this.hpfNode.Q.value = 0.707;
    this.hpfNode.channelCount = 1;
    this.hpfNode.channelCountMode = 'explicit';

    // 2. マイク入力ゲイン (0.0 - 3.0)
    this.micGainNode = this.ctx.createGain();
    this.micGainNode.gain.value = 1.0;
    this.micGainNode.channelCount = 1;
    this.micGainNode.channelCountMode = 'explicit';

    // 2.5. 声をクリアに（全指向性マイク向け 雑音・残響カット）
    //   ネイティブ EQ: 低域の響きと吹かれ / 300Hz 付近のこもり / 高域のヒスを削る (ハウリングを招くブーストはしない)
    //   AudioWorklet: 適応ノイズゲート + 残響テール抑制 (voice-focus-worklet.js)
    const preset = VOICE_FOCUS_PRESETS[this.voiceFocusLevel] || VOICE_FOCUS_PRESETS.standard;
    this.voiceHpfNode = this.ctx.createBiquadFilter();
    this.voiceHpfNode.type = 'highpass';
    this.voiceHpfNode.frequency.value = preset.hpfHz;
    this.voiceHpfNode.Q.value = 0.707;

    this.voiceMudNode = this.ctx.createBiquadFilter();
    this.voiceMudNode.type = 'peaking';
    this.voiceMudNode.frequency.value = 300;
    this.voiceMudNode.Q.value = 1.0;
    this.voiceMudNode.gain.value = preset.mudDb;

    this.voiceLpfNode = this.ctx.createBiquadFilter();
    this.voiceLpfNode.type = 'lowpass';
    this.voiceLpfNode.frequency.value = preset.lpfHz;
    this.voiceLpfNode.Q.value = 0.707;

    this.voiceOutputNode = this.ctx.createGain();
    this.voiceOutputNode.gain.value = 1.0;

    [this.voiceHpfNode, this.voiceMudNode, this.voiceLpfNode, this.voiceOutputNode].forEach(node => {
      node.channelCount = 1;
      node.channelCountMode = 'explicit';
    });

    await this.loadVoiceFocusWorklet(preset);

    // 3. FX ミキサーバス & Dry Gain
    this.dryGainNode = this.ctx.createGain();
    this.dryGainNode.gain.value = 1.0;
    this.dryGainNode.channelCount = 1;
    this.dryGainNode.channelCountMode = 'explicit';

    this.fxMixBus = this.ctx.createGain();
    this.fxMixBus.gain.value = 1.0;
    this.fxMixBus.channelCount = 2;
    this.fxMixBus.channelCountMode = 'explicit';
    this.fxMixBus.channelInterpretation = 'speakers';

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
    this.masterGainNode.channelCount = 2;
    this.masterGainNode.channelCountMode = 'explicit';
    this.masterGainNode.channelInterpretation = 'speakers';

    // 8. アナライザー (VUメーター)
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 512;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // 配線
    this.connectPipeline();
  }

  connectPipeline() {
    if (!this.ctx || !this.inputBus || !this.micGainNode) return;

    // inputBus -> HPF / MicGain
    this.inputBus.disconnect();
    if (this.isLowCutEnabled && this.hpfNode) {
      this.inputBus.connect(this.hpfNode);
      this.hpfNode.disconnect();
      this.hpfNode.connect(this.micGainNode);
    } else {
      this.inputBus.connect(this.micGainNode);
    }

    // MicGain -> [声をクリアに] -> voiceOutputNode
    this.rewireVoiceChain();

    // voiceOutputNode -> Dry + 有効な FX 入力 (OFF の FX は切り離して CPU を使わせない)
    this.voiceOutputNode.connect(this.dryGainNode);
    Object.keys(this.fxState).forEach(fxName => {
      this.setFxInputConnected(fxName, this.fxState[fxName]);
    });

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
    // 出力先は常に 1 経路だけ (2 経路から同時に鳴らすと遅延差で声が二重になり、響いて聞こえる)
    if (this.outputRoute === 'media') {
      this.ensureMediaRouter();
    }
    this.updateOutputLinks();
    this.masterGainNode.connect(this.analyserNode);
  }

  async loadVoiceFocusWorklet(preset) {
    if (!this.ctx || this.voiceFocusNode) return;
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      console.warn("AudioWorklet 非対応: 声をクリアに は EQ のみの簡易モードで動作します");
      return;
    }
    try {
      // 一部の端末で addModule が返ってこなくても、アプリ全体を止めずに簡易モードで起動する
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('addModule timeout')), 5000);
      });
      try {
        await Promise.race([
          this.ctx.audioWorklet.addModule(new URL('./voice-focus-worklet.js', import.meta.url).href),
          timeout
        ]);
      } finally {
        clearTimeout(timer);
      }
      this.voiceFocusNode = new AudioWorkletNode(this.ctx, 'voice-focus-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { config: preset }
      });
      this.voiceFocusNode.port.onmessage = (e) => {
        if (e.data && e.data.type === 'meter' && this.onVoiceFocusMeter) {
          this.onVoiceFocusMeter(e.data);
        }
      };
    } catch (err) {
      console.warn("Voice Focus worklet の読み込みに失敗 (EQ のみの簡易モードで動作):", err);
      this.voiceFocusNode = null;
    }
  }

  rewireVoiceChain() {
    if (!this.micGainNode || !this.voiceOutputNode) return;
    // 自分で張った接続だけを外す (並列タップを巻き込まない)
    for (let i = 0; i < this.voiceChain.length - 1; i++) {
      try { this.voiceChain[i].disconnect(this.voiceChain[i + 1]); } catch (e) {}
    }
    const chain = [this.micGainNode];
    if (this.voiceFocusLevel !== 'off') {
      chain.push(this.voiceHpfNode, this.voiceMudNode, this.voiceLpfNode);
      if (this.voiceFocusNode) chain.push(this.voiceFocusNode);
    }
    chain.push(this.voiceOutputNode);
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i].connect(chain[i + 1]);
    }
    this.voiceChain = chain;
  }

  setVoiceFocusLevel(level) {
    const next = VOICE_FOCUS_PRESETS[level] ? level : 'off';
    const wasOn = this.voiceFocusLevel !== 'off';
    this.voiceFocusLevel = next;
    if (!this.ctx || !this.voiceOutputNode) return;

    const preset = VOICE_FOCUS_PRESETS[next];
    if (preset) {
      const now = this.ctx.currentTime;
      this.voiceHpfNode.frequency.setTargetAtTime(preset.hpfHz, now, 0.02);
      this.voiceMudNode.gain.setTargetAtTime(preset.mudDb, now, 0.02);
      this.voiceLpfNode.frequency.setTargetAtTime(preset.lpfHz, now, 0.02);
      if (this.voiceFocusNode) {
        // OFF から戻した時は古い推定値を捨てて追従し直す
        this.voiceFocusNode.port.postMessage({ type: 'config', config: preset, reset: !wasOn });
      }
    }
    if (wasOn !== (next !== 'off')) {
      this.switchVoiceChainSmoothly();
    }
  }

  // ON AIR 中の繋ぎ替えで「プツッ」と鳴らないよう、一瞬フェードしてから繋ぎ替える
  switchVoiceChainSmoothly() {
    const out = this.voiceOutputNode;
    if (!this.isMicActive || this.ctx.state !== 'running') {
      this.rewireVoiceChain();
      return;
    }
    const now = this.ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0.0, now + 0.015);
    clearTimeout(this.voiceSwitchTimer);
    this.voiceSwitchTimer = setTimeout(() => {
      this.rewireVoiceChain();
      const t = this.ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(0.0, t);
      out.gain.linearRampToValueAtTime(1.0, t + 0.015);
    }, 30);
  }

  async setNativeNoiseSuppression(enabled) {
    this.useNativeNoiseSuppression = !!enabled;
    // ブラウザ側の音声処理は getUserMedia を取り直さないと確実には切り替わらない
    if (this.stream && this.ctx) {
      await this.connectMicrophone();
    }
  }

  setFxInputConnected(fxName, connected) {
    const inputs = {
      echo: this.echoDelayNode,
      radio: this.radioFilterNode,
      robot: this.robotModGainNode,
      reverb: this.reverbNode
    };
    this.linkNode(this.voiceOutputNode, inputs[fxName], connected, `fx:${fxName}`);
  }

  setOutputRoute(route) {
    this.outputRoute = route === 'media' ? 'media' : 'context';
    if (!this.ctx || !this.masterGainNode) return;
    if (this.outputRoute === 'media') {
      this.ensureMediaRouter();
      this.playMediaRouter();
    } else if (this.videoElement) {
      this.videoElement.pause();
    }
    this.updateOutputLinks();
  }

  // 互換モード: MediaStreamDestination を video 要素で再生 (裏ワザ2: iOS で動画再生と誤認させ外部出力を促す)
  ensureMediaRouter() {
    if (this.streamDestination) return true;
    if (!this.ctx || typeof this.ctx.createMediaStreamDestination !== 'function') return false;
    const videoElement = document.getElementById('video-output-router');
    if (!videoElement) return false;

    this.streamDestination = this.ctx.createMediaStreamDestination();
    this.videoElement = videoElement;
    this.dummyCanvas = document.getElementById('dummy-video-canvas');

    if (this.dummyCanvas && typeof this.dummyCanvas.captureStream === 'function') {
      const dummyCtx = this.dummyCanvas.getContext('2d');
      dummyCtx.fillStyle = '#000000';
      dummyCtx.fillRect(0, 0, 16, 16);
      try {
        const videoStream = this.dummyCanvas.captureStream(1);
        const videoTrack = videoStream.getVideoTracks()[0];
        const audioTrack = this.streamDestination.stream.getAudioTracks()[0];
        this.videoElement.srcObject = new MediaStream([audioTrack, videoTrack]);
      } catch (e) {
        this.videoElement.srcObject = this.streamDestination.stream;
      }
    } else {
      this.videoElement.srcObject = this.streamDestination.stream;
    }

    // video 要素が実際に鳴っている間だけ AudioContext 側の出力を止める (無音と二重再生の両方を防ぐ)
    ['playing', 'pause', 'ended', 'emptied', 'error'].forEach(type => {
      this.videoElement.addEventListener(type, () => this.updateOutputLinks());
    });
    if (this.selectedOutputDeviceId && typeof this.videoElement.setSinkId === 'function') {
      this.videoElement.setSinkId(this.selectedOutputDeviceId).catch(err => {
        console.warn("VideoElement setSinkId failed:", err);
      });
    }
    return true;
  }

  playMediaRouter() {
    if (this.outputRoute !== 'media' || !this.videoElement) return;
    this.videoElement.play().catch(e => console.log("videoElement play auto-resume:", e));
  }

  updateOutputLinks() {
    if (!this.ctx || !this.masterGainNode) return;
    const useMedia = this.outputRoute === 'media' && !!this.streamDestination && !!this.videoElement;
    this.linkNode(this.masterGainNode, this.streamDestination, useMedia, 'mediaRoute');
    const mediaAudible = useMedia && !this.videoElement.paused && !this.videoElement.ended &&
      this.videoElement.readyState >= 2;
    this.linkNode(this.masterGainNode, this.ctx.destination, !mediaAudible, 'contextRoute');
  }

  linkNode(source, destination, shouldLink, key) {
    if (!source || !destination) return;
    if (shouldLink && !this.links[key]) {
      source.connect(destination);
      this.links[key] = true;
    } else if (!shouldLink && this.links[key]) {
      try { source.disconnect(destination); } catch (e) {}
      this.links[key] = false;
    }
  }

  async connectMicrophone() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }

    await this.kickAudioSession();

    const mediaDevices = navigator.mediaDevices;
    const supported = typeof mediaDevices.getSupportedConstraints === 'function'
      ? mediaDevices.getSupportedConstraints()
      : {};
    this.nativeNoiseSuppressionSupported = !!supported.noiseSuppression;

    const constraints = {
      audio: {
        deviceId: this.selectedDeviceId ? { exact: this.selectedDeviceId } : undefined,
        // エコーキャンセラは PA 用途だとスピーカーから戻る自分の声を消そうとして声が途切れるため OFF
        echoCancellation: false,
        // ブラウザ内蔵ノイズ抑制 (ネイティブ実装なので軽い。非対応ブラウザでは無視される)
        noiseSuppression: this.useNativeNoiseSuppression,
        // 自動ゲインは話していない間に雑音と残響を持ち上げるため OFF
        autoGainControl: false,
        channelCount: { ideal: 1 }
      }
    };

    try {
      this.stream = await mediaDevices.getUserMedia(constraints);
      const track = typeof this.stream.getAudioTracks === 'function' ? this.stream.getAudioTracks()[0] : null;
      const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
      this.nativeNoiseSuppressionActive = settings.noiseSuppression === true;
      if (this.sourceNode) {
        this.sourceNode.disconnect();
      }
      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      if (this.channelSplitterNode) {
        this.sourceNode.connect(this.channelSplitterNode);
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
      this.kickAudioSession(true);
      this.muteGainNode.gain.setValueAtTime(this.muteGainNode.gain.value, now);
      this.muteGainNode.gain.linearRampToValueAtTime(1.0, now + 0.03);
      this.playMediaRouter();
    } else {
      this.kickAudioSession(false);
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

    // OFF の FX は入力ごと切り離して処理を止める (特にスタジオ残響のコンボルバーは重い)
    clearTimeout(this.fxDisconnectTimers[fxName]);
    if (active) {
      this.setFxInputConnected(fxName, true);
    } else {
      this.fxDisconnectTimers[fxName] = setTimeout(() => {
        if (!this.fxState[fxName]) this.setFxInputConnected(fxName, false);
      }, 80);
    }

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

  setEchoDepth(depthRatio) {
    this.echoDepth = depthRatio;
    if (this.echoFeedbackNode && this.ctx) {
      const now = this.ctx.currentTime;
      const feedbackGain = Math.min(0.82, depthRatio * 0.82);
      this.echoFeedbackNode.gain.linearRampToValueAtTime(feedbackGain, now + 0.02);
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
    if (this.inputBus && this.micGainNode) {
      if (this.hpfNode) {
        try { this.inputBus.disconnect(this.hpfNode); } catch (e) {}
      }
      try { this.inputBus.disconnect(this.micGainNode); } catch (e) {}

      if (enabled && this.hpfNode) {
        this.inputBus.connect(this.hpfNode);
        try {
          this.hpfNode.disconnect();
        } catch (e) {}
        this.hpfNode.connect(this.micGainNode);
      } else {
        this.inputBus.connect(this.micGainNode);
      }
    }
  }

  setLimiter(enabled) {
    this.isLimiterEnabled = enabled;
    if (this.eqHighNode && this.muteGainNode) {
      try {
        this.eqHighNode.disconnect();
      } catch (e) {}
      if (enabled && this.limiterNode) {
        this.eqHighNode.connect(this.limiterNode);
        try {
          this.limiterNode.disconnect();
        } catch (e) {}
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
      // 無音出力の保証
      const output = e.outputBuffer.getChannelData(0);
      output.fill(0);
    };

    // 処理済みの声 (マイクゲイン・声をクリアに 適用後) -> プロセッサー -> ゼロ出力 (ダミー接続)
    const inputSource = this.audioManager.voiceOutputNode || this.audioManager.inputBus || this.audioManager.sourceNode;
    if (inputSource) {
      this.zeroGainNode = ctx.createGain();
      this.zeroGainNode.gain.value = 0.0;
      inputSource.connect(this.processorNode);
      this.processorNode.connect(this.zeroGainNode);
      this.zeroGainNode.connect(ctx.destination);
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
        if (this.zeroGainNode) {
          this.zeroGainNode.disconnect();
          this.zeroGainNode = null;
        }
        const inputSource = this.audioManager.voiceOutputNode || this.audioManager.inputBus || this.audioManager.sourceNode;
        if (inputSource) {
          try {
            inputSource.disconnect(this.processorNode);
          } catch (e) {}
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
    this.audioManager.playMediaRouter();

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
    this.peakDecay = 0.9; // 30fps 描画時の減衰率
    this.dataArray = null;
    this.peakElem = document.getElementById('peak-indicator');
    this.lastFrameTime = -Infinity;
    this.lastTextTime = -Infinity;
    this.idleDrawn = false;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1);
    this.canvas.height = rect.height * (window.devicePixelRatio || 1);
    this.idleDrawn = false; // サイズ変更で消えたメーターを描き直す
  }

  start() {
    if (this.animationId) return;
    this.draw(0);
  }

  // DOM の書き換えは値が変わった時だけ (毎フレームのスタイル再計算を避ける)
  setPeakText(text, className) {
    if (!this.peakElem) return;
    if (this.peakElem.textContent !== text) this.peakElem.textContent = text;
    if (this.peakElem.className !== className) this.peakElem.className = className;
  }

  draw(timestamp) {
    this.animationId = requestAnimationFrame((t) => this.draw(t));

    // 低負荷化: 描画は最大 30fps。待機中はメーターが下がりきったら描画を止める
    if (timestamp - this.lastFrameTime < 33) return;
    this.lastFrameTime = timestamp;

    const width = this.canvas.width;
    const height = this.canvas.height;

    if (!this.audioManager.analyserNode || !this.audioManager.isMicActive) {
      if (this.idleDrawn) return;
      this.ctx.clearRect(0, 0, width, height);
      this.peakValue *= 0.8;
      if (this.peakValue < 0.01) {
        this.peakValue = 0;
        this.idleDrawn = true;
      }
      this.drawMeter(0, this.peakValue);
      this.setPeakText('-inf dB', 'text-slate-400 font-mono');
      return;
    }
    this.idleDrawn = false;
    this.ctx.clearRect(0, 0, width, height);

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

    // 数値表示は 8 回/秒で十分 (読み取れる速さ & レイアウト計算の削減)
    if (timestamp - this.lastTextTime < 120) return;
    this.lastTextTime = timestamp;
    const peakDb = Math.round(db);
    if (peakDb >= -1) {
      this.setPeakText(`${peakDb >= 0 ? '+' : ''}${peakDb} dB (CLIP)`, 'text-red-600 font-bold font-mono');
    } else if (peakDb >= -6) {
      this.setPeakText(`${peakDb} dB`, 'text-amber-600 font-bold font-mono');
    } else {
      this.setPeakText(`${peakDb} dB`, 'text-slate-600 font-mono');
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
  // テストページ等からモジュールとして読み込まれた時は UI を起動しない
  if (!document.getElementById('main-mic-btn')) return;

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
  const selectMicChannel = document.getElementById('select-mic-channel');
  const selectAudioOutput = document.getElementById('select-audio-output');
  const selectOutputRoute = document.getElementById('select-output-route');
  const btnApplyDevice = document.getElementById('btn-apply-device');

  // 声をクリアに Elements
  const voiceFocusButtons = Array.from(document.querySelectorAll('[data-voice-focus]'));
  const voiceFocusStatus = document.getElementById('voice-focus-status');
  const toggleNativeNs = document.getElementById('toggle-native-ns');
  const nativeNsNote = document.getElementById('native-ns-note');

  // 設定の保存 (プライベートブラウズ等で localStorage が使えなくても動作は続ける)
  const loadSetting = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  };
  const saveSetting = (key, value) => {
    try { localStorage.setItem(key, value); } catch (e) {}
  };

  const savedVoiceFocus = loadSetting('voice_focus_level', 'standard');
  audioManager.voiceFocusLevel = (savedVoiceFocus === 'off' || VOICE_FOCUS_PRESETS[savedVoiceFocus]) ? savedVoiceFocus : 'standard';
  audioManager.useNativeNoiseSuppression = loadSetting('native_noise_suppression', 'on') !== 'off';
  audioManager.outputRoute = loadSetting('output_route', 'context') === 'media' ? 'media' : 'context';

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

  // 初期化関数 (連打されても初期化は 1 回だけ。二重に getUserMedia するとマイク入力が重複する)
  let initPromise = null;
  async function ensureAudioReady() {
    if (isInitialized) return;
    if (!initPromise) {
      initPromise = audioManager.init().then(async () => {
        isInitialized = true;
        await populateAudioDevices();
        refreshVoiceFocusStatus();
        refreshNativeNsUI();
      }).catch((err) => {
        initPromise = null;
        alert("マイクの使用が許可されませんでした。ブラウザのマイク権限を許可してください。");
        throw err;
      });
    }
    await initPromise;
  }

  async function populateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      // 1. 入力マイク
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      selectAudioInput.innerHTML = '<option value="">規定のマイク (内蔵 / 外部自動判別)</option>';
      audioInputs.forEach((device, idx) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label ? `${device.label}` : `マイク ${idx + 1}`;
        if (device.deviceId === audioManager.selectedDeviceId) {
          option.selected = true;
        }
        selectAudioInput.appendChild(option);
      });

      // 2. 出力スピーカー / イヤホン
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
      selectAudioOutput.innerHTML = '';
      
      if (audioOutputs.length > 0) {
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = '規定のスピーカー (Default)';
        selectAudioOutput.appendChild(defaultOpt);

        audioOutputs.forEach((device, idx) => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `スピーカー ${idx + 1}`;
          if (device.deviceId === audioManager.selectedOutputDeviceId) {
            option.selected = true;
          }
          selectAudioOutput.appendChild(option);
        });
      } else {
        // iOS Safari / モバイル等で audiooutput 列挙がサポートされない場合
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '端末の標準出力 (イヤホン端子 / 外部スピーカー / Bluetooth連動)';
        option.selected = true;
        selectAudioOutput.appendChild(option);
      }
    } catch (e) {
      console.warn("デバイス一覧取得失敗", e);
    }
  }

  // 外部機器の接続・切断を検知
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      console.log("Audio device change detected");
      if (isInitialized) {
        await populateAudioDevices();
      }
    });
  }

  btnDeviceSettings.addEventListener('click', async () => {
    await ensureAudioReady();
    await populateAudioDevices();
    if (selectMicChannel) {
      selectMicChannel.value = audioManager.micChannelMode || 'ch1';
    }
    if (selectOutputRoute) {
      selectOutputRoute.value = audioManager.outputRoute;
    }
    deviceModal.classList.remove('hidden');
  });

  btnCloseDeviceModal.addEventListener('click', () => {
    deviceModal.classList.add('hidden');
  });

  btnApplyDevice.addEventListener('click', async () => {
    const inId = selectAudioInput.value;
    const outId = selectAudioOutput.value;
    if (selectMicChannel) {
      audioManager.setMicChannelMode(selectMicChannel.value);
    }
    await audioManager.init(inId);
    await audioManager.setOutputDevice(outId);
    if (selectOutputRoute) {
      audioManager.setOutputRoute(selectOutputRoute.value);
      saveSetting('output_route', audioManager.outputRoute);
    }
    refreshNativeNsUI();
    deviceModal.classList.add('hidden');
  });

  if (selectMicChannel) {
    selectMicChannel.addEventListener('change', () => {
      audioManager.setMicChannelMode(selectMicChannel.value);
    });
  }

  if (selectOutputRoute) {
    selectOutputRoute.addEventListener('change', () => {
      audioManager.setOutputRoute(selectOutputRoute.value);
      saveSetting('output_route', audioManager.outputRoute);
    });
  }

  // --- 声をクリアに（全指向性マイク向け 雑音・残響カット） ---
  const VOICE_FOCUS_BTN_ACTIVE = 'py-1.5 rounded-lg text-xs font-bold transition-all bg-white text-emerald-700 shadow-sm';
  const VOICE_FOCUS_BTN_IDLE = 'py-1.5 rounded-lg text-xs font-medium text-slate-600 transition-all hover:text-slate-900';
  const VOICE_STATUS_TONES = {
    idle: 'bg-slate-100 text-slate-500',
    voice: 'bg-emerald-100 text-emerald-700',
    cut: 'bg-indigo-100 text-indigo-700',
    warn: 'bg-amber-100 text-amber-700'
  };
  let lastVoiceStatus = '';

  function setVoiceFocusStatus(text, tone) {
    if (!voiceFocusStatus || lastVoiceStatus === text + tone) return;
    lastVoiceStatus = text + tone;
    voiceFocusStatus.textContent = text;
    voiceFocusStatus.className = `text-xs px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${VOICE_STATUS_TONES[tone]}`;
  }

  function refreshVoiceFocusStatus() {
    if (audioManager.voiceFocusLevel === 'off') {
      setVoiceFocusStatus('OFF', 'idle');
    } else if (!isInitialized) {
      setVoiceFocusStatus('待機中', 'idle');
    } else if (!audioManager.voiceFocusNode) {
      setVoiceFocusStatus('簡易モード (EQのみ)', 'warn');
    }
    // 処理中の状態は Worklet からのメーター通知で更新する
  }

  function updateVoiceFocusButtons() {
    voiceFocusButtons.forEach(btn => {
      const selected = btn.dataset.voiceFocus === audioManager.voiceFocusLevel;
      btn.className = selected ? VOICE_FOCUS_BTN_ACTIVE : VOICE_FOCUS_BTN_IDLE;
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function refreshNativeNsUI() {
    if (!toggleNativeNs) return;
    toggleNativeNs.checked = audioManager.useNativeNoiseSuppression;
    const unsupported = isInitialized && !audioManager.nativeNoiseSuppressionSupported;
    toggleNativeNs.disabled = unsupported;
    if (nativeNsNote) {
      nativeNsNote.textContent = unsupported
        ? '（このブラウザは非対応。上の処理だけで動作します）'
        : '（切り替え時に一瞬音が途切れます）';
    }
  }

  audioManager.onVoiceFocusMeter = (meter) => {
    if (document.hidden || audioManager.voiceFocusLevel === 'off') return;
    if (meter.open) {
      setVoiceFocusStatus('声を検出中', 'voice');
    } else {
      setVoiceFocusStatus(`雑音カット中 ${Math.round(meter.reductionDb)}dB`, 'cut');
    }
  };

  voiceFocusButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      audioManager.setVoiceFocusLevel(btn.dataset.voiceFocus);
      saveSetting('voice_focus_level', audioManager.voiceFocusLevel);
      updateVoiceFocusButtons();
      lastVoiceStatus = '';
      refreshVoiceFocusStatus();
    });
  });

  if (toggleNativeNs) {
    toggleNativeNs.addEventListener('change', async () => {
      const enabled = toggleNativeNs.checked;
      toggleNativeNs.disabled = true;
      try {
        await audioManager.setNativeNoiseSuppression(enabled);
        saveSetting('native_noise_suppression', enabled ? 'on' : 'off');
      } catch (err) {
        console.warn("ノイズ抑制の切り替えに失敗:", err);
      } finally {
        refreshNativeNsUI();
      }
    });
  }

  updateVoiceFocusButtons();
  refreshVoiceFocusStatus();
  refreshNativeNsUI();

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
        micSubText.textContent = 'タップ または [Space] でミュート';
        micIconWrapper.innerHTML = '<i data-lucide="mic" class="w-8 h-8 sm:w-10 sm:h-10 text-white"></i>';
      }
    } else {
      mainMicBtn.className = 'w-48 h-48 sm:w-56 sm:h-56 rounded-full border-4 flex flex-col items-center justify-center gap-2 transition-all duration-150 transform active:scale-95 shadow-md bg-slate-100 border-slate-300 text-slate-400 cursor-pointer';
      micStatusText.textContent = 'STANDBY';
      micSubText.textContent = talkMode === 'ptt' ? '長押し または [Space] 長押しで発声' : 'タップ または [Space] で開始';
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
    if (e) e.preventDefault();
    await ensureAudioReady();
    audioManager.setMicActive(true);
    updateMicButtonUI(true);
  };

  const stopPtt = (e) => {
    if (talkMode !== 'ptt') return;
    if (e) e.preventDefault();
    if (audioManager.isMicActive) {
      audioManager.setMicActive(false);
      updateMicButtonUI(false);
    }
  };

  mainMicBtn.addEventListener('pointerdown', startPtt);
  window.addEventListener('pointerup', stopPtt);
  window.addEventListener('pointercancel', stopPtt);

  // --- キーボード [Space] キーによる ON/OFF & PTT 制御 ---
  function isInputFocused() {
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    const tag = activeEl.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || activeEl.isContentEditable;
  }

  window.addEventListener('keydown', async (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      if (isInputFocused()) return;
      e.preventDefault();
      if (e.repeat) return;

      await ensureAudioReady();

      if (talkMode === 'toggle') {
        const nextState = !audioManager.isMicActive;
        audioManager.setMicActive(nextState);
        updateMicButtonUI(nextState);
      } else if (talkMode === 'ptt') {
        if (!audioManager.isMicActive) {
          audioManager.setMicActive(true);
          updateMicButtonUI(true);
        }
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      if (isInputFocused()) return;
      if (talkMode === 'ptt') {
        e.preventDefault();
        if (audioManager.isMicActive) {
          audioManager.setMicActive(false);
          updateMicButtonUI(false);
        }
      }
    }
  });

  window.addEventListener('blur', () => {
    if (talkMode === 'ptt' && audioManager.isMicActive) {
      audioManager.setMicActive(false);
      updateMicButtonUI(false);
    }
  });

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
    sliderEchoDepth.value = 50;
    valEchoDepth.textContent = '50%';
    audioManager.setEchoDepth(0.50);
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

export { AudioManager, MicChecker, Visualizer, VOICE_FOCUS_PRESETS };

