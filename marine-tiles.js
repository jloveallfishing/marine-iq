/* Reuse decoded tiles for the current map session. All fetches are visible-area
   requests and still go through the browser's normal HTTP cache. */
window.createMarineBasemap = function (L) {
  const loaded = new Map();
  const pending = new WeakMap();
  const key = (z, x, y) => [z, x, y].join('/');
  const remembered = (z, x, y) => loaded.get(key(z, x, y));

  function fallback(canvas, {z, x, y}, size) {
    let context;
    const draw = (...args) => {
      context ??= canvas.getContext('2d');
      context?.drawImage(...args);
    };
    for (let level = 0; level <= Math.min(z, 2); level++) {
      const factor = 2 ** level;
      const image = remembered(z - level, Math.floor(x / factor), Math.floor(y / factor));
      if (!image) continue;
      const width = image.naturalWidth / factor, height = image.naturalHeight / factor;
      draw(image, (x % factor) * width, (y % factor) * height,
                        width, height, 0, 0, size, size);
      return level === 0 ? 'same zoom' : 'parent';
    }
    let children = 0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const image = remembered(z + 1, x * 2 + col, y * 2 + row);
        if (!image) continue;
        draw(image, col * size / 2, row * size / 2, size / 2, size / 2);
        children++;
      }
    }
    return children ? 'children' : '';
  }

  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('div');
      tile.dataset.tileZoom = coords.z;
      const size = this.getTileSize().x;
      const preview = document.createElement('canvas');
      preview.width = preview.height = size;
      const source = fallback(preview, coords, size);
      if (source) {
        tile.dataset.tilePreview = source;
        tile.style.visibility = 'visible';
        tile.append(preview);
      }
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'strict-origin-when-cross-origin';
      image.hidden = true;
      tile.append(image);
      pending.set(tile, image);
      image.onload = () => {
        pending.delete(tile);
        const id = key(coords.z, coords.x, coords.y);
        loaded.delete(id);
        loaded.set(id, image);
        if (loaded.size > 56) loaded.delete(loaded.keys().next().value);
        image.hidden = false;
        preview.remove();
        delete tile.dataset.tilePreview;
        tile.style.visibility = '';
        done(null, tile);
      };
      image.onerror = () => {
        pending.delete(tile);
        image.remove();
        done(Error('Basemap tile unavailable'), tile);
      };
      image.src = 'https://tile.openstreetmap.org/' + key(coords.z, coords.x, coords.y) + '.png';
      return tile;
    }
  });
  const layer = new Layer({
    maxZoom: 19, keepBuffer: 3, updateWhenIdle: true, updateWhenZooming: false,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  });
  layer.on('tileunload', ({tile}) => {
    const image = pending.get(tile);
    if (image) {
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      pending.delete(tile);
    }
  });
  return layer;
};
