// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  decay: number;
  rotation: number;
  vrot: number;
  friction: number;
  life: number;
  maxLife: number;
  active: boolean;
}

export function createParticle(): Particle {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    size: 4,
    color: '#ffffff',
    alpha: 1.0,
    decay: 1.5,
    rotation: 0,
    vrot: 0,
    friction: 0.92,
    life: 0,
    maxLife: 1.0,
    active: false,
  };
}
