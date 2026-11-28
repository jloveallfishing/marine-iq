/* Regional NWS forecasts are interpolated only inside a cell with four valid corners. */
window.MarineMotion = (() => {
  const palette = [[23, 105, 160], [37, 169, 144], [247, 201, 70], [228, 92, 50], [114, 37, 134]];
  const stops = [0, 10, 20, 30, 40];
  const rgb = color => 'rgb(' + color.join(',') + ')';
  const gradient = 'linear-gradient(90deg,' + palette.map(rgb).join(',') + ')';

  function color(speed) {
    const position = Math.max(0, Math.min(speed, 40)) / 10;
    const start = Math.min(3, Math.floor(position)), fraction = position - start;
    return palette[start].map((value, i) => Math.round(value + (palette[start + 1][i] - value) * fraction));
  }

  function field(grid, values, project) {
    const { latitudes, longitudes } = grid;
    const xs = longitudes.map(lon => project([latitudes[0], lon]).x);
    const ys = latitudes.map(lat => project([lat, longitudes[0]]).y);
    return (x, y, vector = false) => {
      const col = xs.findIndex(value => value > x) - 1;
      const row = ys.findIndex(value => value > y) - 1;
      if (col < 0 || row < 0) return null;
      const corners = [values[row][col], values[row][col + 1], values[row + 1][col], values[row + 1][col + 1]];
      const wx = (xs[col + 1] - x) / (xs[col + 1] - xs[col]);
      const wy = (ys[row + 1] - y) / (ys[row + 1] - ys[row]);
      const [a, b, c, d] = corners;
      const blend = (nw, ne, sw, se) => (nw * wx + ne * (1 - wx)) * wy +
                                        (sw * wx + se * (1 - wx)) * (1 - wy);
      if (vector) {
        if (!a?.vector || !b?.vector || !c?.vector || !d?.vector) return null;
        return [blend(a.vector[0], b.vector[0], c.vector[0], d.vector[0]),
                blend(a.vector[1], b.vector[1], c.vector[1], d.vector[1])];
      }
      if (a?.speed == null || b?.speed == null || c?.speed == null || d?.speed == null) return null;
      return blend(a.speed, b.speed, c.speed, d.speed);
    };
  }

  function create(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'marine-flow leaflet-zoom-animated';
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    const context = canvas.getContext('2d');
    const raster = document.createElement('canvas');
    const rasterContext = raster.getContext('2d');
    if (!context || !rasterContext) {
      canvas.remove();
      return null;
    }
    let width = 0, height = 0, frame = null, last = null, active = false;
    let particles = [], currents = [], sample = null, extent = null;
    let view = {x: 0, y: 0, scale: 1};

    function paint() {
      context.clearRect(0, 0, width, height);
      if (!extent) return;
      const {x, y, scale} = view;
      context.drawImage(raster, (extent.x - x) * scale, (extent.y - y) * scale,
                        extent.width * scale, extent.height * scale);
    }

    function cancel() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = last = null;
    }

    function clear() {
      cancel();
      extent = sample = null;
      particles = [];
      currents = [];
      paint();
    }

    function spawn(particle) {
      particle.x = view.x + Math.random() * width / view.scale;
      particle.y = view.y + Math.random() * height / view.scale;
      particle.life = 15 + Math.random() * 30;
      particle.trail = [];
    }

    function animate(now) {
      frame = requestAnimationFrame(animate);
      if (last !== null && now - last < 50) return;
      last = now;
      const {x, y, scale} = view;
      paint();
      context.beginPath();
      for (const particle of particles) {
        const sx = (particle.x - x) * scale, sy = (particle.y - y) * scale;
        const velocity = sample(particle.x, particle.y, true);
        if (!velocity || particle.life-- <= 0 || sx < 0 || sx > width || sy < 0 || sy > height) {
          spawn(particle);
          continue;
        }
        const speed = Math.hypot(velocity[0], velocity[1]);
        if (speed < .2) continue;
        const step = Math.min(speed * .24, 6) / (speed * scale);
        const nx = particle.x + velocity[0] * step, ny = particle.y + velocity[1] * step;
        if (!sample(nx, ny, true)) {
          spawn(particle);
          continue;
        }
        particle.trail.push([particle.x, particle.y]);
        if (particle.trail.length > 4) particle.trail.shift();
        const [first, ...rest] = particle.trail;
        context.moveTo((first[0] - x) * scale, (first[1] - y) * scale);
        for (const [px, py] of rest) context.lineTo((px - x) * scale, (py - y) * scale);
        context.lineTo((nx - x) * scale, (ny - y) * scale);
        particle.x = nx;
        particle.y = ny;
      }
      for (const current of currents) {
        const sx = (current.x - x) * scale, sy = (current.y - y) * scale;
        if (sx < -32 || sx > width + 32 || sy < -32 || sy > height + 32) continue;
        current.phase = (current.phase + Math.min(.12, .03 + current.speed * .025)) % 1;
        const offset = 8 + current.phase * 15;
        context.moveTo(sx + current.dx * offset, sy + current.dy * offset);
        context.lineTo(sx + current.dx * (offset + 7), sy + current.dy * (offset + 7));
      }
      context.lineWidth = 2.2;
      context.strokeStyle = 'rgba(7,24,40,.83)';
      context.stroke();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(255,255,255,.93)';
      context.stroke();
    }

    function setView(nextView) {
      view = nextView;
      const nextWidth = container.clientWidth, nextHeight = container.clientHeight;
      if (width !== nextWidth || height !== nextHeight) {
        width = nextWidth;
        height = nextHeight;
        const density = Math.min(window.devicePixelRatio || 1, 1.25);
        canvas.width = Math.ceil(width * density);
        canvas.height = Math.ceil(height * density);
        context.setTransform(density, 0, 0, density, 0, 0);
        context.imageSmoothingEnabled = false;
      }
      if (extent) paint();
    }

    function configure({ sample: nextSample = null, heatmap = null, wind = false, stations = [] } = {}) {
      sample = nextSample;
      currents = stations;
      extent = heatmap;
      const count = sample && wind ? Math.min(96, Math.ceil(width * height / 2600)) : 0;
      particles.length = Math.min(particles.length, count);
      while (particles.length < count) {
        const particle = {};
        spawn(particle);
        particles.push(particle);
      }
      if (extent) {
        raster.width = Math.min(160, Math.max(1, Math.ceil(extent.width * view.scale / 5)));
        raster.height = Math.min(128, Math.max(1, Math.ceil(extent.height * view.scale / 5)));
        const image = rasterContext.createImageData(raster.width, raster.height);
        for (let y = 0; y < raster.height; y++) {
          for (let x = 0; x < raster.width; x++) {
            const speed = sample(extent.x + (x + .5) * extent.width / raster.width,
                                 extent.y + (y + .5) * extent.height / raster.height);
            if (speed !== null) image.data.set([...color(speed), 162], (y * raster.width + x) * 4);
          }
        }
        rasterContext.putImageData(image, 0, 0);
        paint();
      } else if (!particles.length && !currents.length) {
        paint();
      }
      setActive(active);
    }

    function setActive(enabled) {
      active = enabled;
      if (!active || (!particles.length && !currents.length)) {
        if (frame !== null) {
          cancel();
          paint();
        }
      } else if (frame === null && width && height) {
        frame = requestAnimationFrame(animate);
      }
    }

    return { clear, configure, setActive, setView };
  }

  return { color, field, create, gradient, stops };
})();
