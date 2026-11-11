import * as THREE from 'three';
import type { WeaponDef } from '@aimstrike/shared';

const unit = new THREE.BoxGeometry(1, 1, 1);

function part(mat: THREE.Material, w: number, h: number, l: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(unit, mat);
  m.scale.set(w, h, l);
  m.position.set(x, y, z);
  return m;
}

/**
 * Builds an original low-poly weapon from its visual profile. The model points
 * down -Z with the grip at the origin. `userData.muzzle` is the muzzle distance.
 */
export function buildGun(def: WeaponDef, firstPerson = false): THREE.Group {
  const v = def.visual;
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: v.body });
  const dark = new THREE.MeshLambertMaterial({ color: firstPerson ? 0x2b303b : 0x15171c });
  const accent = new THREE.MeshLambertMaterial({ color: v.accent, emissive: v.accent, emissiveIntensity: 0.35 });
  const [len, h, w] = v.receiver;
  const front = -len + 0.12;

  g.add(part(body, w, h, len, 0, 0.06, front / 2 + 0.06));
  g.add(part(dark, w * 0.45, w * 0.45, v.barrel, 0, 0.075, front - v.barrel / 2));
  g.add(part(dark, w * 0.75, w * 0.75, 0.05, 0, 0.075, front - v.barrel + 0.02));
  // In first person the stock sits against the shoulder, out of view; drawing it would only block the screen.
  if (!firstPerson) {
    g.add(part(body, w * 0.8, h * 0.8, v.stock, 0, 0.04, 0.12 + v.stock / 2));
    g.add(part(dark, w * 0.9, h * 1.15, 0.03, 0, 0.03, 0.12 + v.stock));
  } else {
    g.add(part(body, w * 0.8, h * 0.8, 0.1, 0, 0.045, 0.16));
  }
  g.add(part(dark, w * 0.8, 0.11, 0.045, 0, -0.04, 0.02).rotateX(0.25));
  g.add(part(dark, w * 0.85, v.mag[1], v.mag[0], 0, 0.06 - h / 2 - v.mag[1] / 2 + 0.01, front * 0.42).rotateX(-0.12));
  g.add(part(accent, w * 1.04, h * 0.22, len * 0.5, 0, 0.06, front * 0.55));
  g.add(part(dark, w * 0.3, 0.03, 0.02, 0, 0.06 + h / 2 + 0.012, front + 0.03));
  if (v.scope) {
    g.add(part(dark, 0.035, 0.035, 0.2, 0, 0.06 + h / 2 + 0.035, front * 0.5));
    g.add(part(accent, 0.03, 0.03, 0.01, 0, 0.06 + h / 2 + 0.035, front * 0.5 - 0.1));
  } else {
    g.add(part(dark, w * 0.3, 0.025, 0.02, 0, 0.06 + h / 2 + 0.01, 0.02));
  }
  g.userData.muzzle = -front + v.barrel;
  g.userData.materials = [body, dark, accent];
  return g;
}

export function disposeGun(g: THREE.Group): void {
  for (const m of g.userData.materials as THREE.Material[]) m.dispose();
}
