import { useCallback, useRef, useState } from 'react';

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

export function useZoomPan() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const svgSize = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // authoritative view state in a ref (avoids stale closures + nested setState)
  const view = useRef({ scale: 1, offset: { x: 0, y: 0 } });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const apply = useCallback((s: number, o: { x: number; y: number }) => {
    view.current = { scale: s, offset: o };
    setScale(s);
    setOffset(o);
  }, []);

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const prev = view.current.scale;
      const next = clamp(prev * factor);
      if (next === prev) return;
      const rect = vp.getBoundingClientRect();
      const px = cx ?? rect.width / 2;
      const py = cy ?? rect.height / 2;
      const o = view.current.offset;
      apply(next, {
        x: px - ((px - o.x) / prev) * next,
        y: py - ((py - o.y) / prev) * next,
      });
    },
    [apply]
  );

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !svgSize.current.w) return;
    const pad = 40;
    const s = clamp(
      Math.min(
        (vp.clientWidth - pad) / svgSize.current.w,
        (vp.clientHeight - pad) / svgSize.current.h,
        1.5
      )
    );
    apply(s, {
      x: (vp.clientWidth - svgSize.current.w * s) / 2,
      y: (vp.clientHeight - svgSize.current.h * s) / 2,
    });
  }, [apply]);

  const inject = useCallback(
    (svg: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.innerHTML = svg;
      const svgEl = canvas.querySelector('svg');
      if (svgEl) {
        const vb = svgEl.viewBox.baseVal;
        const w = vb?.width || svgEl.getBoundingClientRect().width;
        const h = vb?.height || svgEl.getBoundingClientRect().height;
        svgSize.current = { w, h };
        svgEl.style.width = `${w}px`;
        svgEl.style.height = `${h}px`;
        svgEl.style.maxWidth = 'none';
      }
      fit();
    },
    [fit]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    },
    [zoomBy]
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    // never start a drag from controls - pointer capture would swallow their click
    if (t.closest('button, .zoom-controls, .ov-info, a, input')) return;
    if (t.closest('g.node')) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      ox: view.current.offset.x,
      oy: view.current.offset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.style.cursor = 'grabbing';
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.style.cursor = 'grab';
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    apply(view.current.scale, {
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    });
  }, [apply]);

  return {
    viewportRef,
    canvasRef,
    scale,
    offset,
    zoomBy,
    fit,
    inject,
    viewportProps: {
      onWheel,
      onPointerDown,
      onPointerUp: endDrag,
      onPointerMove,
      onPointerCancel: endDrag,
    },
  };
}
