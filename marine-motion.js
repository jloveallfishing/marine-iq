/* Forecasts stay inside supported interpolation polygons or published NWS grid cells. */
window.MarineMotion = (() => {
  const palette = [[36, 111, 196], [24, 173, 154], [239, 210, 71], [237, 105, 61], [172, 63, 177]];
  const stops = [0, 10, 20, 30, 40];
  const rgb = color => 'rgb(' + color.join(',') + ')';
  const gradient = 'linear-gradient(90deg,' + palette.map(rgb).join(',') + ')';

  function color(speed) {
    const position = Math.max(0, Math.min(speed, 40)) / 10;
    const start = Math.min(3, Math.floor(position)), fraction = position - start;
    return palette[start].map((value, i) => Math.round(value + (palette[start + 1][i] - value) * fraction));
  }

  function field(grid, values, project) {
    const {latitudes, longitudes} = grid;
    const xs = longitudes.map(lon => project([latitudes[0], lon]).x);
    const ys = latitudes.map(lat => project([lat, longitudes[0]]).y);
    const cells = [], heat = [], flow = [];
    function supported(corners, fieldName, x, y, width, height) {
      const positions = [[0, 0], [1, 0], [0, 1], [1, 1]];
      const available = corners.map((corner, i) => ({point: positions[i], value: corner?.[fieldName]}))
        .filter(corner => corner.value != null);
      if (available.length < 3) return null;
      const polygon = available.length === 4
        ? [positions[0], positions[1], positions[3], positions[2]] : available.map(corner => corner.point);
      const boundary = [0, 1, 3, 2].filter(i => polygon.includes(positions[i]))
        .map(i => [x + width * positions[i][0], y + height * positions[i][1]]);
      const shape = {x, y, width, height, boundary};
      const vector = fieldName === 'vector';
      const value = (i, component) => vector ? available[i].value[component] : available[i].value;
      let interpolate;
      if (available.length === 4) {
        interpolate = (u, v, component) =>
          (value(0, component) * (1 - u) + value(1, component) * u) * (1 - v) +
          (value(2, component) * (1 - u) + value(3, component) * u) * v;
      } else {
        const [a, b, c] = polygon;
        const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        interpolate = (u, v, component) => {
          const wa = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / determinant;
          const wb = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / determinant;
          const wc = 1 - wa - wb;
          return wa < -1e-9 || wb < -1e-9 || wc < -1e-9 ? null :
            wa * value(0, component) + wb * value(1, component) + wc * value(2, component);
        };
      }
      return {shape, interpolate};
    }
    for (let row = 0; row < ys.length - 1; row++) {
      const line = [];
      for (let col = 0; col < xs.length - 1; col++) {
        const corners = [values[row][col], values[row][col + 1], values[row + 1][col], values[row + 1][col + 1]];
        const x = xs[col], y = ys[row], width = xs[col + 1] - x, height = ys[row + 1] - y;
        const speed = supported(corners, 'speed', x, y, width, height);
        const vector = supported(corners, 'vector', x, y, width, height);
        if (speed) heat.push(speed.shape);
        if (vector) flow.push(vector.shape);
        line.push({speed, vector, x, y, width, height});
      }
      cells.push(line);
    }
    const sample = (x, y, vector = false) => {
      let col = 0, row = 0;
      if (x < xs[0] || y < ys[0]) return null;
      while (col < cells[0]?.length && x >= xs[col + 1]) col++;
      while (row < cells.length && y >= ys[row + 1]) row++;
      const cell = cells[row]?.[col];
      const source = vector ? cell?.vector : cell?.speed;
      if (!source) return null;
      const u = (x - cell.x) / cell.width, v = (y - cell.y) / cell.height;
      const first = source.interpolate(u, v, 0);
      return vector && first !== null ? [first, source.interpolate(u, v, 1)] : first;
    };
    sample.heat = heat;
    sample.flow = flow;
    return sample;
  }

  function publishedCell(geometry, project) {
    const ring = geometry?.type === 'Polygon' && geometry.coordinates?.length === 1
      ? geometry.coordinates[0] : null;
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 32 || ring.some(point =>
      !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85)) return null;
    const [lon, lat] = ring[0];
    const last = ring[ring.length - 1];
    if (last[0] !== lon || last[1] !== lat ||
        ring.some(([x,y]) => Math.abs(x-lon) > .12 || Math.abs(y-lat) > .12)) return null;
    const boundary = ring.map(([x,y]) => {
      const point = project([y,x]);
      return [point.x,point.y];
    });
    const signedArea=boundary.slice(1).reduce((area,[px,py],i)=>{
      const [qx,qy]=boundary[i];
      return area+(qx-boundary[0][0])*(py-boundary[0][1])-(px-boundary[0][0])*(qy-boundary[0][1]);
    },0);
    if (!signedArea) return null;
    if (signedArea<0) boundary.reverse();
    const x = Math.min(...boundary.map(point=>point[0])), y = Math.min(...boundary.map(point=>point[1]));
    const width = Math.max(...boundary.map(point=>point[0]))-x;
    const height = Math.max(...boundary.map(point=>point[1]))-y;
    if (width <= 0 || height <= 0) return null;
    return {x,y,width,height,boundary};
  }

  // Published cells are fixed in world coordinates, even when the map moves.
  function cellField(cells) {
    const size = 16;
    const buckets = new Map();
    for (const cell of cells) {
      const {x,y,width,height} = cell.shape;
      for (let row = Math.floor(y/size); row <= Math.floor((y+height)/size); row++) {
        for (let col = Math.floor(x/size); col <= Math.floor((x+width)/size); col++) {
          const key = col + ',' + row;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(cell);
        }
      }
    }
    const lookup = (x,y,accept) => {
      const bucket = buckets.get(Math.floor(x/size) + ',' + Math.floor(y/size));
      if (!bucket) return null;
      for (const cell of bucket) {
        if (accept && !accept(cell)) continue;
        const {shape} = cell;
        if (x < shape.x || y < shape.y || x > shape.x+shape.width || y > shape.y+shape.height) continue;
        let inside = false;
        for (let i=1; i<shape.boundary.length; i++) {
          const [ax,ay]=shape.boundary[i-1], [bx,by]=shape.boundary[i];
          if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
        }
        if (inside) return cell;
      }
      return null;
    };
    const directional = cell => cell.velocity !== null;
    const sample = (x,y,vector=false) => {
      const cell = lookup(x,y,vector ? directional : null);
      return (vector ? cell?.velocity : cell?.speed) ?? null;
    };
    sample.lookup = lookup;
    sample.heat = cells.map(cell=>cell.shape);
    sample.flow = cells.filter(directional).map(cell=>cell.shape);
    return sample;
  }

  function create(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'marine-flow leaflet-zoom-animated';
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    const context = canvas.getContext('2d');
    const heatCanvas = document.createElement('canvas');
    heatCanvas.className = 'marine-flow marine-heat leaflet-zoom-animated';
    heatCanvas.setAttribute('aria-hidden', 'true');
    heatCanvas.style.visibility = 'hidden';
    container.insertBefore(heatCanvas, canvas);
    const heatContext = heatCanvas.getContext('2d');
    const bearingCanvas = document.createElement('canvas');
    bearingCanvas.className = 'marine-bearing leaflet-zoom-animated';
    bearingCanvas.setAttribute('aria-hidden', 'true');
    container.insertBefore(bearingCanvas, canvas);
    const bearingContext = bearingCanvas.getContext('2d');
    const raster = document.createElement('canvas');
    const rasterContext = raster.getContext('2d');
    if (!context || !rasterContext || !heatContext || !bearingContext) {
      canvas.remove();
      heatCanvas.remove();
      bearingCanvas.remove();
      return null;
    }
    let width = 0, height = 0, frame = null, last = null, active = false;
    let flowCells = [], spawnCells = null, rasterKey = '';
    let particles = [], currents = [], sample = null, motionSample = null, extent = null;
    let opacity = .64, cameraAt = 0, bearingSample = null, bearingTimer = null;
    function paintBearings() {
      bearingContext.clearRect(0, 0, width, height);
      bearingCanvas.style.visibility = bearingSample ? '' : 'hidden';
      if (!bearingSample) return;
      const {x, y, scale} = view;
      const step = Math.max(37, Math.sqrt(width * height / 90));
      bearingContext.lineCap = 'round';
      for (let py = step/2; py < height; py += step) for (let px = step/2; px < width; px += step) {
        const wx = x + px/scale, wy = y + py/scale;
        const vector = bearingSample(wx, wy, true), speed = bearingSample(wx, wy, false);
        if (!vector || speed === null || speed < 1) continue;
        const direction = Math.atan2(vector[1],vector[0]);
        const length = Math.min(15, 7+speed*.27);
        bearingContext.save();
        bearingContext.translate(px,py);
        bearingContext.rotate(direction);
        bearingContext.beginPath();
        bearingContext.moveTo(-length/2,0);
        bearingContext.lineTo(length/2,0);
        bearingContext.lineTo(length/2-4,-3.5);
        bearingContext.moveTo(length/2,0);
        bearingContext.lineTo(length/2-4,3.5);
        bearingContext.lineWidth=4;
        bearingContext.strokeStyle='#092032';
        bearingContext.stroke();
        bearingContext.lineWidth=2.1;
        bearingContext.strokeStyle=rgb(color(speed));
        bearingContext.stroke();
        bearingContext.restore();
      }
    }
    let view = {x: 0, y: 0, scale: 1};

    function paintHeat() {
      heatContext.save();
      heatContext.setTransform(1,0,0,1,0,0);
      heatContext.clearRect(0,0,heatCanvas.width,heatCanvas.height);
      heatContext.restore();
      if (!extent) return;
      const {x, y, scale} = view;
      heatContext.save();
      for (const {shape,speed} of extent.tiles || []) {
        heatContext.beginPath();
        shape.boundary.forEach(([px,py],i)=>{
          if (i===0) heatContext.moveTo((px-x)*scale,(py-y)*scale);
          else heatContext.lineTo((px-x)*scale,(py-y)*scale);
        });
        heatContext.closePath();
        heatContext.fillStyle=rgb(color(speed));
        heatContext.fill();
      }
      heatContext.beginPath();
      for (const cell of extent.cells) {
        cell.boundary.forEach(([px, py], i) => {
          if (i === 0) heatContext.moveTo((px - x) * scale, (py - y) * scale);
          else heatContext.lineTo((px - x) * scale, (py - y) * scale);
        });
        heatContext.closePath();
      }
      heatContext.clip();
      heatContext.drawImage(raster, (extent.x - x) * scale, (extent.y - y) * scale,
                            extent.width * scale, extent.height * scale);
      heatContext.restore();
    }

    function cancel() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = last = null;
    }

    function resetTrails() {
      for (const particle of particles) particle.trailCount = 0;
    }

    function clear() {
      cancel();
      extent = sample = bearingSample = motionSample = null;
      clearTimeout(bearingTimer);
      paintBearings();
      canvas.style.visibility = 'hidden';
      heatCanvas.style.visibility = 'hidden';
      flowCells = [];
      spawnCells = null;
      rasterKey = '';
      particles = [];
      currents = [];
      context.clearRect(0, 0, width, height);
      paintHeat();
    }

    function spawn(particle) {
      if (!spawnCells) {
        const right = view.x + width / view.scale, bottom = view.y + height / view.scale;
        spawnCells = flowCells.map(cell => ({
          x: Math.max(cell.x, view.x), y: Math.max(cell.y, view.y),
          right: Math.min(cell.x + cell.width, right), bottom: Math.min(cell.y + cell.height, bottom)
        })).filter(cell => cell.x < cell.right && cell.y < cell.bottom);
      }
      particle.life = 0;
      particle.trailCount = particle.trailNext = 0;
      for (let i = 0; i < 4 && spawnCells.length; i++) {
        const cell = spawnCells[Math.floor(Math.random() * spawnCells.length)];
        const x = cell.x + Math.random() * (cell.right - cell.x);
        const y = cell.y + Math.random() * (cell.bottom - cell.y);
        if (!motionSample(x, y, true)) continue;
        particle.x = x;
        particle.y = y;
        particle.life = 15 + Math.random() * 30;
        break;
      }
    }

    function animate(now) {
      frame = requestAnimationFrame(animate);
      if (last !== null && now - last < (now - cameraAt < 120 ? 49 : 32)) return;
      const elapsed = last === null ? 1 : Math.min(1.5, (now - last) / 40);
      last = now;
      const {x, y, scale} = view;
      context.clearRect(0, 0, width, height);
      context.beginPath();
      for (const particle of particles) {
        const sx = (particle.x - x) * scale, sy = (particle.y - y) * scale;
        const velocity = particle.life > 0 ? motionSample(particle.x, particle.y, true) : null;
        if (!velocity || particle.life-- <= 0 || sx < 0 || sx > width || sy < 0 || sy > height) {
          spawn(particle);
          continue;
        }
        const speed = Math.hypot(velocity[0], velocity[1]);
        if (speed < .2) continue;
        const step = elapsed * Math.min(Math.max(speed * .28, .8), 7) / (speed * scale);
        const nx = particle.x + velocity[0] * step, ny = particle.y + velocity[1] * step;
        if (!motionSample(nx, ny, true)) {
          spawn(particle);
          continue;
        }
        const trail = particle.trail;
        trail[particle.trailNext * 2] = particle.x;
        trail[particle.trailNext * 2 + 1] = particle.y;
        particle.trailNext = (particle.trailNext + 1) % 6;
        particle.trailCount = Math.min(6, particle.trailCount + 1);
        const start = (particle.trailNext + 6 - particle.trailCount) % 6;
        for (let i = 0; i < particle.trailCount; i++) {
          const offset = ((start + i) % 6) * 2;
          const px = (trail[offset] - x) * scale, py = (trail[offset + 1] - y) * scale;
          if (i === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        }
        context.lineTo((nx - x) * scale, (ny - y) * scale);
        particle.x = nx;
        particle.y = ny;
      }
      for (const current of currents) {
        const sx = (current.x - x) * scale, sy = (current.y - y) * scale;
        if (sx < -32 || sx > width + 32 || sy < -32 || sy > height + 32) continue;
        current.phase = (current.phase + elapsed * Math.min(.12, .03 + current.speed * .025)) % 1;
        for (const phase of [current.phase, (current.phase + .5) % 1]) {
          const offset = 9 + phase * 24, length = 3 + 7 * Math.sin(Math.PI * phase);
          context.moveTo(sx + current.dx * offset, sy + current.dy * offset);
          context.lineTo(sx + current.dx * (offset + length), sy + current.dy * (offset + length));
        }
      }
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = 3.2;
      context.strokeStyle = 'rgba(7,24,40,.92)';
      context.stroke();
      context.lineWidth = 1.65;
      context.strokeStyle = '#fff';
      context.stroke();
    }

    function setView(nextView) {
      const changed = nextView.x !== view.x || nextView.y !== view.y || nextView.scale !== view.scale;
      if (changed) {
        cameraAt = performance.now();
        spawnCells = null;
      }
      view = nextView;
      const nextWidth = container.clientWidth, nextHeight = container.clientHeight;
      const resized = width !== nextWidth || height !== nextHeight;
      if (resized) {
        width = nextWidth;
        height = nextHeight;
        const density = Math.min(window.devicePixelRatio || 1, 1.25);
        canvas.width = Math.ceil(width * density);
        canvas.height = Math.ceil(height * density);
        context.setTransform(density, 0, 0, density, 0, 0);
        heatCanvas.width = canvas.width;
        heatCanvas.height = canvas.height;
        heatContext.setTransform(density, 0, 0, density, 0, 0);
        bearingCanvas.width=canvas.width;
        bearingCanvas.height=canvas.height;
        bearingContext.setTransform(density,0,0,density,0,0);
      }
      if (extent && (changed || resized)) paintHeat();
      if (bearingSample && (changed || resized)) {
        clearTimeout(bearingTimer);
        bearingTimer=setTimeout(paintBearings,50);
      }
    }

    function configure({ sample: nextSample = null, flowSample = nextSample, heatmap = null, bearings = null, wind = false, stations = [], shapes = [] } = {}) {
      sample = nextSample;
      motionSample = flowSample;
      bearingSample = bearings;
      paintBearings();
      const phases = new Map(currents.map(station => [station.id, station.phase]));
      currents = stations.map(station => ({ ...station, phase: phases.get(station.id) ?? 0 }));
      const previousExtent = extent;
      extent = heatmap;
      heatCanvas.style.opacity = String(opacity);
      heatCanvas.style.visibility = extent ? '' : 'hidden';
      flowCells = shapes;
      spawnCells = null;
      const count = motionSample && wind && flowCells.length ? Math.min(88, Math.ceil(width * height / 2450)) : 0;
      particles.length = Math.min(particles.length, count);
      while (particles.length < count) {
        const particle = {x: 0, y: 0, life: 0, trail: new Float64Array(12), trailCount: 0, trailNext: 0};
        spawn(particle);
        particles.push(particle);
      }
      if (extent && rasterKey !== extent.key) {
        rasterKey = extent.key;
        raster.width = Math.min(160, Math.max(1, Math.ceil(extent.width * view.scale / 5)));
        raster.height = Math.min(128, Math.max(1, Math.ceil(extent.height * view.scale / 5)));
        const image = rasterContext.createImageData(raster.width, raster.height);
        for (let y = 0; y < raster.height; y++) {
          for (let x = 0; x < raster.width; x++) {
            const speed = sample(extent.x + (x + .5) * extent.width / raster.width,
                                 extent.y + (y + .5) * extent.height / raster.height);
            if (speed !== null) image.data.set([...color(speed), 255], (y * raster.width + x) * 4);
          }
        }
        rasterContext.putImageData(image, 0, 0);
        paintHeat();
      } else if (Boolean(extent) !== Boolean(previousExtent)) {
        paintHeat();
      }
      setActive(active);
    }

    function setActive(enabled) {
      active = enabled;
      const hasFlow = particles.length || currents.length;
      canvas.style.visibility = active && hasFlow ? '' : 'hidden';
      if (!active || !hasFlow) {
        if (frame !== null) {
          cancel();
          context.clearRect(0, 0, width, height);
        }
      } else if (frame === null && width && height) {
        frame = requestAnimationFrame(animate);
      }
    }

    function setOpacity(value) {
      opacity = value;
      heatCanvas.style.opacity = String(opacity);
    }

    return { clear, configure, resetTrails, setActive, setView, setOpacity };
  }

  return { color, field, publishedCell, cellField, create, gradient, stops };
})();
