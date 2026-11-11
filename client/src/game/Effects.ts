import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_PARTICLES = 320;
const TRACER_LIFE = 0.11;

interface Tracer {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
}

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const zAxis = new THREE.Vector3(0, 0, 1);
const tmpDir = new THREE.Vector3();

/**
 * Pooled visual effects. Nothing here allocates during play: tracers recycle a
 * fixed ring of meshes and every particle is one instance of a single
 * InstancedMesh (one draw call for all sparks and elimination bursts).
 */
export class Effects {
  private readonly tracers: Tracer[] = [];
  private tracerIdx = 0;
  private readonly tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly particles: THREE.InstancedMesh;
  private readonly pGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly pMat = new THREE.MeshBasicMaterial();
  private readonly px = new Float32Array(MAX_PARTICLES * 3);
  private readonly pv = new Float32Array(MAX_PARTICLES * 3);
  private readonly pLife = new Float32Array(MAX_PARTICLES);
  private readonly pMax = new Float32Array(MAX_PARTICLES);
  private readonly pSize = new Float32Array(MAX_PARTICLES);
  private readonly pGrav = new Float32Array(MAX_PARTICLES);
  private pIdx = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, mat, life: 0 });
    }
    this.particles = new THREE.InstancedMesh(this.pGeo, this.pMat, MAX_PARTICLES);
    this.particles.frustumCulled = false;
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tmpMat.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.setMatrixAt(i, tmpMat);
      this.particles.setColorAt(i, tmpColor.set(0xffffff));
    }
    scene.add(this.particles);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): void {
    const t = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % MAX_TRACERS;
    tmpDir.set(bx - ax, by - ay, bz - az);
    const len = tmpDir.length();
    if (len < 0.5) return;
    t.mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    t.mesh.quaternion.setFromUnitVectors(zAxis, tmpDir.multiplyScalar(1 / len));
    t.mesh.scale.set(0.022, 0.022, len);
    t.mat.color.set(color);
    t.mat.opacity = 0.85;
    t.mesh.visible = true;
    t.life = TRACER_LIFE;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grav: number, color: number): void {
    const i = this.pIdx;
    this.pIdx = (this.pIdx + 1) % MAX_PARTICLES;
    this.px[i * 3] = x; this.px[i * 3 + 1] = y; this.px[i * 3 + 2] = z;
    this.pv[i * 3] = vx; this.pv[i * 3 + 1] = vy; this.pv[i * 3 + 2] = vz;
    this.pLife[i] = life; this.pMax[i] = life; this.pSize[i] = size; this.pGrav[i] = grav;
    this.particles.setColorAt(i, tmpColor.set(color));
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  /** Sparks and dust where a bullet meets a surface. */
  impact(x: number, y: number, z: number, color = 0xd8d2c4): void {
    for (let i = 0; i < 5; i++) {
      this.spawn(x, y, z, (Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3, 0.22 + Math.random() * 0.15, 0.035, 9, color);
    }
  }

  /** Small team-coloured flecks confirming a hit on a player (deliberately non-graphic). */
  hitSpark(x: number, y: number, z: number, color: number): void {
    for (let i = 0; i < 6; i++) {
      this.spawn(x, y, z, (Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4, 0.25, 0.04, 6, color);
    }
  }

  /** Elimination: the player dissolves into rising team-coloured cubes. */
  eliminate(x: number, y: number, z: number, color: number): void {
    for (let i = 0; i < 36; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.3;
      this.spawn(
        x + Math.cos(a) * r, y + 0.2 + Math.random() * 1.5, z + Math.sin(a) * r,
        Math.cos(a) * (0.6 + Math.random() * 1.8), 1.2 + Math.random() * 2.6, Math.sin(a) * (0.6 + Math.random() * 1.8),
        0.7 + Math.random() * 0.5, 0.07 + Math.random() * 0.07, 2.5, i % 5 === 0 ? 0xffffff : color,
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracers[i];
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.mesh.visible = false; continue; }
      t.mat.opacity = 0.85 * (t.life / TRACER_LIFE);
    }
    let dirty = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      dirty = true;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) {
        tmpMat.makeScale(0, 0, 0);
        this.particles.setMatrixAt(i, tmpMat);
        continue;
      }
      const j = i * 3;
      this.pv[j + 1] -= this.pGrav[i] * dt;
      this.px[j] += this.pv[j] * dt;
      this.px[j + 1] = Math.max(0.02, this.px[j + 1] + this.pv[j + 1] * dt);
      this.px[j + 2] += this.pv[j + 2] * dt;
      const s = this.pSize[i] * (this.pLife[i] / this.pMax[i]);
      tmpMat.compose(tmpPos.set(this.px[j], this.px[j + 1], this.px[j + 2]), tmpQuat.identity(), tmpScale.set(s, s, s));
      this.particles.setMatrixAt(i, tmpMat);
    }
    if (dirty) this.particles.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const t of this.tracers) { this.scene.remove(t.mesh); t.mat.dispose(); }
    this.scene.remove(this.particles);
    this.tracerGeo.dispose();
    this.pGeo.dispose();
    this.pMat.dispose();
    this.particles.dispose();
  }
}
