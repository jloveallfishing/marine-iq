/* Regional NWS forecasts are interpolated only inside a cell with four valid corners. */
window.MarineMotion = (() => {
  const palette = [[32, 102, 173], [21, 158, 143], [242, 206, 71], [225, 91, 55], [142, 52, 153]];
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
    let opacity = .64, cameraAt = 0;
    let view = {x: 0, y: 0, scale: 1};

    function paint() {
      context.clearRect(0, 0, width, height);
      if (!extent) return;
      const {x, y, scale} = view;
      context.save();
      context.beginPath();
      for (const cell of extent.cells) {
        context.rect((cell.x - x) * scale, (cell.y - y) * scale, cell.width * scale, cell.height * scale);
      }
      context.clip();
      context.imageSmoothingEnabled = true;
      context.drawImage(raster, (extent.x - x) * scale, (extent.y - y) * scale,
                        extent.width * scale, extent.height * scale);
      context.restore();
    }

    function cancel() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = last = null;
    }

    function clear() {
      cancel();
      extent = sample = null;
      canvas.style.opacity = '';
      canvas.style.visibility = 'hidden';
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
      if (last !== null && now - last < (now - cameraAt < 120 ? 49 : 32)) return;
      const elapsed = last === null ? 1 : Math.min(1.5, (now - last) / 40);
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
        const step = elapsed * Math.min(Math.max(speed * .28, .8), 7) / (speed * scale);
        const nx = particle.x + velocity[0] * step, ny = particle.y + velocity[1] * step;
        if (!sample(nx, ny, true)) {
          spawn(particle);
          continue;
        }
        particle.trail.push([particle.x, particle.y]);
        if (particle.trail.length > 6) particle.trail.shift();
        const trail = particle.trail;
        context.moveTo((trail[0][0] - x) * scale, (trail[0][1] - y) * scale);
        for (let i = 1; i < trail.length; i++) {
          context.lineTo((trail[i][0] - x) * scale, (trail[i][1] - y) * scale);
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
      if (nextView.x !== view.x || nextView.y !== view.y || nextView.scale !== view.scale) cameraAt = performance.now();
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
      const phases = new Map(currents.map(station => [station.id, station.phase]));
      currents = stations.map(station => ({ ...station, phase: phases.get(station.id) ?? 0 }));
      extent = heatmap;
      canvas.style.opacity = extent ? String(opacity) : '';
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
            if (speed !== null) image.data.set([...color(speed), 255], (y * raster.width + x) * 4);
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
      const hasFlow = particles.length || currents.length;
      canvas.style.visibility = extent || (active && hasFlow) ? '' : 'hidden';
      if (!active || !hasFlow) {
        if (frame !== null) {
          cancel();
          paint();
        }
      } else if (frame === null && width && height) {
        frame = requestAnimationFrame(animate);
      }
    }

    function setOpacity(value) {
      opacity = value;
      if (extent) canvas.style.opacity = String(opacity);
    }

    return { clear, configure, setActive, setView, setOpacity };
  }

  return { color, field, create, gradient, stops };
})();
