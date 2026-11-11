import * as THREE from 'three';
import { HITBOXES, WEAPONS, type HitboxDef, type Team } from '@aimstrike/shared';
import { buildGun, disposeGun } from './GunModel';

const unit = new THREE.BoxGeometry(1, 1, 1);
const flashGeo = new THREE.PlaneGeometry(0.35, 0.35);
const TEAM_COLORS: Record<Team, { main: number; dark: number; glow: number }> = {
  red: { main: 0xe5484d, dark: 0x8f2a2e, glow: 0xff9a9d },
  blue: { main: 0x3b82f6, dark: 0x234f9c, glow: 0x9cc4ff },
};
export const teamColor = (team: Team) => TEAM_COLORS[team].main;

const HIP_Y = 0.85;
const SHOULDER_Y = 1.45;

function box(def: HitboxDef, mat: THREE.Material, pivotY = 0): THREE.Mesh {
  const m = new THREE.Mesh(unit, mat);
  m.scale.set(def.hx * 2, def.hy * 2, def.hz * 2);
  m.position.set(def.cx, def.cy - pivotY, def.cz);
  m.castShadow = true;
  return m;
}

function nameSprite(name: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const g = c.getContext('2d')!;
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(name, 128, 24);
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillText(name, 128, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1.5, 0.28, 1);
  sprite.position.y = 2.08;
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * Third-person character built box-for-box from the server's hitbox table, so
 * the model you aim at is the volume that registers hits.
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly headPivot = new THREE.Group();
  /** Weapon carried at the right hip so the arms stay inside their hitboxes. */
  private readonly gunMount = new THREE.Group();
  private readonly materials: THREE.MeshLambertMaterial[];
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private gun: THREE.Group | null = null;
  private weapon = -1;
  private tag: THREE.Sprite | null = null;
  private phase = 0;
  private flashT = 0;
  private wasProtected = false;

  constructor(readonly team: Team, name: string, showName: boolean) {
    const c = TEAM_COLORS[team];
    const main = new THREE.MeshLambertMaterial({ color: c.main, emissive: c.main, emissiveIntensity: 0.18 });
    const dark = new THREE.MeshLambertMaterial({ color: c.dark, emissive: c.dark, emissiveIntensity: 0.15 });
    const head = new THREE.MeshLambertMaterial({ color: 0xe8e2d8 });
    const visor = new THREE.MeshLambertMaterial({ color: c.glow, emissive: c.glow, emissiveIntensity: 0.7 });
    this.materials = [main, dark, head, visor];

    const by = (n: HitboxDef['name']) => HITBOXES.find((h) => h.name === n)!;
    this.root.add(box(by('torso'), main));

    this.headPivot.position.y = 1.48;
    const headDef = by('head');
    this.headPivot.add(box(headDef, head, 1.48));
    const v = new THREE.Mesh(unit, visor);
    v.scale.set(headDef.hx * 1.7, 0.07, 0.02);
    v.position.set(0, headDef.cy - 1.48 + 0.03, -headDef.hz - 0.005);
    this.headPivot.add(v);
    this.root.add(this.headPivot);

    this.legL.position.y = HIP_Y;
    this.legL.add(box(by('legL'), dark, HIP_Y), box(by('footL'), main, HIP_Y));
    this.legR.position.y = HIP_Y;
    this.legR.add(box(by('legR'), dark, HIP_Y), box(by('footR'), main, HIP_Y));
    this.armL.position.y = SHOULDER_Y;
    this.armL.add(box(by('armL'), dark, SHOULDER_Y));
    this.armR.position.y = SHOULDER_Y;
    this.armR.add(box(by('armR'), dark, SHOULDER_Y));
    this.root.add(this.legL, this.legR, this.armL, this.armR);

    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flash = new THREE.Mesh(flashGeo, this.flashMat);
    this.flash.visible = false;
    this.gunMount.position.set(0.3, 0.98, -0.1);
    this.gunMount.add(this.flash);
    this.root.add(this.gunMount);

    if (showName) {
      this.tag = nameSprite(name, c.glow);
      this.root.add(this.tag);
    }
    this.root.visible = false;
  }

  private setWeapon(weapon: number): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    if (this.gun) { this.gunMount.remove(this.gun); disposeGun(this.gun); }
    this.gun = buildGun(WEAPONS[weapon]);
    this.gun.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    this.gunMount.add(this.gun);
    this.flash.position.set(0, 0.075, -(this.gun.userData.muzzle as number) - 0.12);
  }

  /** Brief muzzle flash when this player fires. */
  fire(): void {
    this.flashT = 0.05;
    this.flash.rotation.z = Math.random() * Math.PI;
  }

  update(
    x: number, y: number, z: number, yaw: number, pitch: number,
    speed: number, onGround: boolean, isProtected: boolean, weapon: number, dt: number,
  ): void {
    this.root.visible = true;
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    this.setWeapon(weapon);

    // Run cycle: legs swing with speed, eased back to rest when standing or airborne.
    const moving = onGround && speed > 0.6;
    if (moving) this.phase += dt * (4 + speed * 1.7);
    const amp = moving ? Math.min(0.5, speed * 0.1) : 0;
    const swing = Math.sin(this.phase) * amp;
    const k = Math.min(1, dt * 14);
    this.legL.rotation.x += (swing - this.legL.rotation.x) * k;
    this.legR.rotation.x += (-swing - this.legR.rotation.x) * k;
    this.armL.rotation.x += (-swing * 0.6 - this.armL.rotation.x) * k;
    this.armR.rotation.x += (swing * 0.3 - this.armR.rotation.x) * k;
    // The weapon and head tilt toward where the player is aiming.
    this.gunMount.rotation.x = pitch;
    this.headPivot.rotation.x = pitch * 0.6;

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.visible = true;
      this.flashMat.opacity = Math.max(0, this.flashT / 0.05);
    } else if (this.flash.visible) this.flash.visible = false;

    if (isProtected !== this.wasProtected) {
      this.wasProtected = isProtected;
      for (const m of this.materials) {
        m.transparent = isProtected;
        m.opacity = isProtected ? 0.45 : 1;
        m.needsUpdate = true;
      }
    }
  }

  hide(): void {
    this.root.visible = false;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.flashMat.dispose();
    if (this.gun) disposeGun(this.gun);
    if (this.tag) {
      this.tag.material.map?.dispose();
      this.tag.material.dispose();
    }
  }
}
