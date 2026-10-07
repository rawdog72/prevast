// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { Camera } from '../../core/camera';
import { createParticle, type Particle } from './particle';

export class ParticleSystem {
  private readonly pool: Particle[];
  private readonly maxParticles: number;

  constructor(maxParticles = 500) {
    this.maxParticles = maxParticles;
    this.pool = Array.from({ length: maxParticles }, () => createParticle());
  }

  get capacity(): number {
    return this.maxParticles;
  }

  private alloc(): Particle | null {
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].active) {
        return this.pool[i];
      }
    }
    return null;
  }

  spawnWoodDebris(x: number, y: number, count = 6): void {
    const colors = ['#854d0e', '#a16207', '#ca8a04'];
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 80;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = 3 + Math.random() * 4;
      p.color = colors[Math.floor(Math.random() * colors.length)];
      p.alpha = 1.0;
      p.decay = 1.2 + Math.random() * 0.8;
      p.rotation = Math.random() * Math.PI * 2;
      p.vrot = (Math.random() - 0.5) * 8;
      p.friction = 0.9;
      p.life = 0;
      p.maxLife = 1.0;
    }
  }

  spawnStoneDebris(x: number, y: number, count = 6): void {
    const colors = ['#64748b', '#94a3b8', '#475569'];
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 70;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = 3 + Math.random() * 3;
      p.color = colors[Math.floor(Math.random() * colors.length)];
      p.alpha = 1.0;
      p.decay = 1.5 + Math.random() * 0.8;
      p.rotation = Math.random() * Math.PI * 2;
      p.vrot = (Math.random() - 0.5) * 6;
      p.friction = 0.88;
      p.life = 0;
      p.maxLife = 0.8;
    }
  }

  spawnMetalSparks(x: number, y: number, count = 8): void {
    const colors = ['#fde047', '#f59e0b', '#fbbf24'];
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 120;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = 2 + Math.random() * 2;
      p.color = colors[Math.floor(Math.random() * colors.length)];
      p.alpha = 1.0;
      p.decay = 2.5 + Math.random() * 1.5;
      p.rotation = 0;
      p.vrot = 0;
      p.friction = 0.94;
      p.life = 0;
      p.maxLife = 0.5;
    }
  }

  spawnBlood(x: number, y: number, count = 6): void {
    const colors = ['#991b1b', '#b91c1c', '#7f1d1d'];
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 25 + Math.random() * 50;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = 3 + Math.random() * 4;
      p.color = colors[Math.floor(Math.random() * colors.length)];
      p.alpha = 0.9;
      p.decay = 0.8 + Math.random() * 0.4;
      p.rotation = 0;
      p.vrot = 0;
      p.friction = 0.82;
      p.life = 0;
      p.maxLife = 1.2;
    }
  }

  spawnExplosion(x: number, y: number, count = 30): void {
    const colors = ['#ea580c', '#f59e0b', '#f97316', '#78716c', '#44403c'];
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 160;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = 6 + Math.random() * 8;
      p.color = colors[Math.floor(Math.random() * colors.length)];
      p.alpha = 1.0;
      p.decay = 1.0 + Math.random() * 1.2;
      p.rotation = Math.random() * Math.PI * 2;
      p.vrot = (Math.random() - 0.5) * 4;
      p.friction = 0.85;
      p.life = 0;
      p.maxLife = 1.0;
    }
  }

  spawnFootprint(x: number, y: number, angle = 0): void {
    const p = this.alloc();
    if (!p) return;

    p.active = true;
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.size = 4;
    p.color = '#1e293b';
    p.alpha = 0.45;
    p.decay = 0.2;
    p.rotation = angle;
    p.vrot = 0;
    p.friction = 1.0;
    p.life = 0;
    p.maxLife = 3.0;
  }

  spawnBulletSmoke(x: number, y: number, angle = 0, count = 3): void {
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (!p) break;

      const spread = angle + (Math.random() - 0.5) * 0.4;
      const speed = 15 + Math.random() * 25;

      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(spread) * speed;
      p.vy = Math.sin(spread) * speed;
      p.size = 2 + Math.random() * 3;
      p.color = '#94a3b8';
      p.alpha = 0.6;
      p.decay = 1.8;
      p.rotation = Math.random() * Math.PI * 2;
      p.vrot = (Math.random() - 0.5) * 2;
      p.friction = 0.9;
      p.life = 0;
      p.maxLife = 0.5;
    }
  }

  getActiveCount(): number {
    let active = 0;
    for (const p of this.pool) {
      if (p.active) active++;
    }
    return active;
  }

  update(delta: number): void {
    const dt = delta / 1000;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.life += dt;
      p.alpha -= p.decay * dt;

      if (p.alpha <= 0 || p.life >= p.maxLife) {
        p.active = false;
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(p.friction, dt * 60);
      p.vy *= Math.pow(p.friction, dt * 60);
      p.rotation += p.vrot * dt;
    }
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const active = this.getActiveCount();
    if (active === 0) return;

    ctx.save();
    camera.applyTransform(ctx);

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      // Frustum culling
      if (!camera.isVisible(p.x, p.y, p.size * 2)) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx.translate(p.x, p.y);
      if (p.rotation !== 0) ctx.rotate(p.rotation);

      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }

    ctx.restore();
  }
}
