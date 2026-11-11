import * as THREE from 'three';
import { WEAPONS, type SimState } from '@aimstrike/shared';
import { buildGun, disposeGun } from './GunModel';

const BASE = new THREE.Vector3(0.125, -0.125, -0.4);
const SCALE = 0.62;

/**
 * First-person weapon, drawn in its own scene with a fixed FOV on top of the
 * world so it never clips into walls and is unaffected by the player's FOV.
 * All motion here is cosmetic; it never moves the crosshair.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.01, 10);
  private readonly holder = new THREE.Group();
  private readonly guns: THREE.Group[];
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly flashGeo = new THREE.PlaneGeometry(0.22, 0.22);
  private readonly sleeveMat = new THREE.MeshLambertMaterial({ color: 0x39404d });
  private readonly gloveMat = new THREE.MeshLambertMaterial({ color: 0x15171c });
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private current = -1;
  private kick = 0;
  private flashT = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private swayX = 0;
  private swayY = 0;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x555a66, 1.7));
    const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
    key.position.set(-1, 2, 1.5);
    this.scene.add(key);
    this.holder.scale.setScalar(SCALE);
    this.scene.add(this.holder);

    this.guns = WEAPONS.map((w) => {
      const g = buildGun(w, true);
      g.visible = false;
      this.holder.add(g);
      return g;
    });

    // Simple forearm + glove so the weapon is visibly held.
    const sleeve = new THREE.Mesh(this.boxGeo, this.sleeveMat);
    sleeve.scale.set(0.07, 0.07, 0.3);
    sleeve.position.set(0.05, -0.17, 0.2);
    sleeve.rotation.set(0.5, -0.25, 0);
    const glove = new THREE.Mesh(this.boxGeo, this.gloveMat);
    glove.scale.set(0.065, 0.08, 0.07);
    glove.position.set(0.004, -0.055, 0.035);
    this.holder.add(sleeve, glove);

    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    this.flash = new THREE.Mesh(this.flashGeo, this.flashMat);
    this.flash.visible = false;
    this.holder.add(this.flash);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Distance from the eye to the muzzle, for starting tracers at the barrel. */
  get muzzleDistance(): number {
    return this.current >= 0 ? (this.guns[this.current].userData.muzzle as number) * SCALE + 0.42 : 0.8;
  }

  onShot(weapon: number): void {
    const r = WEAPONS[weapon].recoil.vertical;
    this.kick = Math.min(1.6, this.kick + 0.35 + r * 22);
    this.flashT = 0.045;
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = 0.8 + Math.random() * 0.5;
    this.flash.scale.set(s, s, s);
  }

  update(sim: SimState, dt: number, speed: number, mouseDx: number, mouseDy: number, bobEnabled: boolean, visible: boolean): void {
    this.holder.visible = visible;
    if (!visible) return;
    if (sim.weapon !== this.current) {
      if (this.current >= 0) this.guns[this.current].visible = false;
      this.current = sim.weapon;
      this.guns[this.current].visible = true;
      this.flash.position.set(0, 0.075, -(this.guns[this.current].userData.muzzle as number) - 0.06);
      this.kick = 0;
    }
    const def = WEAPONS[sim.weapon];

    // Draw animation: the weapon rises into view over its equip time.
    const equip = def.equipTime > 0 ? sim.equip / def.equipTime : 0;
    // Reload: dip and roll, eased in and out across the reload duration.
    const reload = sim.reload > 0 ? Math.sin(Math.PI * Math.min(1, (def.reloadTime - sim.reload) / def.reloadTime)) : 0;
    const reloadSnap = Math.min(1, reload * 2.2);

    this.kick += (0 - this.kick) * Math.min(1, dt * 13);

    const moving = sim.onGround && speed > 0.5;
    this.bobAmp += ((moving && bobEnabled ? Math.min(1, speed / 5) : 0) - this.bobAmp) * Math.min(1, dt * 8);
    if (moving) this.bobPhase += dt * (5 + speed * 1.3);

    // Weapon sway lags slightly behind the mouse.
    const k = Math.min(1, dt * 10);
    this.swayX += (Math.max(-1, Math.min(1, mouseDx * 0.004)) - this.swayX) * k;
    this.swayY += (Math.max(-1, Math.min(1, mouseDy * 0.004)) - this.swayY) * k;

    const h = this.holder;
    h.position.set(
      BASE.x + Math.cos(this.bobPhase) * 0.006 * this.bobAmp - this.swayX * 0.012,
      BASE.y - equip * 0.3 - reloadSnap * 0.11 + Math.abs(Math.sin(this.bobPhase)) * 0.007 * this.bobAmp + this.swayY * 0.012 + (sim.onGround ? 0 : 0.008),
      BASE.z + this.kick * 0.045 + reloadSnap * 0.03,
    );
    h.rotation.set(
      this.kick * 0.055 - equip * 0.9 - reloadSnap * 0.35 + this.swayY * 0.03,
      0.03 - this.swayX * 0.05 + reloadSnap * 0.25,
      reloadSnap * 0.55,
    );

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.visible = true;
      this.flashMat.opacity = Math.max(0, this.flashT / 0.045);
    } else if (this.flash.visible) this.flash.visible = false;
  }

  dispose(): void {
    for (const g of this.guns) disposeGun(g);
    this.flashMat.dispose();
    this.flashGeo.dispose();
    this.sleeveMat.dispose();
    this.gloveMat.dispose();
    this.boxGeo.dispose();
  }
}
