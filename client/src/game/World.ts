import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box, MapDef, MatId } from '@aimstrike/shared';
import type { Quality } from '../settings';

const TILE = 2; // metres per texture repeat

const PALETTE: Record<MatId, { base: string; line: string; speck: string; emissive?: number }> = {
  wall: { base: '#aeb4bd', line: '#8d949e', speck: '#9aa1ab' },
  concrete: { base: '#8f959c', line: '#6f757c', speck: '#7c8289' },
  crate: { base: '#b98a4e', line: '#7d5a2c', speck: '#a37840' },
  metal: { base: '#4f6b7c', line: '#354a57', speck: '#5d7b8d' },
  roof: { base: '#5a5f69', line: '#454a52', speck: '#50555e' },
  accentRed: { base: '#e5484d', line: '#b8383c', speck: '#ee5c60', emissive: 0x3a0d0f },
  accentBlue: { base: '#3b82f6', line: '#2a62c0', speck: '#5a98fa', emissive: 0x0b1d3d },
};

/** Procedural panel texture: flat colour, subtle speckle and a bevelled border. No image assets needed. */
function panelTexture(base: string, line: string, speck: string, style: 'panel' | 'planks' | 'grid'): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  g.fillStyle = speck;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
  g.strokeStyle = line;
  g.lineWidth = 3;
  if (style === 'panel') {
    g.strokeRect(1.5, 1.5, size - 3, size - 3);
  } else if (style === 'planks') {
    g.strokeRect(1.5, 1.5, size - 3, size - 3);
    g.lineWidth = 2;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (i * size) / 4); g.lineTo(size, (i * size) / 4); g.stroke(); }
    g.beginPath(); g.moveTo(8, 8); g.lineTo(size - 8, size - 8); g.stroke();
  } else {
    g.lineWidth = 2;
    g.strokeRect(1, 1, size - 2, size - 2);
    g.globalAlpha = 0.35;
    g.beginPath(); g.moveTo(size / 2, 0); g.lineTo(size / 2, size); g.moveTo(0, size / 2); g.lineTo(size, size / 2); g.stroke();
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Box geometry with UVs scaled to world size so textures tile uniformly on every surface. */
function boxGeometry(b: Box): THREE.BufferGeometry {
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const dims: Array<[number, number]> = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / TILE, (uv.getY(i) * dims[f][1]) / TILE);
    }
  }
  geo.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return geo;
}

/**
 * Static level rendering. All boxes sharing a material are merged into a single
 * mesh, so an entire map costs a handful of draw calls.
 */
export class World {
  readonly group = new THREE.Group();
  private readonly sun: THREE.DirectionalLight;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(scene: THREE.Scene, map: MapDef) {
    const byMat = new Map<MatId, THREE.BufferGeometry[]>();
    for (const b of map.boxes) {
      const list = byMat.get(b.mat) ?? [];
      list.push(boxGeometry(b));
      byMat.set(b.mat, list);
    }
    for (const [mat, geos] of byMat) {
      const p = PALETTE[mat];
      const tex = panelTexture(p.base, p.line, p.speck, mat === 'crate' ? 'planks' : mat === 'metal' ? 'grid' : 'panel');
      const material = new THREE.MeshLambertMaterial({ map: tex, emissive: p.emissive ?? 0x000000 });
      const merged = mergeGeometries(geos, false)!;
      for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = mat !== 'accentRed' && mat !== 'accentBlue';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.disposables.push(merged, material, tex);
    }

    // Floor
    const floorTex = panelTexture('#6d7480', '#596069', '#646b76', 'grid');
    floorTex.repeat.set((map.halfX * 2 + 1) / 4, (map.halfZ * 2 + 1) / 4);
    const floorGeo = new THREE.PlaneGeometry(map.halfX * 2 + 1, map.halfZ * 2 + 1);
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    this.disposables.push(floorGeo, floorMat, floorTex);

    // Team-tinted spawn zones so each side is recognisable at a glance.
    for (const team of ['red', 'blue'] as const) {
      const xs = map.spawns[team].map((s) => s.x);
      const x0 = team === 'red' ? -map.halfX : Math.min(...xs) - 2.5;
      const x1 = team === 'red' ? Math.max(...xs) + 2.5 : map.halfX;
      const geo = new THREE.PlaneGeometry(x1 - x0, map.halfZ * 2);
      const mat = new THREE.MeshBasicMaterial({ color: team === 'red' ? 0xe5484d : 0x3b82f6, transparent: true, opacity: 0.13, depthWrite: false });
      const zone = new THREE.Mesh(geo, mat);
      zone.rotation.x = -Math.PI / 2;
      zone.position.set((x0 + x1) / 2, 0.01, 0);
      this.group.add(zone);
      this.disposables.push(geo, mat);
    }

    // Lighting: sky/ground ambient plus one shadow-casting sun.
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x4a4f58, 1.25);
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
    this.sun.position.set(-18, 34, 14);
    const cam = this.sun.shadow.camera;
    const reach = Math.max(map.halfX, map.halfZ) + 6;
    cam.left = -reach; cam.right = reach; cam.top = reach; cam.bottom = -reach;
    cam.near = 1; cam.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.group.add(this.sun, this.sun.target);

    scene.background = new THREE.Color(0xa9c4e4);
    scene.fog = new THREE.Fog(0xa9c4e4, 60, 160);
    scene.add(this.group);
  }

  applyQuality(renderer: THREE.WebGLRenderer, quality: Quality): void {
    const shadows = quality !== 'low';
    renderer.shadowMap.enabled = shadows;
    renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = shadows;
    const size = quality === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    renderer.shadowMap.needsUpdate = true;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.sun.shadow.map?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
