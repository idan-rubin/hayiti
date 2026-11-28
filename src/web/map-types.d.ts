/** Subset of the browser APIs of Leaflet and MapLibre GL JS used by the journal. The build supplies the pinned distributions. */
type Coordinates = import('../domain/core.ts').Point;
interface MapPoint {
  equals(other: MapPoint): boolean;
}
interface Bounds {
  extend(points: Coordinates | Coordinates[]): Bounds;
  isValid(): boolean;
  getSouthWest(): MapPoint;
  getNorthEast(): MapPoint;
  getCenter(): MapPoint;
}
interface MapControl {
  setPosition(corner: 'bottomleft' | 'bottomright'): void;
}
interface JournalMap {
  zoomControl: MapControl;
  attributionControl: MapControl;
  createPane(name: string): HTMLElement;
  /** Moves the view by this many pixels; positive values show more of the map to the right and below. */
  panBy(offset: Coordinates, options: {
    animate: boolean;
  }): void;
  setView(position: Coordinates | MapPoint, zoom: number, options?: {
    animate: boolean;
  }): JournalMap;
  getContainer(): HTMLElement;
  stop(): void;
  invalidateSize(options: {
    animate: boolean;
    pan: boolean;
  }): void;
  fitBounds(bounds: Bounds, options: {
    paddingTopLeft: Coordinates;
    paddingBottomRight: Coordinates;
    maxZoom: number;
    animate: boolean;
  }): void;
  closePopup(): void;
  removeLayer(layer: StreetMapLayer): void;
  off(events: object, context: object): void;
  on(type: 'popupopen' | 'popupclose', callback: (event: { popup: MapPopup }) => void): void;
  on(type: 'click', callback: (event: {
    latlng: {
      lat: number;
      lng: number;
    };
  }) => void): void;
}
interface LayerGroup {
  addTo(map: JournalMap): LayerGroup;
  clearLayers(): void;
}
interface MapPopup {
  getElement(): HTMLElement;
  update(): void;
}
interface PopupOptions {
  /** Pixels a popup keeps clear of the map's left and top edges when the map pans to show it. */
  autoPanPaddingTopLeft: Coordinates;
  /** The same for the right and bottom edges. */
  autoPanPaddingBottomRight: Coordinates;
}
interface MapMarker {
  addTo(layer: LayerGroup): MapMarker;
  bindPopup(content: HTMLElement | (() => HTMLElement), options?: PopupOptions): MapMarker;
  openPopup(): MapMarker;
  on(type: 'click', callback: () => void): MapMarker;
}
/** MapLibre tile references; uses === 0 means the tile has left the view. */
interface StreetTile {
  state: string;
  uses: number;
}
interface StreetMap {
  on(type: 'style.load', callback: () => void): void;
  on(type: 'error', callback: (event: {
    sourceId?: string;
    tile?: StreetTile;
  }) => void): void;
  on(type: 'idle', callback: () => void): void;
  setLayoutProperty(layer: string, name: 'text-field', value: unknown): void;
}
interface StreetMapLayer {
  addTo(map: JournalMap): StreetMapLayer;
  getMaplibreMap(): StreetMap;
  getEvents(): object;
  getContainer(): HTMLElement;
}
interface RasterLayer {
  addTo(map: JournalMap): RasterLayer;
  on(type: 'tileerror' | 'tileunload', callback: (event: { tile: HTMLElement }) => void): RasterLayer;
  redraw(): RasterLayer;
  remove(): void;
}
interface MapLibrary {
  setWorkerUrl(url: string): void;
}
type StreetMapLayerFactory = (options: {
  style: object;
  attributionControl: {
    customAttribution: string;
  };
}) => StreetMapLayer;
/** Absent when the hosted journal could not download the library. */
declare const maplibregl: MapLibrary | undefined;
declare const L: {
  map(id: string, options: {
    zoomControl: boolean;
    scrollWheelZoom: boolean;
    trackResize: boolean;
    zoomSnap: number;
    maxZoom: number;
  }): JournalMap;
  maplibreGL?: StreetMapLayerFactory;
  tileLayer(url: string, options: {
    attribution: string;
    maxNativeZoom: number;
    maxZoom: number;
  }): RasterLayer;
  layerGroup(): LayerGroup;
  latLngBounds(points: Coordinates[]): Bounds;
  divIcon(options: {
    className: string;
    html: string;
    iconSize: Coordinates;
    iconAnchor: Coordinates;
  }): object;
  marker(point: Coordinates, options: {
    icon: object;
    title: string;
    alt: string;
  }): MapMarker;
  polyline(points: Coordinates[], options: {
    pane: string;
    color: string;
    weight: number;
    dashArray: string | null;
    opacity: number;
  }): {
    addTo(layer: LayerGroup): void;
  };
};
