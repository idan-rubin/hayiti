/** Retarget Leaflet's camera while the wheel is moving, keeping the place under the pointer in view. */
export function enableWheelZoom(map: JournalMap) {
  const container = map.getContainer();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let target: number | undefined;
  let frame = 0;
  let pointer: WheelEvent;

  function clearTarget() {
    cancelAnimationFrame(frame);
    frame = 0;
    target = undefined;
  }
  map.on('moveend', clearTarget);
  container.addEventListener('pointerdown', clearTarget);
  container.addEventListener('wheel', event => {
    const pixels = L.DomEvent.getWheelDelta(event);
    if (!pixels) return;
    event.preventDefault();
    event.stopPropagation();
    const previous = target ?? map.getZoom();
    target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), previous + pixels / 60));
    pointer = event;
    if (target === previous || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (target === undefined) return;
      const offset = map.mouseEventToContainerPoint(pointer).subtract(map.getSize().divideBy(2));
      const anchor = map.project(map.mouseEventToLatLng(pointer), target);
      const center = map.unproject(anchor.subtract(offset), target);
      map.flyTo(center, target, { animate: !reducedMotion.matches, duration: .15 });
    });
  }, { passive: false });
}
