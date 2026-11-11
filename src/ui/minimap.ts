import type { Track } from '../sim/track';

/** A hazard on the map. */
interface Danger {
  x: number;
  z: number;
  visible: boolean;
}

interface Marker {
  x: number;
  z: number;
  heading: number;
  isPlayer: boolean;
}

/** Draws a route, its land, hazards and the ships on it, scaled to fit a canvas. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private scale = 1;
  private offsetX = 0;
  private offsetZ = 0;
  private track: Track | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, cssSize: number, cssHeight = cssSize) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = cssSize * ratio;
    canvas.height = cssHeight * ratio;
    this.size = Math.min(canvas.width, canvas.height);
    this.ctx = canvas.getContext('2d')!;
  }

  setTrack(track: Track): void {
    this.track = track;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of track.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = track.halfWidth + 120;
    const span = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
    this.scale = this.size / span;
    this.offsetX = (minX + maxX) / 2;
    this.offsetZ = (minZ + maxZ) / 2;
  }

  /** World to canvas. The view is from above with +Z up the screen, so +X runs to the left. */
  private px(x: number): number {
    return this.canvas.width / 2 - (x - this.offsetX) * this.scale;
  }

  private py(z: number): number {
    return this.canvas.height / 2 - (z - this.offsetZ) * this.scale;
  }

  draw(markers: Marker[] = [], nextCheckpoint = -1, dangers: Danger[] = []): void {
    const track = this.track;
    if (!track) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.fillStyle = 'rgba(190, 215, 200, 0.28)';
    for (const o of track.obstacles) {
      ctx.beginPath();
      ctx.arc(this.px(o.x), this.py(o.z), o.r * this.scale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineJoin = 'round';
    ctx.beginPath();
    track.samples.forEach((p, i) => {
      if (i === 0) ctx.moveTo(this.px(p.x), this.py(p.z));
      else ctx.lineTo(this.px(p.x), this.py(p.z));
    });
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(89, 216, 255, 0.35)';
    ctx.lineWidth = track.halfWidth * 2 * this.scale;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1.5, this.size / 150);
    ctx.stroke();

    // The start is a ring and the destination a filled dot.
    const start = track.samples[track.startIndex];
    const finish = track.samples[track.finishIndex];
    ctx.strokeStyle = '#ffd23f';
    ctx.fillStyle = '#ffd23f';
    ctx.lineWidth = this.size / 90;
    ctx.beginPath();
    ctx.arc(this.px(start.x), this.py(start.z), this.size / 36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.px(finish.x), this.py(finish.z), this.size / 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff5a4f';
    for (const danger of dangers) {
      if (!danger.visible) continue;
      const s = this.size / 46;
      ctx.save();
      ctx.translate(this.px(danger.x), this.py(danger.z));
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    }

    if (nextCheckpoint >= 0 && nextCheckpoint < track.checkpoints.length - 1) {
      const gate = track.samples[track.checkpoints[nextCheckpoint]];
      ctx.strokeStyle = '#59d8ff';
      ctx.lineWidth = this.size / 110;
      ctx.beginPath();
      ctx.arc(this.px(gate.x), this.py(gate.z), this.size / 32, 0, Math.PI * 2);
      ctx.stroke();
    }

    const dot = this.size / 44;
    for (const m of [...markers].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer))) {
      ctx.save();
      ctx.translate(this.px(m.x), this.py(m.z));
      // Heading 0 points along +Z, which is up the map; +X is to the left.
      ctx.rotate(-m.heading);
      ctx.fillStyle = m.isPlayer ? '#ffd23f' : '#ff5a4f';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const s = m.isPlayer ? dot * 1.5 : dot;
      ctx.moveTo(0, -s * 1.5);
      ctx.lineTo(s * 0.8, s);
      ctx.lineTo(-s * 0.8, s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
