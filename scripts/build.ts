import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { portableDocument } from '../src/domain/share-format.ts';
const output = 'dist/web';
const read = (file: string) => readFile(file, 'utf8');
await mkdir(output, {
  recursive: true
});
await cp('public', output, {
  recursive: true
});
await cp('node_modules/leaflet/dist/leaflet.css', output + '/vendor/leaflet.css');
await cp('node_modules/leaflet/dist/leaflet.js', output + '/vendor/leaflet.js');
await cp('node_modules/leaflet/dist/images', output + '/vendor/images', {
  recursive: true
});
// The street map library is published as a module. The journal uses it as a global, like Leaflet.
await build({
  stdin: {
    contents: "import * as maplibregl from 'maplibre-gl'; Object.assign(globalThis, { maplibregl });",
    resolveDir: '.'
  },
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outfile: output + '/vendor/maplibre-gl.js',
  legalComments: 'inline',
  // The library looks for its worker next to its own module. The journal names the worker instead.
  logOverride: { 'empty-import-meta': 'silent' }
});
await cp('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', output + '/vendor/maplibre-gl-worker.js');
await cp('node_modules/maplibre-gl/dist/maplibre-gl.css', output + '/vendor/maplibre-gl.css');
await cp('node_modules/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js', output + '/vendor/leaflet-maplibre-gl.js');
await build({
  entryPoints: ['src/web/journal-app.ts'],
  banner: { js: '/*! SortableJS\n' + (await read('node_modules/sortablejs/LICENSE')).trim() + '\n*/' },
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outdir: output,
  legalComments: 'inline'
});
await build({
  entryPoints: ['src/server/app.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'dist/server/app.mjs'
});
const template = await read('public/journal.html');
// Each inlined block is a named part, which the portable file stores once (see portableDocument).
const script = (name: string, code: string, type = '') => {
  if (code.includes('<!--')) throw Error('An inline script cannot contain an HTML comment opener: ' + name);
  return '<script data-part="' + name + '"' + type + '>' + code.replace(/<\/script/gi, '<\\/script') + '</script>';
};
const vendor = (name: string) => read(output + '/vendor/' + name);
const journal = await read(output + '/journal-app.js');
// The worker is text, not a script the page runs. The journal starts it from this text.
const mapLibrary = script('street-map-worker', await vendor('maplibre-gl-worker.js'), ' type="text/plain"')
  + script('leaflet', await vendor('leaflet.js'))
  + script('street-map', await vendor('maplibre-gl.js'))
  + script('street-map-layer', await vendor('leaflet-maplibre-gl.js'));
let standalone = template.replace('<html ', '<html data-portable ').replace('<!-- map library -->', () => mapLibrary).replace('<!-- journal entry -->', () => script('journal', journal)).replace(/href="(support|privacy|terms)\.html"/g, 'href="https://hayiti-beta.cocoacoati256.chatgpt.site/$1.html"');
function embedStyles(html: string, name: string, css: string): string {
  const link = '<link rel="stylesheet" href="' + name + '">';
  if (!html.includes(link)) throw Error('Missing stylesheet ' + name);
  if (/<\/style/i.test(css)) throw Error('A stylesheet cannot be inlined: ' + name);
  return html.replace(link, () => '<style data-part="' + name.replace(/\W+/g, '-') + '">' + css + '</style>');
}
const dataURL = async (file: string, mime: string) => 'data:' + mime + ';base64,' + (await readFile(file)).toString('base64');
standalone = embedStyles(standalone, 'journal.css', await read('public/journal.css'));
let mapCSS = await read(output + '/vendor/leaflet.css');
for (const name of new Set(Array.from(mapCSS.matchAll(/url\(images\/([\w.-]+)\)/g), m => m[1]))) {
  mapCSS = mapCSS.replaceAll('url(images/' + name + ')', 'url(' + (await dataURL(output + '/vendor/images/' + name, 'image/png')) + ')');
}
standalone = embedStyles(standalone, 'vendor/leaflet.css', mapCSS);
standalone = embedStyles(standalone, 'vendor/maplibre-gl.css', await vendor('maplibre-gl.css'));
for (const name of ['hayiti-icon.png', 'hayiti-signature.png']) {
  const image = await dataURL('public/' + name, 'image/png');
  standalone = standalone.replaceAll(new RegExp('"' + name.replace('.', '\\.') + '(?:\\?[^"]*)?"', 'g'), '"' + image + '"');
}
// Match the browser's parsed line endings so portable exports reproduce their source exactly.
standalone = standalone.replace(/\r\n?/g, '\n');
const blank = portableDocument(standalone);
await writeFile(output + '/Hayiti.html', blank);
await writeFile(output + '/Hayiti.zip', zipSync({
  'Hayiti.html': strToU8(blank)
}));
await writeFile(output + '/journal.html', template.replace('<!-- map library -->', '<script src="vendor/leaflet.js"></script><script defer src="vendor/maplibre-gl.js"></script><script defer src="vendor/leaflet-maplibre-gl.js"></script>').replace('<!-- journal entry -->', '<script defer src="journal-app.js"></script>'));
