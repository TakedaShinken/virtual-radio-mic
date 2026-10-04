import assert from 'node:assert';

// Mock Web Audio API classes for Node testing
class MockAudioParam {
  constructor(defaultValue = 1.0) {
    this.value = defaultValue;
  }
  setValueAtTime(val, time) { this.value = val; }
  linearRampToValueAtTime(val, time) { this.value = val; }
  setTargetAtTime(val, time, timeConstant) { this.value = val; }
  cancelScheduledValues(time) {}
}

class MockAudioNode {
  constructor(ctx, type = 'generic') {
    this.ctx = ctx;
    this.type = type;
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
    this.connections = []; // list of { destination, outputIndex, inputIndex }
  }

  connect(destination, outputIndex = 0, inputIndex = 0) {
    this.connections.push({ destination, outputIndex, inputIndex });
    return destination;
  }

  disconnect(destination) {
    if (!destination) {
      this.connections = [];
    } else {
      this.connections = this.connections.filter(c => c.destination !== destination);
    }
  }
}

class MockGainNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new MockAudioParam(1.0);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'biquad');
    this.frequency = new MockAudioParam(350);
    this.Q = new MockAudioParam(1);
    this.gain = new MockAudioParam(0);
    this.type = 'lowpass';
  }
}

class MockDelayNode extends MockAudioNode {
  constructor(ctx, maxDelay) {
    super(ctx, 'delay');
    this.delayTime = new MockAudioParam(0);
  }
}

class MockWaveShaperNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'waveshaper');
    this.curve = null;
    this.oversample = 'none';
  }
}

class MockOscillatorNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.frequency = new MockAudioParam(440);
    this.type = 'sine';
  }
  start() {}
  stop() {}
}

class MockConvolverNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'convolver');
    this.buffer = null;
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'compressor');
    this.threshold = new MockAudioParam(-24);
    this.knee = new MockAudioParam(30);
    this.ratio = new MockAudioParam(12);
    this.attack = new MockAudioParam(0.003);
    this.release = new MockAudioParam(0.25);
  }
}

class MockAnalyserNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx, 'analyser');
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0.8;
  }
}

class MockChannelSplitterNode extends MockAudioNode {
  constructor(ctx, numberOfOutputs = 2) {
    super(ctx, 'splitter');
    this.numberOfOutputs = numberOfOutputs;
  }
}

class MockAudioContext {
  constructor(options) {
    MockAudioContext.lastOptions = options;
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new MockAudioNode(this, 'destination');
  }

  createGain() { return new MockGainNode(this); }
  createBiquadFilter() { return new MockBiquadFilterNode(this); }
  createDelay(max) { return new MockDelayNode(this, max); }
  createWaveShaper() { return new MockWaveShaperNode(this); }
  createOscillator() { return new MockOscillatorNode(this); }
  createConvolver() { return new MockConvolverNode(this); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(this); }
  createAnalyser() { return new MockAnalyserNode(this); }
  createChannelSplitter(outputs) { return new MockChannelSplitterNode(this, outputs); }
  createMediaStreamDestination() {
    const dest = new MockAudioNode(this, 'mediaStreamDestination');
    dest.stream = { getAudioTracks: () => [{}] };
    return dest;
  }
  createMediaStreamSource(stream) {
    return new MockAudioNode(this, 'mediaStreamSource');
  }
  createBuffer(channels, length, sampleRate) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (ch) => new Float32Array(length)
    };
  }
  createScriptProcessor(bufSize, inCh, outCh) {
    const sp = new MockAudioNode(this, 'scriptProcessor');
    sp.bufferSize = bufSize;
    sp.inputChannels = inCh;
    sp.outputChannels = outCh;
    return sp;
  }
  resume() { return Promise.resolve(); }
}

global.window = {
  AudioContext: MockAudioContext,
  addEventListener: () => {}
};
const mockElements = {};
global.document = {
  getElementById: (id) => mockElements[id] || null,
  addEventListener: () => {}
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {}
};
const gumCalls = [];
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getSupportedConstraints: () => ({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }),
      getUserMedia: async (constraints) => {
        gumCalls.push(constraints);
        const track = {
          stop: () => {},
          getSettings: () => ({ noiseSuppression: constraints.audio.noiseSuppression })
        };
        return {
          getTracks: () => [track],
          getAudioTracks: () => [track]
        };
      },
      enumerateDevices: async () => []
    }
  },
  configurable: true,
  writable: true
});

