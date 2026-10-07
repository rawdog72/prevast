// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { distance } from '../core/math2d';
import { SOUNDS, type SoundKey } from './sound-registry';

export interface AudioManagerOptions {
  audioContext?: AudioContext;
  basePath?: string;
}

export const AMBIENT_PLAYLIST: SoundKey[] = [
  'ambient1',
  'ambient2',
  'ambient3',
  'ambient4',
  'ambient5',
  'ambient6',
  'ambient7',
  'ambient8',
];

const MAX_SOUND_GAIN = 2;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private geigerGain: GainNode | null = null;

  private readonly basePath: string;
  // Keyed by file name: registry keys and content-named files share one cache.
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly loadingPromises = new Map<string, Promise<AudioBuffer | null>>();

  private currentAmbientSource: AudioBufferSourceNode | null = null;
  private currentGeigerSource: AudioBufferSourceNode | null = null;
  private ambientTrackIndex = 0;
  private ambientRunning = false;
  private muted = false;

  masterVolume = 1.0;
  sfxVolume = 0.8;
  musicVolume = 0.5;

  constructor(options: AudioManagerOptions = {}) {
    this.basePath = options.basePath ?? '/audio/';
    if (options.audioContext) {
      this.initContext(options.audioContext);
    }
  }

  private initContext(context?: AudioContext): void {
    if (this.ctx) return;

    const CtxClass =
      context?.constructor ??
      (typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : null);

    if (!CtxClass) return;

    this.ctx = context ?? new (CtxClass as typeof AudioContext)();
    this.masterGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.geigerGain = this.ctx.createGain();

    this.masterGain.connect(this.ctx.destination);
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.geigerGain.connect(this.sfxGain);

    this.updateGains();
  }

  ensureContext(): void {
    if (!this.ctx) {
      this.initContext();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private updateGains(): void {
    if (!this.masterGain || !this.sfxGain || !this.musicGain) return;
    this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    this.sfxGain.gain.value = this.sfxVolume;
    this.musicGain.gain.value = this.musicVolume;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.updateGains();
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
    this.updateGains();
  }

  setMusicVolume(volume: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    this.updateGains();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.updateGains();
  }

  isMuted(): boolean {
    return this.muted;
  }

  load(key: SoundKey): Promise<AudioBuffer | null> {
    const filename = SOUNDS[key];
    if (!filename) return Promise.resolve(null);
    return this.loadFile(filename);
  }

  /** Loads a file under the audio folder by name (e.g. 'ak47-shot.mp3'). */
  async loadFile(filename: string): Promise<AudioBuffer | null> {
    const cached = this.bufferCache.get(filename);
    if (cached) return cached;

    const existingPromise = this.loadingPromises.get(filename);
    if (existingPromise) return existingPromise;

    const promise = (async () => {
      this.ensureContext();
      if (!this.ctx) return null;

      try {
        const res = await fetch(`${this.basePath}${filename}`);
        if (!res.ok) return null;
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        this.bufferCache.set(filename, audioBuf);
        return audioBuf;
      } catch (err) {
        console.warn(`[audio] Failed to load sound '${filename}':`, err);
        return null;
      } finally {
        this.loadingPromises.delete(filename);
      }
    })();

    this.loadingPromises.set(filename, promise);
    return promise;
  }

  playUi(key: SoundKey, volume = 1.0): void {
    if (this.muted) return;
    this.playFile(SOUNDS[key], volume, 0);
  }

  playPositional(
    key: SoundKey,
    sourceX: number,
    sourceY: number,
    listenerX: number,
    listenerY: number,
    maxDistance = 1200,
    baseVolume = 1.0,
    delaySec = 0,
  ): void {
    this.playFileAt(
      SOUNDS[key],
      sourceX,
      sourceY,
      listenerX,
      listenerY,
      maxDistance,
      baseVolume,
      delaySec,
    );
  }

  /**
   * A sound in the world by file name, fading linearly to silence at
   * `maxDistance` (old AudioUtils.playFx). `delaySec` postpones the start, as
   * the old client did for a bow's or spear's release.
   */
  playFileAt(
    filename: string,
    sourceX: number,
    sourceY: number,
    listenerX: number,
    listenerY: number,
    maxDistance = 1200,
    baseVolume = 1.0,
    delaySec = 0,
  ): void {
    if (this.muted) return;
    const d = distance(sourceX, sourceY, listenerX, listenerY);
    if (d >= maxDistance) return;

    const gainFactor = Math.max(0, 1 - d / maxDistance) * baseVolume;
    if (gainFactor <= 0.01) return;

    this.playFile(filename, gainFactor, delaySec);
  }

  /** Fetches and decodes ahead of the first play, so that one is not late. */
  preload(filenames: Iterable<string>): void {
    for (const filename of filenames) void this.loadFile(filename);
  }

  private playFile(filename: string, volume: number, delaySec: number): void {
    this.ensureContext();
    if (!this.ctx || !this.sfxGain) return;

    const buf = this.bufferCache.get(filename);
    if (!buf) {
      void this.loadFile(filename).then((loaded) => {
        if (loaded && !this.muted && this.sfxGain)
          this.playBuffer(loaded, this.sfxGain, volume, delaySec);
      });
      return;
    }

    this.playBuffer(buf, this.sfxGain, volume, delaySec);
  }

  playAmbient(key: SoundKey): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.musicGain) return;

    this.stopAmbient();

    void this.load(key).then((buf) => {
      if (!buf || !this.ctx || !this.musicGain) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(this.musicGain);
      source.start(0);
      this.currentAmbientSource = source;
    });
  }

  startAmbiance(): void {
    this.ambientRunning = true;
    this.ambientTrackIndex = Math.floor(Math.random() * AMBIENT_PLAYLIST.length);
    this.playCurrentAmbient();
  }

  private playCurrentAmbient(): void {
    if (!this.ambientRunning || this.muted) return;
    const key = AMBIENT_PLAYLIST[this.ambientTrackIndex];

    this.ensureContext();
    if (!this.ctx || !this.musicGain) return;

    this.stopAmbient();

    void this.load(key).then((buf) => {
      if (!buf || !this.ctx || !this.musicGain || !this.ambientRunning) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = false; // Non-looping so tracks cycle through playlist
      source.onended = () => {
        if (this.ambientRunning) {
          this.ambientTrackIndex = (this.ambientTrackIndex + 1) % AMBIENT_PLAYLIST.length;
          this.playCurrentAmbient();
        }
      };
      source.connect(this.musicGain);
      source.start(0);
      this.currentAmbientSource = source;
    });
  }

  stopAmbient(): void {
    if (this.currentAmbientSource) {
      try {
        this.currentAmbientSource.stop();
        this.currentAmbientSource.disconnect();
      } catch {
        // Ignored
      }
      this.currentAmbientSource = null;
    }
  }

  stopAmbiance(): void {
    this.ambientRunning = false;
    this.stopAmbient();
  }

  /**
   * Updates radiation geiger counter sound based on radiation level (0..255).
   */
  updateRadiation(radLevel: number): void {
    if (this.muted || radLevel <= 10) {
      if (this.geigerGain) this.geigerGain.gain.value = 0;
      return;
    }

    this.ensureContext();
    if (!this.ctx || !this.geigerGain) return;

    const intensity = Math.min(1.0, (radLevel - 10) / 180) * 0.85;
    this.geigerGain.gain.value = intensity;

    if (!this.currentGeigerSource) {
      void this.load('geiger').then((buf) => {
        if (!buf || !this.ctx || !this.geigerGain) return;
        const source = this.ctx.createBufferSource();
        source.buffer = buf;
        source.loop = true;
        source.connect(this.geigerGain);
        source.start(0);
        this.currentGeigerSource = source;
      });
    }
  }

  stopGeiger(): void {
    if (this.currentGeigerSource) {
      try {
        this.currentGeigerSource.stop();
        this.currentGeigerSource.disconnect();
      } catch {
        // Ignored
      }
      this.currentGeigerSource = null;
    }
    if (this.geigerGain) {
      this.geigerGain.gain.value = 0;
    }
  }

  // Tactical gameplay audio triggers
  playLevelUp(): void {
    this.playUi('levelup');
  }

  playCraft(): void {
    this.playUi('craft');
  }

  playEat(): void {
    this.playUi('eat');
  }

  playDeath(): void {
    this.playUi('end');
  }

  playEquip(isEquipping = true): void {
    this.playUi(isEquipping ? 'zipper_on' : 'zipper_off');
  }

  private playBuffer(
    buffer: AudioBuffer,
    targetGain: GainNode,
    volume: number,
    delaySec = 0,
  ): void {
    if (!this.ctx) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const gain = this.ctx.createGain();
    // Old weapon volumes go past 1 (a bow is 1.4, a desert eagle 1.3).
    gain.gain.value = Math.max(0, Math.min(MAX_SOUND_GAIN, volume));

    source.connect(gain);
    gain.connect(targetGain);
    source.start(delaySec > 0 ? this.ctx.currentTime + delaySec : 0);
  }
}
