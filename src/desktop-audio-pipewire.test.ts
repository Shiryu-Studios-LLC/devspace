import assert from "node:assert/strict";
import test from "node:test";
import { normalizePipeWireAudioGraph, parsePipeWireTop } from "./desktop-audio-pipewire.js";

test("PipeWire audio graph includes non-invasive runtime control metadata", () => {
  const graph = normalizePipeWireAudioGraph([
    {
      id: 42,
      type: "PipeWire:Interface:Node",
      info: {
        state: "running",
        props: {
          "media.class": "Stream/Output/Audio",
          "node.name": "Example",
          "node.rate": "1/48000",
          "node.latency": "256/48000",
          "stream.is-live": true,
          "pulse.corked": false,
          "application.name": "Example App",
          "application.process.id": 1234,
        },
        params: {
          Props: [{
            volume: 0.75,
            mute: false,
            channelVolumes: [0.7, 0.8],
            channelMap: ["FL", "FR"],
            softMute: false,
            softVolumes: [1, 1],
            monitorMute: false,
            monitorVolumes: [1, 1],
          }],
          Format: [{ format: "F32LE", rate: 48000, channels: 2 }],
          ProcessLatency: [{ quantum: 64, rate: 48000, ns: 1333333 }],
        },
      },
    },
  ]);

  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(graph.nodes[0], {
    id: 42,
    name: "Example",
    mediaClass: "Stream/Output/Audio",
    state: "running",
    nick: undefined,
    description: undefined,
    applicationName: "Example App",
    applicationBinary: undefined,
    pid: 1234,
    clientId: undefined,
    deviceId: undefined,
    mediaName: undefined,
    targetObject: undefined,
    sampleRate: 48000,
    latency: "256/48000",
    volume: 0.75,
    mute: false,
    channelVolumes: [0.7, 0.8],
    channelMap: ["FL", "FR"],
    softMute: false,
    softVolumes: [1, 1],
    monitorMute: false,
    monitorVolumes: [1, 1],
    audioFormat: "F32LE",
    channels: 2,
    streamLive: true,
    corked: false,
    processLatencyQuantum: 64,
    processLatencyRate: 48000,
    processLatencyNs: 1333333,
    isStream: true,
    isSink: false,
    isSource: false,
  });
});

test("PipeWire runtime parser uses the last pw-top iteration and normalizes timing units", () => {
  const snapshot = parsePipeWireTop(`S   ID  QUANT   RATE    WAIT    BUSY   W/Q   B/Q  ERR FORMAT           NAME\nC  196      0      0    ---     ---   ---   ---     0                  plasmashell\nS   ID  QUANT   RATE    WAIT    BUSY   W/Q   B/Q  ERR FORMAT           NAME\nR  196    300  48000  19.5us   1.2ms  0.01  0.02   24    F32LE 2 48000  + plasmashell\nS  231      0      0    ---     ---   ---   ---     0                  shiryu.cable.1.input\n`, 2, () => Date.parse("2026-09-20T12:00:00.000Z"));
  assert.equal(snapshot.generatedAt, "2026-09-20T12:00:00.000Z");
  assert.equal(snapshot.samplingIterations, 2);
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(snapshot.nodes[0], {
    id: 196,
    stateCode: "R",
    running: true,
    quantum: 300,
    rate: 48000,
    waitUsec: 19.5,
    busyUsec: 1200,
    waitRatio: 0.01,
    busyRatio: 0.02,
    errors: 24,
    audioFormat: "F32LE",
    channels: 2,
    formatRate: 48000,
    name: "plasmashell",
  });
  assert.equal(snapshot.nodes[1]?.running, false);
  assert.equal(snapshot.nodes[1]?.name, "shiryu.cable.1.input");
});

test("PipeWire audio graph ignores malformed optional runtime metadata", () => {
  const graph = normalizePipeWireAudioGraph([
    {
      id: 7,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "media.class": "Audio/Sink",
          "node.name": "Sink",
        },
        params: {
          Props: [{
            volume: "loud",
            mute: "no",
            channelVolumes: [1, "bad"],
            channelMap: ["FL", 2],
          }],
          Format: [{ format: 123, channels: "2" }],
        },
      },
    },
  ]);

  const node = graph.nodes[0]!;
  assert.equal(node.volume, undefined);
  assert.equal(node.mute, undefined);
  assert.equal(node.channelVolumes, undefined);
  assert.equal(node.channelMap, undefined);
  assert.equal(node.audioFormat, undefined);
  assert.equal(node.channels, undefined);
});
