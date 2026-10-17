/* 드럼 악보 PDF → 루디트레이너 곡 파일
 * Finale 같은 악보 프로그램이 만든 '벡터 PDF'를 읽어요 (사진·스캔 PDF는 못 읽어요).
 * 음표 머리는 악보 글꼴(Maestro, MaestroPercussion 등)의 글자, 오선·마디줄은 선으로 들어 있어서
 *  - 높이(오선 위 위치) → 악기
 *  - 마디 안 가로 위치 → 박자 위치 (이런 악보는 마디 안에서 시간에 비례해 음표를 배치해요)
 * 로 바꿔요. 브라우저(pdf.js)와 Node 둘 다에서 돌아가요.
 */
(function (root) {
  'use strict';

  // 오선 맨 윗줄에서 반 칸씩 센 위치 → 악기 (Finale 기본 드럼 배치)
  // mode: 악보의 글자 지시('Ride →', 'Open H.H →')로 정해진 심벌. ride면 크래시 자리(-3) 아래의 X는 라이드
  function instrumentFor(kind, step, mode) {
    if (kind === 'x') {
      if (step <= -3) return 'cr';
      if (mode === 'ride') return 'rd';
      if (step === -2) return 'cr';
      if (step === -1) return 'hh';
      if (step === 0) return 'rd';
      return 'hh';
    }
    if (kind === 'cx') return step <= -1 ? 'cr' : 'hh'; // 동그라미 X
    if (step <= 1) return 't1';
    if (step === 2) return 't2';
    if (step === 3) return 'sd';
    if (step === 4) return 't2';
    if (step <= 6) return 'ft';
    return 'bd';
  }

  // 악보 글꼴 글자 분류
  const HEAD_FILLED = new Set([0x153, 0xcf, 0x77, 0xf0cf]);      // 채운 머리(œ), 반음표·온음표 머리
  const HEAD_X = new Set([0x79, 0xc0, 0xf079]);                   // X 머리
  const HEAD_CX = new Set([0x59, 0xc4, 0xc3, 0xf0c4]);            // 동그라미 X (Y)
  const RESTS = new Set([0x152, 0x2030, 0x2248, 0xae, 0x2211, 0xd3, 0xee, 0xb7, 0xf0b7, 0xf0d3, 0xf0ee, 0xf0ae]);
  const REPEAT2 = new Set([0xf0c7]);                               // 2마디 반복 기호
  const REPEAT1 = new Set([0xd4, 0xf0d4, 0x25]);                   // 1마디 반복 기호

  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // 한 페이지의 글자(정확한 위치)와 선분을 모아요
  async function readPage(pdfjs, page) {
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const O = pdfjs.OPS;
    const glyphs = [], segs = [], curves = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    // 글자 상태
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], font = null, fontName = '', size = 1, tc = 0, tw = 0, th = 1, leading = 0, rise = 0;
    const fontNames = {};
    const nameOf = id => {
      if (!(id in fontNames)) { try { const f = page.commonObjs.get(id); fontNames[id] = { name: (f && f.name) || '', fm: (f && f.fontMatrix) || [0.001] }; } catch (e) { fontNames[id] = { name: '', fm: [0.001] }; } }
      return fontNames[id];
    };
    const toTop = (x, y) => { const p = vp.convertToViewportPoint(x, y); return { x: p[0], y: p[1] }; };
    const moveText = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice(); };
    const show = arr => {
      const fm = font ? font.fm[0] : 0.001;
      for (const g of arr) {
        if (typeof g === 'number') { tm = mul([1, 0, 0, 1, -g / 1000 * size * th, 0], tm); continue; }
        if (!g) continue;
        const code = g.unicode ? g.unicode.codePointAt(0) : 0;
        if (code && code !== 0x20 && font) {
          const m = mul(tm, ctm);
          const [dx, dy] = apply(m, 0, rise);
          const p = toTop(dx, dy);
          glyphs.push({ code, ch: g.unicode, font: font.name, size: size * Math.hypot(m[0], m[1]), x: p.x, y: p.y });
        }
        const adv = (g.width * fm * size + tc + (g.isSpace ? tw : 0)) * th;
        tm = mul([1, 0, 0, 1, adv, 0], tm);
      }
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      switch (fn) {
        case O.save: stack.push(ctm.slice()); break;
        case O.restore: if (stack.length) ctm = stack.pop(); break;
        case O.transform: ctm = mul(a, ctm); break;
        case O.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case O.setFont: font = nameOf(a[0]); fontName = font.name; size = a[1]; break;
        case O.setTextMatrix: tm = a.slice(0, 6); tlm = tm.slice(); break;
        case O.moveText: moveText(a[0], a[1]); break;
        case O.setLeadingMoveText: leading = -a[1]; moveText(a[0], a[1]); break;
        case O.setLeading: leading = a[0]; break;
        case O.nextLine: moveText(0, -leading); break;
        case O.setCharSpacing: tc = a[0]; break;
        case O.setWordSpacing: tw = a[0]; break;
        case O.setHScale: th = a[0] / 100; break;
        case O.setTextRise: rise = a[0]; break;
        case O.showText: case O.showSpacedText: show(a[0]); break;
        case O.nextLineShowText: moveText(0, -leading); show(a[0]); break;
        case O.nextLineSetSpacingShowText: tw = a[0]; tc = a[1]; moveText(0, -leading); show(a[2]); break;
        case O.constructPath: {
          const [pops, coords] = a;
          let k = 0, cx = 0, cy = 0, sx = 0, sy = 0;
          const P = (x, y) => { const [u, v] = apply(ctm, x, y); return toTop(u, v); };
          for (const op of pops) {
            if (op === O.moveTo) { cx = coords[k++]; cy = coords[k++]; sx = cx; sy = cy; }
            else if (op === O.lineTo) { const nx = coords[k++], ny = coords[k++]; segs.push([P(cx, cy), P(nx, ny)]); cx = nx; cy = ny; }
            else if (op === O.curveTo) { k += 4; const nx = coords[k++], ny = coords[k++]; curves.push([P(cx, cy), P(nx, ny)]); cx = nx; cy = ny; }
            else if (op === O.curveTo2 || op === O.curveTo3) { k += 2; const nx = coords[k++], ny = coords[k++]; curves.push([P(cx, cy), P(nx, ny)]); cx = nx; cy = ny; }
            else if (op === O.rectangle) {
              const x = coords[k++], y = coords[k++], w = coords[k++], h = coords[k++];
              const p1 = P(x, y), p2 = P(x + w, y + h);
              segs.push([p1, p2, 'rect']);
            } else if (op === O.closePath) { cx = sx; cy = sy; }
          }
          break;
        }
      }
    }
    // pdf.js가 텍스트 항목으로만 주는 숫자(템포 등)도 함께
    const tc2 = await page.getTextContent();
    const texts = tc2.items.filter(it => it.str && it.str.trim()).map(it => {
      const p = toTop(it.transform[4], it.transform[5]);
      return { str: it.str, x: p.x, y: p.y, w: it.width };
    });
    return { glyphs, segs, curves, texts, width: vp.width, height: vp.height };
  }

  // 길게 가로지르는 가로줄 5개(간격 일정) = 오선
  function findStaves(segs) {
    const hs = [];
    for (const s of segs) {
      const [a, b] = s;
      if (s[2] === 'rect') {
        if (Math.abs(a.y - b.y) < 1.2 && Math.abs(a.x - b.x) > 80) hs.push({ y: (a.y + b.y) / 2, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x) });
      } else if (Math.abs(a.y - b.y) < 0.3 && Math.abs(a.x - b.x) > 80) hs.push({ y: (a.y + b.y) / 2, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x) });
    }
    hs.sort((p, q) => p.y - q.y);
    const ys = [];
    for (const h of hs) { const last = ys[ys.length - 1]; if (last && Math.abs(last.y - h.y) < 0.4) { last.x0 = Math.min(last.x0, h.x0); last.x1 = Math.max(last.x1, h.x1); } else ys.push({ ...h }); }
    const staves = [];
    for (let i = 0; i + 4 < ys.length; i++) {
      const g = ys.slice(i, i + 5), sp = (g[4].y - g[0].y) / 4;
      if (sp < 3 || sp > 14) continue;
      if (g.every((l, k) => Math.abs(l.y - (g[0].y + k * sp)) < sp * 0.12)) {
        staves.push({ top: g[0].y, bottom: g[4].y, sp, x0: Math.max(...g.map(l => l.x0)), x1: Math.min(...g.map(l => l.x1)) });
        i += 4;
      }
    }
    return staves;
  }

  // 오선 위아래를 꽉 채우는 세로줄 = 마디줄
  function findBarlines(staff, segs) {
    const xs = [];
    for (const s of segs) {
      const [a, b] = s;
      const x = (a.x + b.x) / 2, yTop = Math.min(a.y, b.y), yBot = Math.max(a.y, b.y), w = Math.abs(a.x - b.x);
      if (w > 4) continue;
      if (x < staff.x0 - 2 || x > staff.x1 + 2) continue;
      if (Math.abs(yTop - staff.top) < staff.sp * 0.35 && Math.abs(yBot - staff.bottom) < staff.sp * 0.35) xs.push(x);
    }
    xs.sort((p, q) => p - q);
    const out = [];
    for (const x of xs) { if (out.length && x - out[out.length - 1] < staff.sp * 1.6) out[out.length - 1] = x; else out.push(x); }
    return out;
  }

  // 음표 x좌표 → 마디 안 위치(48분의 몇).
  // 악보 프로그램은 마디 안에서 거의 시간에 비례해 배치하지만 끝 여백이 조금씩 달라서,
  // 가장 단순한 박자 격자(8분 → 16분 → 셋잇단 …)부터 간격 배율을 ±10% 움직여 가며 딱 맞는 것을 찾아요
  function fitPositions(xs, x0, unit) {
    if (!xs.length) return { p48: [], fuzzy: false };
    for (const G of [4, 8, 16, 12, 24, 48]) {
      let best = null;
      for (let s = 0.9; s <= 1.1001; s += 0.0025) {
        const pos = xs.map(x => (x - x0) / (unit * s) * G / 4);
        if (pos.some(p => p > G - 0.5)) continue;
        const res = Math.max(...pos.map(p => Math.abs(p - Math.round(p))));
        if (!best || res < best.res) best = { res, pos, s };
      }
      if (best && best.res < (G >= 24 ? 0.3 : 0.2)) return { p48: best.pos.map(p => Math.round(p) * 48 / G), fuzzy: false, G };
    }
    return { p48: xs.map(x => Math.max(0, Math.min(47, Math.round((x - x0) / unit * 12)))), fuzzy: true };
  }

  // 마디 안 위치(48분의 몇)들을 가장 단순한 격자로
  function bestGrid(pos48) {
    for (const g of [4, 8, 16, 12, 24, 48]) { const f = 48 / g; if (pos48.every(p => p % f === 0)) return g; }
    return 48;
  }

  async function parseDrumPdf(pdfjs, data, opts) {
    opts = opts || {};
    const doc = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
    const measures = [], warnings = [];
    let title = '';
    for (let pn = 1; pn <= doc.numPages; pn++) {
      if (opts.onProgress) opts.onProgress(pn, doc.numPages);
      const page = await doc.getPage(pn);
      const pg = await readPage(pdfjs, page);
      if (pn === 1) {
        // 가장 큰 글자를 제목으로
        const big = pg.texts.filter(t => !/^\d+$/.test(t.str.trim())).sort((p, q) => (q.w / Math.max(1, q.str.length)) - (p.w / Math.max(1, p.str.length)))[0];
        if (big) title = big.str.trim();
      }
      const music = pg.glyphs.filter(g => /maestro|petrucci|jazz|bravura|opus|percussion|sonata|engraver|broadway|finale/i.test(g.font));
      const staves = findStaves(pg.segs);
      // 템포 표시: 음표 기호 'q' 뒤의 "= 숫자"
      const tempos = [];
      for (const g of music) {
        if (g.code !== 0x71 && g.code !== 0xf071) continue;
        const near = pg.texts.filter(t => t.x > g.x - 2 && t.x < g.x + 50 && Math.abs(t.y - g.y) < 6).sort((p, q) => p.x - q.x);
        const m = near.map(t => t.str).join('').match(/=\s*(\d{2,3})/);
        if (m) tempos.push({ x: g.x, y: g.y, bpm: +m[1] });
      }
      let prevDrumBottom = -1;
      for (const st of staves) {
        const bl = findBarlines(st, pg.segs);
        const lastBar = bl[bl.length - 1];
        let bounds = [st.x0, ...bl.filter(x => x > st.x0 + st.sp * 2)];
        // 줄 맨 앞의 도돌이표 시작(|:)은 마디줄이 아니라 첫 마디의 시작: 음자리표만 있는 짧은 칸은 버려요
        if (bounds.length > 2 && bounds[1] - bounds[0] < st.sp * 9) bounds = bounds.slice(1);
        if (lastBar === undefined || bounds.length < 2) continue;
        // 도돌이표 점: 마디줄 바로 옆, 가운데 줄 위아래로 한 쌍
        const mid = (st.top + st.bottom) / 2;
        const rdots = pg.glyphs.filter(g => g.code === 0x2e && /maestro/i.test(g.font) && !/percussion/i.test(g.font) && Math.abs(Math.abs(g.y - mid) - st.sp / 2) < st.sp * 0.3);
        const repeatAt = b => {
          const near = rdots.filter(d => d.x > b - st.sp * 2.5 && d.x < b + st.sp * 1.5);
          const pair = near.filter(d => near.some(e => e !== d && Math.abs(e.x - d.x) < 0.6 && Math.abs(e.y - d.y) > st.sp * 0.6));
          if (!pair.length) return null;
          return pair[0].x > b ? 'start' : 'end';
        };
        const inStaff = g => g.y > st.top - st.sp * 8 && g.y < st.bottom + st.sp * 6;
        const gl = music.filter(inStaff);
        // 멜로디·피아노 오선은 건너뛰어요: 드럼 글꼴 음표나 타악기 음자리표가 있는 오선만 드럼
        const near = gl.filter(g => g.y > st.top - st.sp * 2 && g.y < st.bottom + st.sp * 2);
        const isDrum = near.some(g => /percussion/i.test(g.font)) || near.some(g => g.code === 0xf08b && g.x < st.x0 + st.sp * 6);
        if (!isDrum) continue;
        // 템포 표시는 그 줄(시스템) 맨 위 오선에 붙어 있을 수 있어요: 앞 드럼 오선과 이 오선 사이 전부
        const sysTop = prevDrumBottom;
        prevDrumBottom = st.bottom;
        const half = st.sp / 2;
        // 이 오선 바로 위의 템포 표시
        const stTempos = tempos.filter(t => t.y < st.top && t.y > Math.max(sysTop, st.top - st.sp * 40));
        for (let mi = 0; mi < bounds.length - 1; mi++) {
          const L = bounds[mi], Rb = bounds[mi + 1];
          const within = gl.filter(g => g.x > L + 0.5 && g.x < Rb - 0.5);
          const heads = [], rests = [];
          let rep = 0;
          for (const g of within) {
            const isPerc = /percussion/i.test(g.font);
            let kind = null;
            if (HEAD_X.has(g.code) && isPerc) kind = 'x';
            else if (HEAD_CX.has(g.code) && isPerc) kind = 'cx';
            else if (HEAD_FILLED.has(g.code) && (isPerc || (g.y > st.top - st.sp * 3 && g.y < st.bottom + st.sp * 3))) kind = 'n';
            if (kind) {
              if (g.size < (opts.headSize || 14) * 0.8) continue; // 꾸밈음(작은 음표)은 건너뛰어요
              heads.push({ x: g.x, y: g.y, kind, step: Math.round((g.y - st.top) / half) });
            } else if (RESTS.has(g.code)) rests.push({ x: g.x });
            else if (REPEAT2.has(g.code)) rep = 2;
            else if (REPEAT1.has(g.code)) rep = 1;
          }
          // 2마디 반복 기호는 마디줄 위에 걸쳐 있어서 양옆 마디에 걸쳐요
          const repOnBar = gl.find(g => REPEAT2.has(g.code) && Math.abs(g.x + 7 - Rb) < st.sp * 3);
          const meas = { page: pn, heads, accents: [], open: [], tied: [], rep, rep2Right: !!repOnBar, bpm: null, label: null, L, R: Rb,
            top: st.top, bottom: st.bottom, sp: st.sp,
            repStart: repeatAt(L) === 'start', repEnd: repeatAt(Rb) === 'end' };
          for (const t of stTempos) if (t.x >= L - st.sp * 6 && t.x < Rb - st.sp * 2 && meas.bpm == null) meas.bpm = t.bpm;
          if (mi === 0 && meas.bpm == null) { const t = stTempos.find(tt => tt.x < L + st.sp * 6); if (t) meas.bpm = t.bpm; }
          // 악센트(>)·오픈(o)·닫힘(+)은 음표 위 같은 가로 위치에
          for (const g of within) {
            if (g.code === 0x3e && g.y < st.top + st.sp) meas.accents.push(g.x);
            if (g.code === 0x6f && g.y < st.top) meas.open.push(g.x);
          }
          // 붙임줄: 곡선의 오른쪽 끝에 있는 음표는 새로 치지 않아요
          for (const c of pg.curves) {
            const [a, b] = c, xl = Math.min(a.x, b.x), xr = Math.max(a.x, b.x);
            if (xr - xl < st.sp * 1.5) continue;
            if ((a.y + b.y) / 2 < st.top - st.sp * 6 || (a.y + b.y) / 2 > st.bottom + st.sp * 6) continue;
            if (xr > L && xr < Rb + st.sp) meas.tied.push({ x: xr, y: (a.y + b.y) / 2 });
          }
          // 박 위치: 첫 이벤트(음표·쉼표)가 1박, 마디 끝(마디줄)이 4박 끝
          const cols = [...heads.map(h => h.x), ...rests.map(r => r.x)];
          meas.hits = [];
          if (cols.length) {
            const x0 = Math.min(...cols);
            const unit = (Rb - x0 - st.sp * 0.35) / 4;
            const fit = fitPositions(heads.map(h => h.x), x0, unit);
            if (fit.fuzzy) { meas.fuzzy = true; warnings.push(`${measures.length + 1}마디: 박자 위치가 애매해요. 원본과 비교해 주세요`); }
            heads.forEach((h, k) => meas.hits.push({ ...h, p48: fit.p48[k] }));
          }
          // 글자 지시('Ride →', 'Open H.H →')는 이 마디부터 다음 지시 전까지
          for (const t of pg.texts) {
            if (t.y > st.top || t.y < st.top - st.sp * 8 || t.x < L - st.sp * 4 || t.x >= Rb) continue;
            if (/ride/i.test(t.str)) meas.mode = 'ride';
            else if (/h\.?\s*h\b|hi-?hat|하이햇/i.test(t.str)) meas.mode = 'hh';
          }
          measures.push(meas);
        }
      }
    }
    // 반복 기호 펼치기: 내용이 없는 마디가 반복 기호를 가지면 앞 마디를 복사
    const out = [];
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      const empty = !m.hits.length;
      const prevRep2 = i > 0 && measures[i - 1].rep2Right;
      if (empty && (m.rep2Right || prevRep2) && out.length >= 2) {
        // 2마디 반복: [i, i+1] = [i-2, i-1]
        const src = out[out.length - 2];
        out.push({ ...src, bpm: m.bpm, label: null, copied: true });
        continue;
      }
      if (empty && m.rep === 1 && out.length) { out.push({ ...out[out.length - 1], bpm: m.bpm, copied: true }); continue; }
      out.push(m);
    }
    // 도돌이표 펼치기: 끝(:|)을 처음 만나면 마지막 시작(|:)으로 한 번 돌아가요
    const played = [];
    let repFrom = 0;
    const doneEnds = new Set();
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.repStart) repFrom = i;
      played.push(i);
      if (m.repEnd && !doneEnds.has(i)) {
        doneEnds.add(i);
        for (let k = repFrom; k <= i; k++) played.push(k);
        repFrom = i + 1;
      }
    }
    // 곡 파일로
    let bpm = null, mode = 'hh';
    const seq = played.map(i => out[i]);
    const bars = seq.map((m, idx) => {
      const b = {};
      if (m.bpm && m.bpm !== bpm) { b.bpm = m.bpm; bpm = m.bpm; }
      if (m.mode && !m.copied) mode = m.mode;
      if (idx > 0 && played[idx] <= played[idx - 1]) b.label = `↺ ${played[idx] + 1}마디부터 반복`;
      const hits = m.hits.filter(h => !m.tied.some(t => Math.abs(t.x - h.x) < 3 && Math.abs(t.y - h.y) < 8));
      const grid = bestGrid(hits.map(h => h.p48));
      b.grid = grid;
      const f = 48 / grid, lines = {};
      const accentAt = x => m.accents.some(ax => Math.abs(ax - x) < 4);
      const openAt = x => m.open.some(ox => Math.abs(ox - x) < 4);
      for (const h of hits) {
        const inst = instrumentFor(h.kind, h.step, mode);
        const k = Math.round(h.p48 / f);
        if (!lines[inst]) lines[inst] = Array(grid).fill('-');
        let c = 'x';
        if (inst === 'hh' && openAt(h.x)) c = 'o';
        if (accentAt(h.x) && (h.kind !== 'n' || !hits.some(o => o !== h && Math.abs(o.x - h.x) < 2 && o.kind !== 'n'))) c = c.toUpperCase();
        if (inst === 'bd') c = 'x';
        lines[inst][k] = c;
      }
      const per = grid / 4;
      for (const [inst, arr] of Object.entries(lines)) b[inst] = arr.join('').match(new RegExp(`.{1,${per}}`, 'g')).join(' ');
      return b;
    });
    if (bars.length && !bars[0].bpm) bars[0].bpm = opts.defaultBpm || 100;
    const repeats = played.length - out.length;
    // 확인 화면용: 연주 순서의 각 마디가 원본 PDF 어디에서 왔는지 (반복·복사된 마디는 원래 마디를 가리켜요)
    const sources = played.map(i => {
      const m = out[i];
      return { printed: i + 1, page: m.page, L: m.L, R: m.R, top: m.top, bottom: m.bottom, sp: m.sp, fuzzy: !!m.fuzzy, empty: !m.hits.length, copied: !!m.copied };
    });
    if (!opts.keepDoc) doc.destroy();
    return { song: { title: title || '불러온 악보', bpm: bars[0] ? bars[0].bpm : 100, bars }, warnings, measures: out.length, played: played.length, repeats, sources,
      doc: opts.keepDoc ? doc : undefined, debug: opts.debug ? out : undefined };
  }

  const api = { parseDrumPdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DrumPdf = api;
})(typeof self !== 'undefined' ? self : this);