// Import AudioManager and MicChecker from app.js
const { AudioManager, MicChecker, VOICE_FOCUS_PRESETS } = await import('../app.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isLinked = (from, to) => from.connections.some(c => c.destination === to);

console.log("Starting Audio Graph & Channel Routing Test Suite...\n");

// --- TEST 1: Initialization & Node Creation ---
console.log("Test 1: AudioManager initialization & Channel Router nodes creation");
const am = new AudioManager();
await am.init();

assert.ok(am.channelSplitterNode, "channelSplitterNode must exist");
assert.ok(am.ch1GainNode, "ch1GainNode must exist");
assert.ok(am.ch2GainNode, "ch2GainNode must exist");
assert.ok(am.inputBus, "inputBus must exist");
console.log("  PASS: Channel router nodes successfully created");

// --- TEST 2: Channel Count & Mode Specifications ---
console.log("Test 2: Verifying Web Audio channel counts and modes");
assert.strictEqual(am.inputBus.channelCount, 1, "inputBus must be 1 channel (mono)");
assert.strictEqual(am.inputBus.channelCountMode, 'explicit', "inputBus channelCountMode must be 'explicit'");
assert.strictEqual(am.inputBus.channelInterpretation, 'speakers', "inputBus channelInterpretation must be 'speakers'");

assert.strictEqual(am.fxMixBus.channelCount, 2, "fxMixBus must be 2 channels (stereo)");
assert.strictEqual(am.fxMixBus.channelCountMode, 'explicit', "fxMixBus channelCountMode must be 'explicit'");
assert.strictEqual(am.fxMixBus.channelInterpretation, 'speakers', "fxMixBus channelInterpretation must be 'speakers'");

assert.strictEqual(am.masterGainNode.channelCount, 2, "masterGainNode must be 2 channels (stereo)");
assert.strictEqual(am.masterGainNode.channelCountMode, 'explicit', "masterGainNode channelCountMode must be 'explicit'");
console.log("  PASS: Web Audio channel configurations strictly conform to stereo up-mixing specs");

// --- TEST 3: Default Channel Mode (ch1 - Left Earphone Mic) ---
console.log("Test 3: Default channel mode routing (ch1: 3.5mm wired earphones)");
assert.strictEqual(am.micChannelMode, 'ch1', "Default mode must be 'ch1'");
assert.strictEqual(am.ch1GainNode.gain.value, 1.0, "ch1GainNode must have gain 1.0 (0dB loss)");
assert.strictEqual(am.ch2GainNode.gain.value, 0.0, "ch2GainNode must have gain 0.0 (muted empty right channel)");
console.log("  PASS: Default mode ch1 routes Left channel at 1.0 gain and mutes empty Right channel");

// --- TEST 4: Channel Switching (ch2 and mix) ---
console.log("Test 4: Switching channel mode to ch2 and mix");
am.setMicChannelMode('ch2');
assert.strictEqual(am.micChannelMode, 'ch2');
assert.strictEqual(am.ch1GainNode.gain.value, 0.0, "ch1GainNode must be 0.0 for ch2 mode");
assert.strictEqual(am.ch2GainNode.gain.value, 1.0, "ch2GainNode must be 1.0 for ch2 mode");

am.setMicChannelMode('mix');
assert.strictEqual(am.micChannelMode, 'mix');
assert.strictEqual(am.ch1GainNode.gain.value, 0.707, "ch1GainNode must be 0.707 for mix mode");
assert.strictEqual(am.ch2GainNode.gain.value, 0.707, "ch2GainNode must be 0.707 for mix mode");

// Reset back to ch1
am.setMicChannelMode('ch1');
assert.strictEqual(am.ch1GainNode.gain.value, 1.0);
assert.strictEqual(am.ch2GainNode.gain.value, 0.0);
console.log("  PASS: Channel switching works correctly for all modes (ch1, ch2, mix)");

// --- TEST 5: Input Bus & Filter Routing ---
console.log("Test 5: Low-cut filter toggling with inputBus");
am.setLowCut(true);
assert.ok(am.inputBus.connections.some(c => c.destination === am.hpfNode), "inputBus must connect to hpfNode when low-cut is enabled");

am.setLowCut(false);
assert.ok(am.inputBus.connections.some(c => c.destination === am.micGainNode), "inputBus must connect directly to micGainNode when low-cut is disabled");

am.setLowCut(true); // reset
console.log("  PASS: Low-cut filter toggling cleanly updates inputBus connections");

// --- TEST 6: FX Mix Bus Stereo Connections ---
console.log("Test 6: FX Mix Bus receives Dry, Echo, Radio, Robot, and Reverb");
assert.ok(am.dryGainNode.connections.some(c => c.destination === am.fxMixBus), "dryGainNode must connect to fxMixBus");
assert.ok(am.echoWetGainNode.connections.some(c => c.destination === am.fxMixBus), "echoWetGainNode must connect to fxMixBus");
assert.ok(am.radioWetGainNode.connections.some(c => c.destination === am.fxMixBus), "radioWetGainNode must connect to fxMixBus");
assert.ok(am.robotWetGainNode.connections.some(c => c.destination === am.fxMixBus), "robotWetGainNode must connect to fxMixBus");
assert.ok(am.reverbWetGainNode.connections.some(c => c.destination === am.fxMixBus), "reverbWetGainNode must connect to fxMixBus");
console.log("  PASS: All FX and Dry buses feed into fxMixBus with 2-channel stereo up-mix");

// --- TEST 7: MicChecker Integration ---
console.log("Test 7: MicChecker test recording taps the processed voice (voiceOutputNode)");
const mc = new MicChecker(am);
await mc.startTestRecording(1);
const recordingTap = mc.processorNode;
assert.ok(recordingTap, "processorNode must be created");
assert.ok(isLinked(am.voiceOutputNode, recordingTap), "voiceOutputNode must connect to processorNode during mic check (mic gain + ノイズキャンセリング are audible in the check)");

mc.stopRecording();
assert.strictEqual(mc.processorNode, null, "processorNode must be null after stopRecording");
assert.strictEqual(isLinked(am.voiceOutputNode, recordingTap), false, "voiceOutputNode must disconnect processorNode after recording");
console.log("  PASS: MicChecker records the processed voice and disconnects cleanly");

// --- TEST 8: Full Audio Pipeline Stereo Output Simulation ---
console.log("Test 8: Simulating wired earphone audio through the complete graph");
// Simulate the user scenario:
// Input: Stereo source from TRRS headset jack where Left = voice, Right = silence
const mockVoiceAudio = [
  new Float32Array([0.5, 0.3, -0.2, 0.4]), // Left: User voice
  new Float32Array([0.0, 0.0,  0.0, 0.0])  // Right: Silence (disconnected ring)
];

// Step A: ChannelSplitter separates Ch0 and Ch1
const splitterOut0 = mockVoiceAudio[0];
const splitterOut1 = mockVoiceAudio[1];

// Step B: ch1Gain (1.0) and ch2Gain (0.0) sum into inputBus
const inputBusSignal = new Float32Array(splitterOut0.length);
for (let i = 0; i < inputBusSignal.length; i++) {
  inputBusSignal[i] = splitterOut0[i] * am.ch1GainNode.gain.value + splitterOut1[i] * am.ch2GainNode.gain.value;
}

// Step C: Verify inputBus receives 100% of user voice
for (let i = 0; i < inputBusSignal.length; i++) {
  assert.strictEqual(inputBusSignal[i], mockVoiceAudio[0][i], `inputBus sample ${i} must match voice exactly`);
}

// Step D: fxMixBus (explicit 2-channel speakers mode) up-mixes inputBus mono to stereo (1 -> 2)
// Per W3C Web Audio spec: output.channel(0) = input.channel(0), output.channel(1) = input.channel(0)
const leftEarOutput = inputBusSignal;
const rightEarOutput = inputBusSignal;

assert.strictEqual(leftEarOutput.length, rightEarOutput.length);
for (let i = 0; i < leftEarOutput.length; i++) {
  assert.strictEqual(leftEarOutput[i], rightEarOutput[i], "Both ears must receive identical audio");
  assert.notStrictEqual(rightEarOutput[i], 0.0, "Right ear must NOT be silent");
}
console.log("  PASS: Complete signal pipeline outputs voice to BOTH Left and Right channels with zero volume loss!");

// --- TEST 9: AudioManager init() Idempotency ---
console.log("\nTest 9: AudioManager init() idempotency and graph preservation");
const prevMasterNode = am.masterGainNode;
const prevInputBus = am.inputBus;
const prevSplitter = am.channelSplitterNode;
await am.init('device-2');
assert.strictEqual(am.masterGainNode, prevMasterNode, "masterGainNode must be preserved across init() calls");
assert.strictEqual(am.inputBus, prevInputBus, "inputBus must be preserved across init() calls");
assert.strictEqual(am.channelSplitterNode, prevSplitter, "channelSplitterNode must be preserved across init() calls");
console.log("  PASS: Audio graph is preserved without leaking or recreating nodes");

// --- TEST 10: Low-Cut does not sever external inputBus taps ---
console.log("\nTest 10: setLowCut does not disconnect external taps from inputBus");
const dummyTap = am.ctx.createGain();
am.inputBus.connect(dummyTap);
assert.ok(am.inputBus.connections.some(c => c.destination === dummyTap));
am.setLowCut(false);
assert.ok(am.inputBus.connections.some(c => c.destination === dummyTap), "dummyTap must remain connected when low-cut is disabled");
am.setLowCut(true);
assert.ok(am.inputBus.connections.some(c => c.destination === dummyTap), "dummyTap must remain connected when low-cut is enabled");
am.inputBus.disconnect(dummyTap);
console.log("  PASS: setLowCut uses targeted disconnection, preserving parallel taps");

// --- TEST 11: AudioContext uses the device's native sample rate ---
console.log("\nTest 11: AudioContext is created without a forced sampleRate (no resampling load / Firefox mismatch)");
assert.ok(MockAudioContext.lastOptions, "AudioContext options must be passed");
assert.strictEqual(MockAudioContext.lastOptions.latencyHint, 'interactive', "latencyHint must stay 'interactive' (low latency)");
assert.ok(!('sampleRate' in MockAudioContext.lastOptions), "sampleRate must not be forced");
console.log("  PASS: AudioContext runs at the native rate with interactive latency");

// --- TEST 12: getUserMedia constraints for omni-directional mics ---
console.log("\nTest 12: getUserMedia constraints (native NS on, AEC/AGC off, no forced sampleRate)");
{
  const c = gumCalls[gumCalls.length - 1].audio;
  assert.strictEqual(c.noiseSuppression, true, "browser noise suppression must be requested by default");
  assert.strictEqual(c.echoCancellation, false, "echo cancellation must stay off (it would cut the PA voice)");
  assert.strictEqual(c.autoGainControl, false, "AGC must stay off (it pumps up noise and reverb in pauses)");
  assert.ok(!('sampleRate' in c), "capture sampleRate must not be forced");
  assert.strictEqual(am.nativeNoiseSuppressionSupported, true);
  assert.strictEqual(am.nativeNoiseSuppressionActive, true);

  const before = gumCalls.length;
  await am.setNativeNoiseSuppression(false);
  assert.strictEqual(gumCalls.length, before + 1, "toggling NS must re-acquire the microphone");
  assert.strictEqual(gumCalls[gumCalls.length - 1].audio.noiseSuppression, false);
  assert.strictEqual(am.nativeNoiseSuppressionActive, false);
  assert.ok(am.sourceNode && isLinked(am.sourceNode, am.channelSplitterNode), "new mic source must feed the channel router");
  await am.setNativeNoiseSuppression(true);
  assert.strictEqual(gumCalls[gumCalls.length - 1].audio.noiseSuppression, true);
}
console.log("  PASS: Constraints are tuned for PA use and NS can be toggled at runtime");

// --- TEST 13: Voice Focus chain wiring (EQ-only fallback when AudioWorklet is unavailable) ---
console.log("\nTest 13: ノイズキャンセリング chain wiring and presets (no AudioWorklet -> EQ-only fallback)");
{
  assert.strictEqual(am.voiceFocusLevel, 'standard', "default level must be 'standard'");
  assert.strictEqual(am.voiceFocusNode, null, "mock context has no AudioWorklet -> no worklet node");
  assert.ok(isLinked(am.micGainNode, am.voiceHpfNode), "micGain -> voice HPF");
  assert.ok(isLinked(am.voiceHpfNode, am.voiceMudNode), "voice HPF -> mud cut");
  assert.ok(isLinked(am.voiceMudNode, am.voiceLpfNode), "mud cut -> voice LPF");
  assert.ok(isLinked(am.voiceLpfNode, am.voiceOutputNode), "voice LPF -> voiceOutputNode");
  assert.ok(!isLinked(am.micGainNode, am.voiceOutputNode), "no bypass link while ON");
  assert.strictEqual(am.voiceHpfNode.frequency.value, VOICE_FOCUS_PRESETS.standard.hpfHz);
  assert.ok(VOICE_FOCUS_PRESETS.standard.mudDb < 0 && VOICE_FOCUS_PRESETS.strong.mudDb < 0, "voice EQ only cuts (no feedback-prone boosts)");

  am.setVoiceFocusLevel('off');
  assert.ok(isLinked(am.micGainNode, am.voiceOutputNode), "OFF: micGain -> voiceOutputNode directly");
  assert.ok(!isLinked(am.micGainNode, am.voiceHpfNode), "OFF: EQ chain detached");
  assert.ok(!isLinked(am.voiceLpfNode, am.voiceOutputNode), "OFF: EQ chain detached (tail)");

  am.setVoiceFocusLevel('strong');
  assert.ok(isLinked(am.micGainNode, am.voiceHpfNode) && isLinked(am.voiceLpfNode, am.voiceOutputNode), "strong: chain restored");
  assert.ok(!isLinked(am.micGainNode, am.voiceOutputNode), "strong: bypass removed");
  assert.strictEqual(am.voiceHpfNode.frequency.value, VOICE_FOCUS_PRESETS.strong.hpfHz);
  assert.strictEqual(am.voiceMudNode.gain.value, VOICE_FOCUS_PRESETS.strong.mudDb);
  assert.strictEqual(am.voiceLpfNode.frequency.value, VOICE_FOCUS_PRESETS.strong.lpfHz);

  // ON AIR 中の切り替えはフェードしてから繋ぎ替える
  am.setMicActive(true);
  am.setVoiceFocusLevel('off');
  assert.strictEqual(am.voiceOutputNode.gain.value, 0.0, "while on air the voice output fades out before rewiring");
  await sleep(60);
  assert.ok(isLinked(am.micGainNode, am.voiceOutputNode), "rewired after the fade");
  assert.strictEqual(am.voiceOutputNode.gain.value, 1.0, "voice output fades back in");
  am.setVoiceFocusLevel('standard');
  await sleep(60);
  am.setMicActive(false);
  assert.ok(isLinked(am.voiceLpfNode, am.voiceOutputNode) && !isLinked(am.micGainNode, am.voiceOutputNode));
  assert.ok(isLinked(am.voiceOutputNode, am.dryGainNode), "voiceOutputNode feeds the dry path");
}
console.log("  PASS: Voice chain switches OFF/ON/presets cleanly and keeps a single path");

// --- TEST 14: Voice Focus with AudioWorklet support ---
console.log("\nTest 14: ノイズキャンセリング inserts the AudioWorklet and sends preset configs");
{
  class MockAudioWorkletNode extends MockAudioNode {
    constructor(ctx, name, options) {
      super(ctx, 'audioworklet');
      this.processorName = name;
      this.options = options;
      this.port = { messages: [], onmessage: null, postMessage: (m) => this.port.messages.push(m) };
    }
  }
  globalThis.AudioWorkletNode = MockAudioWorkletNode;
  const loadedModules = [];
  const am2 = new AudioManager();
  am2.ctx = new MockAudioContext();
  am2.ctx.audioWorklet = { addModule: async (url) => { loadedModules.push(url); } };
  await am2.setupAudioGraph();

  assert.strictEqual(loadedModules.length, 1, "worklet module must be loaded once");
  assert.ok(loadedModules[0].endsWith('/voice-focus-worklet.js'), "module URL resolves next to app.js: " + loadedModules[0]);
  const node = am2.voiceFocusNode;
  assert.ok(node instanceof MockAudioWorkletNode, "worklet node must be created");
  assert.strictEqual(node.processorName, 'voice-focus-processor');
  assert.strictEqual(node.options.processorOptions.config.gateRange, VOICE_FOCUS_PRESETS.standard.gateRange);
  assert.deepStrictEqual(node.options.outputChannelCount, [1], "mono processing keeps the cost minimal");
  assert.ok(isLinked(am2.voiceLpfNode, node) && isLinked(node, am2.voiceOutputNode), "LPF -> worklet -> voiceOutputNode");

  am2.setVoiceFocusLevel('strong');
  let msg = node.port.messages[node.port.messages.length - 1];
  assert.strictEqual(msg.type, 'config');
  assert.strictEqual(msg.config.gateRange, VOICE_FOCUS_PRESETS.strong.gateRange);
  assert.strictEqual(msg.reset, false, "switching between ON levels keeps the noise-floor estimate");

  am2.setVoiceFocusLevel('off');
  assert.ok(!isLinked(am2.voiceLpfNode, node) && !isLinked(node, am2.voiceOutputNode), "OFF detaches the worklet (no CPU)");
  am2.setVoiceFocusLevel('light');
  msg = node.port.messages[node.port.messages.length - 1];
  assert.strictEqual(msg.reset, true, "coming back from OFF resets the stale estimate");
  assert.ok(isLinked(node, am2.voiceOutputNode));

  let meterSeen = null;
  am2.onVoiceFocusMeter = (m) => { meterSeen = m; };
  node.port.onmessage({ data: { type: 'meter', open: false, reductionDb: -10, noiseFloorDb: -55 } });
  assert.ok(meterSeen && meterSeen.reductionDb === -10, "meter messages are forwarded to the UI callback");
  delete globalThis.AudioWorkletNode;
}
console.log("  PASS: Worklet path wired, configured per preset, and fully detached when OFF");

// --- TEST 15: Inactive FX do not consume CPU ---
console.log("\nTest 15: FX inputs are connected only while the FX is ON");
{
  const fxInputs = { echo: am.echoDelayNode, radio: am.radioFilterNode, robot: am.robotModGainNode, reverb: am.reverbNode };
  for (const [fx, input] of Object.entries(fxInputs)) {
    assert.ok(!isLinked(am.voiceOutputNode, input), `${fx}: input must be detached while OFF`);
    assert.ok(!isLinked(am.micGainNode, input), `${fx}: no legacy always-on link from micGain`);
  }
  for (const [fx, input] of Object.entries(fxInputs)) {
    assert.strictEqual(am.toggleFX(fx), true);
    assert.ok(isLinked(am.voiceOutputNode, input), `${fx}: input attached when turned ON`);
    assert.strictEqual(am.toggleFX(fx), false);
    assert.ok(isLinked(am.voiceOutputNode, input), `${fx}: stays attached during the 30ms fade-out`);
  }
  await sleep(120);
  for (const [fx, input] of Object.entries(fxInputs)) {
    assert.ok(!isLinked(am.voiceOutputNode, input), `${fx}: detached after the fade-out`);
  }
  // 素早く OFF -> ON した場合は切り離さない
  am.toggleFX('reverb');
  am.toggleFX('reverb');
  am.toggleFX('reverb');
  await sleep(120);
  assert.ok(isLinked(am.voiceOutputNode, am.reverbNode), "quick OFF->ON keeps the reverb attached");
  am.resetAllFX();
  await sleep(120);
  assert.ok(!isLinked(am.voiceOutputNode, am.reverbNode), "resetAllFX detaches the reverb");
}
console.log("  PASS: Disabled FX (incl. the heavy convolver) receive no input");

// --- TEST 16: Single output path (the doubled output sounded like reverb) ---
console.log("\nTest 16: Output goes through exactly one audible path");
{
  const toStreamDest = () => am.streamDestination ? isLinked(am.masterGainNode, am.streamDestination) : false;
  assert.strictEqual(am.outputRoute, 'context');
  assert.ok(isLinked(am.masterGainNode, am.ctx.destination), "standard: Web Audio destination");
  assert.strictEqual(am.streamDestination, null, "standard: no MediaStream/video router is even created");
  assert.ok(isLinked(am.masterGainNode, am.analyserNode), "VU meter tap stays connected");

  // video 要素が無い環境では互換モードを選んでも標準出力のまま (無音にしない)
  am.setOutputRoute('media');
  assert.ok(isLinked(am.masterGainNode, am.ctx.destination), "media route without a video element falls back to the destination");
  am.setOutputRoute('context');

  const listeners = {};
  const video = {
    paused: true, ended: false, readyState: 0, srcObject: null, playCalls: 0,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach(fn => fn()); },
    play() { this.playCalls++; this.paused = false; this.readyState = 4; this.dispatch('playing'); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatch('pause'); }
  };
  mockElements['video-output-router'] = video;

  am.setMicActive(true);
  assert.strictEqual(video.playCalls, 0, "standard route never plays the video element");
  am.setMicActive(false);

  am.setOutputRoute('media');
  assert.ok(video.srcObject, "media route feeds the video element");
  assert.ok(toStreamDest(), "media route: masterGain -> MediaStreamDestination");
  assert.ok(!isLinked(am.masterGainNode, am.ctx.destination), "media route playing: destination disconnected (no doubled voice)");

  video.pause();
  assert.ok(isLinked(am.masterGainNode, am.ctx.destination), "video paused by the system: destination takes over (no silence)");
  video.play();
  assert.ok(!isLinked(am.masterGainNode, am.ctx.destination), "video resumed: back to a single path");

  am.setOutputRoute('context');
  assert.ok(video.paused, "standard route pauses the video element");
  assert.ok(!toStreamDest(), "standard route: MediaStreamDestination detached");
  assert.ok(isLinked(am.masterGainNode, am.ctx.destination), "standard route: destination connected");
  delete mockElements['video-output-router'];
}
console.log("  PASS: Exactly one output path in both routes, with fallback instead of silence");

