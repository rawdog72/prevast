// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { AudioManager } from '../../audio/audio-manager';
import { HomeMusic } from './home-music';

function fakeAudio() {
  let playing = false;
  return {
    setMuted: vi.fn(),
    setMasterVolume: vi.fn(),
    setMusicVolume: vi.fn(),
    setSfxVolume: vi.fn(),
    ensureContext: vi.fn(),
    playAmbient: vi.fn(() => (playing = true)),
    stopAmbient: vi.fn(() => (playing = false)),
    fadeOutAmbient: vi.fn(() => (playing = false)),
    get ambientPlaying() {
      return playing;
    },
  };
}

function setup(stored: string | null = null) {
  const audio = fakeAudio();
  let value = stored;
  const music = new HomeMusic({
    audio: audio as unknown as AudioManager,
    win: window,
    read: () => value,
    write: (v) => (value = v),
  });
  return { audio, music, stored: () => value };
}

describe('HomeMusic', () => {
  it('waits for the first touch of the page, then plays the title loop', () => {
    const { audio, music } = setup();
    music.start();
    expect(audio.playAmbient).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    expect(audio.ensureContext).toHaveBeenCalled();
    expect(audio.playAmbient).toHaveBeenCalledWith('title');
    music.stop();
  });

  it('plays straight away when the start screen comes back', () => {
    const { audio, music } = setup();
    music.start();
    window.dispatchEvent(new Event('keydown'));
    music.fadeOut(400);
    expect(audio.fadeOutAmbient).toHaveBeenCalledWith(400);
    audio.playAmbient.mockClear();
    music.start();
    expect(audio.playAmbient).toHaveBeenCalledWith('title');
    music.stop();
  });

  it('stays quiet when the game sound is off', () => {
    const { audio, music } = setup(JSON.stringify({ audioMuted: true }));
    music.start();
    window.dispatchEvent(new Event('pointerdown'));
    expect(audio.setMuted).toHaveBeenCalledWith(true);
    expect(audio.playAmbient).not.toHaveBeenCalled();
    music.stop();
  });

  it("the sound button flips the game's own sound setting", () => {
    const { audio, music, stored } = setup(JSON.stringify({ volumeMusic: 0.3 }));
    const button = music.mountToggle(document.body);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(stored()!)).toMatchObject({ audioMuted: true, volumeMusic: 0.3 });
    expect(audio.stopAmbient).toHaveBeenCalled();
    button.click();
    expect(JSON.parse(stored()!).audioMuted).toBe(false);
    button.remove();
  });
});
