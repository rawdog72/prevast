// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The start screen's music: title.mp3 on a loop while the screen is up. Browsers
// keep sound off until the page is touched, so it starts on the first click or
// key press, and fades out as the game comes up. The sound button beside it is
// the game's own sound switch (Options -> Sound, `prevast.options`), so muting
// here mutes the game too, and the other way round.
import type { AudioManager } from '../../audio/audio-manager';
import { readSetting, writeSetting } from '../../core/storage';
import { icon } from '../dom/icons';
import { parseOptions, serializeOptions, type OptionsSettings } from '../options-settings';

export const OPTIONS_SETTING = 'prevast.options';

export interface HomeMusicOptions {
  audio: AudioManager;
  /** Injected for tests. */
  win?: Window;
  read?: () => string | null;
  write?: (value: string) => void;
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown'] as const;

export class HomeMusic {
  private readonly audio: AudioManager;
  private readonly win: Window;
  private readonly read: () => string | null;
  private readonly write: (value: string) => void;
  /** The page has been touched, so the browser lets sound play. */
  private unlocked = false;
  private listening = false;
  /** The start screen is up and wants its music. */
  private wanted = false;
  private button: HTMLButtonElement | null = null;
  private readonly unlock = () => {
    this.unlocked = true;
    this.unlisten();
    this.audio.ensureContext();
    this.play();
  };

  constructor(options: HomeMusicOptions) {
    this.audio = options.audio;
    this.win = options.win ?? window;
    this.read = options.read ?? (() => readSetting(OPTIONS_SETTING));
    this.write = options.write ?? ((value) => writeSetting(OPTIONS_SETTING, value));
  }

  get muted(): boolean {
    return this.settings().audioMuted;
  }

  start(): void {
    this.wanted = true;
    this.apply();
    this.syncButton();
    if (this.unlocked) this.play();
    else this.listen();
  }

  stop(): void {
    this.wanted = false;
    this.unlisten();
    this.audio.stopAmbient();
  }

  /** The way into the game: the title loop fades rather than cuts. */
  fadeOut(ms: number): void {
    this.wanted = false;
    this.unlisten();
    this.audio.fadeOutAmbient(ms);
  }

  /** Flips the game-wide sound switch; returns whether sound is now off. */
  toggleMuted(): boolean {
    const settings = this.settings();
    settings.audioMuted = !settings.audioMuted;
    this.write(serializeOptions(settings));
    this.apply();
    if (settings.audioMuted) this.audio.stopAmbient();
    else if (this.unlocked) this.play();
    this.syncButton();
    return settings.audioMuted;
  }

  /** The sound button, in the start screen's top corner. */
  mountToggle(host: HTMLElement): HTMLButtonElement {
    const doc = host.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'dv-sound-toggle';
    button.addEventListener('click', () => this.toggleMuted());
    host.append(button);
    this.button = button;
    this.syncButton();
    return button;
  }

  private settings(): OptionsSettings {
    return parseOptions(this.read());
  }

  private apply(): void {
    const s = this.settings();
    this.audio.setMuted(s.audioMuted);
    this.audio.setMasterVolume(s.volumeMaster);
    this.audio.setMusicVolume(s.volumeMusic);
    this.audio.setSfxVolume(s.volumeSfx);
  }

  private play(): void {
    if (!this.wanted || this.muted || this.audio.ambientPlaying) return;
    this.audio.playAmbient('title');
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    for (const type of UNLOCK_EVENTS)
      this.win.addEventListener(type, this.unlock, { capture: true, passive: true });
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    for (const type of UNLOCK_EVENTS) this.win.removeEventListener(type, this.unlock, true);
  }

  private syncButton(): void {
    const button = this.button;
    if (!button) return;
    const muted = this.muted;
    button.innerHTML = icon(muted ? 'sound_off' : 'sound_on');
    button.setAttribute('aria-pressed', String(muted));
    const label = muted ? 'Turn sound on' : 'Turn sound off';
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}
