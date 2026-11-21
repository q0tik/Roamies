// Rainbow Crystal (Prism) look for Qbdy: a spinning 3D octahedron with rainbow LED facets.
// Uses the same interface as jarvis.js (level, body, cursor).
(() => {
  const R = window.Roamie;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const VERTS = [[0, -1.35, 0], [0, 1.35, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const EDGES = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [3, 4], [4, 5], [5, 2]];
  const FACES = [[0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 2], [1, 3, 2], [1, 4, 3], [1, 5, 4], [1, 2, 5]];

  function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)));
    };
    return [f(0), f(8), f(4)];
  }

  R.prism = {
    level(st) {
      const t = st.t;
      if (st.mode === 'talk' && st.voice != null) return clamp(0.3 + st.voice * 0.9, 0, 1);
      if (st.mode === 'talk') return clamp(0.45 + 0.35 * Math.abs(Math.sin(t * 11.3)), 0, 1);
      if (st.mode === 'listen') return clamp(st.heard ?? 0.4, 0, 1);
      if (st.mode === 'think') return 0.3;
      return 0.12 + 0.05 * Math.sin(t * 1.4);
    },

    body(k, cx, cy, rad, st) {
      const { put, setPx, L } = k, t = st.t;
      const v = this.level(st);
      const mode = st.mode, A = st.act;
      const spinRate = mode === 'think' ? 2.0 : A === 'hype' ? 3.2 : st.sleepy > 0.5 ? 0.15 : 0.7;
      st.spin = (st.spin ?? 0) + spinRate * (st.dt ?? 0.016);
      const yaw = st.spin + st.look[0] * 0.6;
      const pitch = -0.32 + st.look[1] * 0.3 + (st.dizzy > 0.5 ? Math.sin(t * 9) * 0.3 : 0);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const pulse = mode === 'talk' ? 1 + v * 0.14 : 1 + 0.03 * Math.sin(t * 2.2);
      const shake = A === 'upset' && st.actA % 0.9 < 0.32 ? Math.sin(t * 48) * 0.5 : 0;

      const rot = (p) => {
        const x = p[0] * cyw + p[2] * syw, z0 = -p[0] * syw + p[2] * cyw;
        return [x * rad * pulse, (p[1] * cp - z0 * sp) * rad * pulse, p[1] * sp + z0 * cp];
      };
      const pts = VERTS.map(rot);
      const upset = A === 'upset' || st.feel === 'angry' || st.feel === 'shout';

      for (let fi = 0; fi < FACES.length; fi++) {
        const [i0, i1, i2] = FACES[fi];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        const depth = (a[2] + b[2] + c[2]) / 3;
        if (depth < -0.2) continue;
        const baseHue = (fi * 45 + t * 55) % 360;
        const step = rad < 9 ? 0.18 : 0.12;
        for (let u = 0; u <= 1; u += step) {
          for (let w0 = 0; w0 <= 1 - u; w0 += step) {
            const w = 1 - u - w0;
            const px = cx + a[0] * u + b[0] * w0 + c[0] * w + shake;
            const py = cy + a[1] * u + b[1] * w0 + c[1] * w;
            const gx = Math.round(px), gy = Math.round(py);
            const hue = ((baseHue + (px + py) * 3) % 360 + 360) % 360;
            const rgb = upset ? [255, 110, 95] : hsl(hue, 0.92, depth > 0 ? 0.6 : 0.35);
            if (setPx) setPx(gx, gy, rgb); else put(gx, gy, depth > 0 ? 3 : 1);
          }
        }
      }

      for (const [i0, i1] of EDGES) {
        const a = pts[i0], b = pts[i1];
        const steps = rad < 9 ? 10 : 16;
        for (let i = 0; i <= steps; i++) {
          const f = i / steps;
          const gx = Math.round(cx + a[0] + (b[0] - a[0]) * f + shake);
          const gy = Math.round(cy + a[1] + (b[1] - a[1]) * f);
          const pz = a[2] + (b[2] - a[2]) * f;
          const rgb = upset ? [255, 200, 180] : hsl(((t * 85 + i * 16) % 360 + 360) % 360, 1, pz > 0 ? 0.78 : 0.45);
          if (setPx) setPx(gx, gy, rgb); else put(gx, gy, pz > 0 ? L : 2);
        }
      }
    },

    cursor(k, bx, by, ax, ay, st) {
      const { put, setPx, L } = k, t = st.t;
      const ptr = ['1....', '12...', '132..', '1432.', '14432', '1342.', '12.2.', '1...2'];
      for (let r = 0; r < ptr.length; r++) for (let c = 0; c < ptr[r].length; c++) {
        if (ptr[r][c] === '.') continue;
        const lv = +ptr[r][c];
        const rgb = hsl(((t * 100 + r * 28 + c * 20) % 360 + 360) % 360, 0.95, lv >= 3 ? 0.72 : 0.45);
        if (setPx) setPx(ax + c, ay + r, rgb); else put(ax + c, ay + r, lv === 4 ? L : lv);
      }
    },
  };
})();