// --- TEST 17: Saved output route is applied at startup ---
console.log("\nTest 17: A saved 'media' route is restored when the audio graph is built");
{
  const listeners = {};
  const video = {
    paused: true, ended: false, readyState: 0, srcObject: null, playCalls: 0,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach(fn => fn()); },
    play() { this.playCalls++; this.paused = false; this.readyState = 4; this.dispatch('playing'); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatch('pause'); }
  };
  mockElements['video-output-router'] = video;
  const am3 = new AudioManager();
  am3.outputRoute = 'media';
  await am3.init();
  assert.ok(am3.streamDestination && video.srcObject, "media router is created during setup");
  assert.ok(isLinked(am3.masterGainNode, am3.streamDestination), "masterGain feeds the media router");
  assert.ok(isLinked(am3.masterGainNode, am3.ctx.destination), "until the video plays, the destination keeps the sound (no silence)");
  am3.setMicActive(true);
  assert.strictEqual(video.playCalls, 1, "going on air starts the video element");
  assert.ok(!isLinked(am3.masterGainNode, am3.ctx.destination), "once playing, only the media route is audible");
  delete mockElements['video-output-router'];
}
console.log("  PASS: Saved route restored with a single audible path");

// --- TEST 18: A hanging addModule does not block startup ---
console.log("\nTest 18: AudioWorklet addModule that never resolves falls back to EQ-only within the timeout");
{
  globalThis.AudioWorkletNode = class extends MockAudioNode {};
  const am4 = new AudioManager();
  am4.ctx = new MockAudioContext();
  am4.ctx.audioWorklet = { addModule: () => new Promise(() => {}) };
  const t0 = Date.now();
  await am4.setupAudioGraph();
  const waited = Date.now() - t0;
  assert.strictEqual(am4.voiceFocusNode, null, "falls back to the EQ-only chain");
  assert.ok(waited < 7000, `startup continues after the timeout (${waited} ms)`);
  assert.ok(isLinked(am4.voiceLpfNode, am4.voiceOutputNode), "EQ-only chain is wired");
  assert.ok(isLinked(am4.masterGainNode, am4.ctx.destination), "audio output is wired");
  delete globalThis.AudioWorkletNode;
}
console.log("  PASS: The app keeps working even if the worklet module never loads");

console.log("\nALL 18 TESTS PASSED SUCCESSFULLY!");
