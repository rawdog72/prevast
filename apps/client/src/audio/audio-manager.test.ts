// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { AudioManager } from './audio-manager';

function createMockAudioContext() {
  const destination = {} as AudioDestinationNode;
  const gainNodes: { gain: { value: number }; connect: (dest: unknown) => void }[] = [];
  const sources: {
    buffer: unknown;
    loop: boolean;
    connect: (dest: unknown) => void;
    start: () => void;
    stop: () => void;
    disconnect: () => void;
  }[] = [];

  const ctx = {
    destination,
    state: 'running',
    createGain: () => {
      const node = {
        gain: { value: 1 },
        connect: vi.fn(),
      };
      gainNodes.push(node);
      return node as unknown as GainNode;
    },
    createBufferSource: () => {
      const src = {
        buffer: null,
        loop: false,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(src);
      return src as unknown as AudioBufferSourceNode;
    },
    decodeAudioData: async () => ({ duration: 1.5 }) as AudioBuffer,
    resume: vi.fn(),
  } as unknown as AudioContext;

  return { ctx, gainNodes, sources };
}

describe('AudioManager', () => {
  it('initializes gain nodes and updates volume / mute', () => {
    const { ctx, gainNodes } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    expect(gainNodes).toHaveLength(4); // master, sfx, music, geiger

    manager.masterVolume = 0.5;
    manager.sfxVolume = 0.6;
    manager.setMuted(false);

    expect(manager.isMuted()).toBe(false);
    expect(gainNodes[0].gain.value).toBe(0.5);
    expect(gainNodes[1].gain.value).toBe(0.6);

    manager.setMuted(true);
    expect(manager.isMuted()).toBe(true);
    expect(gainNodes[0].gain.value).toBe(0);
  });

  it('calculates positional attenuation and skips out-of-range sounds', async () => {
    const { ctx, sources } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    // Mock fetch for sound file
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response);

    // Preload sound
    await manager.load('wood_impact');

    // 1. Play sound close to listener: distance 200, max 1000
    manager.playPositional('wood_impact', 200, 0, 0, 0, 1000, 1.0);
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalled();

    // 2. Play sound far away: distance 1500 > max 1000 -> should not play
    manager.playPositional('wood_impact', 1500, 0, 0, 0, 1000, 1.0);
    expect(sources).toHaveLength(1); // No new source created
  });

  it('plays and stops ambient looping track', async () => {
    const { ctx, sources } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response);

    await manager.load('ambient1');
    manager.playAmbient('ambient1');

    // Wait microtask for async load.then
    await Promise.resolve();

    expect(sources.length).toBeGreaterThan(0);
    const ambientSrc = sources[sources.length - 1];
    expect(ambientSrc.loop).toBe(true);

    manager.stopAmbient();
    expect(ambientSrc.stop).toHaveBeenCalled();
  });

  it('manages ambient playlist cycling and stops ambiance cleanly', async () => {
    const { ctx, sources } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response);

    manager.startAmbiance();
    await new Promise((r) => setTimeout(r, 10));

    expect(sources.length).toBeGreaterThan(0);
    manager.stopAmbiance();
    expect(sources[sources.length - 1].stop).toHaveBeenCalled();
  });

  it('scales radiation geiger counter volume based on radiation level', async () => {
    const { ctx, gainNodes } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    // 4 gain nodes: master, sfx, music, geiger
    expect(gainNodes).toHaveLength(4);
    const geigerGain = gainNodes[3];

    // Low / zero radiation: geiger muted
    manager.updateRadiation(0);
    expect(geigerGain.gain.value).toBe(0);

    // High radiation: geiger active with intensity
    manager.updateRadiation(150);
    expect(geigerGain.gain.value).toBeGreaterThan(0.5);

    manager.stopGeiger();
    expect(geigerGain.gain.value).toBe(0);
  });

  it('triggers gameplay sound effects without error', () => {
    const { ctx } = createMockAudioContext();
    const manager = new AudioManager({ audioContext: ctx });

    expect(() => {
      manager.playLevelUp();
      manager.playCraft();
      manager.playEat();
      manager.playDeath();
      manager.playEquip(true);
      manager.playEquip(false);
    }).not.toThrow();
  });
});
