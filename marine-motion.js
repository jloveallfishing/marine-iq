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
      const weights = [(xs[col + 1] - x) / (xs[col + 1] - xs[col]), (ys[row + 1] - y) / (ys[row + 1] - ys[row])];
      const blend = items => {
        const [wx, wy] = weights;
        return (items[0] * wx + items[1] * (1 - wx)) * wy +
               (items[2] * wx + items[3] * (1 - wx)) * (1 - wy);
      };
      if (vector) {
        if (corners.some(corner => !corner?.vector)) return null;
        return [blend(corners.map(corner => corner.vector[0])), blend(corners.map(corner => corner.vector[1]))];
      }
      if (corners.some(corner => corner?.speed == null)) return null;
      return blend(corners.map(corner => corner.speed));
    };
  }

  function create(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'marine-flow';
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    const context = canvas.getContext('2d');
    const raster = document.createElement('canvas');
    const rasterContext = raster.getContext('2d');
    if (!context || !rasterContext) {
      canvas.remove();
      return null;
    }
    let width = 0, height = 0, scale = 1, frame = null, last = null, heat = false;
    let particles = [], currents = [], sample = null;

    function paint() {
      context.clearRect(0, 0, width, height);
      if (heat) context.drawImage(raster, 0, 0, width, height);
    }

    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = last = null;
      paint();
    }

    function spawn(particle) {
      particle.x = Math.random() * width;
      particle.y = Math.random() * height;
      particle.life = 15 + Math.random() * 40;
    }

    function animate(now) {
      frame = requestAnimationFrame(animate);
      if (last !== null && now - last < 40) return;
      last = now;
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.fillStyle = 'rgba(0,0,0,.82)';
      context.fillRect(0, 0, width, height);
      context.restore();
      context.beginPath();
      for (const particle of particles) {
        const { x, y } = particle;
        const velocity = sample(x, y, true);
        if (!velocity || particle.life-- <= 0) {
          spawn(particle);
          continue;
        }
        const speed = Math.hypot(...velocity);
        if (speed < .2) continue;
        const distance = Math.min(speed * .18, 5);
        const nx = x + velocity[0] / speed * distance, ny = y + velocity[1] / speed * distance;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !sample(nx, ny, true)) {
          spawn(particle);
          continue;
        }
        context.moveTo(x, y);
        context.lineTo(nx, ny);
        particle.x = nx;
        particle.y = ny;
      }
      for (const current of currents) {
        current.phase = (current.phase + Math.min(.12, .03 + current.speed * .025)) % 1;
        const offset = 8 + current.phase * 15;
        context.moveTo(current.x + current.dx * offset, current.y + current.dy * offset);
        context.lineTo(current.x + current.dx * (offset + 7), current.y + current.dy * (offset + 7));
      }
      context.lineWidth = 2.2;
      context.strokeStyle = 'rgba(7,24,40,.83)';
      context.stroke();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(255,255,255,.93)';
      context.stroke();
    }

    function configure({ sample: nextSample = null, heatmap = false, stations = [] } = {}) {
      stop();
      width = container.clientWidth;
      height = container.clientHeight;
      scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.imageSmoothingEnabled = false;
      sample = nextSample;
      currents = stations.filter(point => point.x >= 0 && point.x < width && point.y >= 0 && point.y < height);
      particles = sample && !heatmap
        ? Array.from({ length: Math.min(160, Math.ceil(width * height / 2100)) }, () => {
            const particle = {};
            spawn(particle);
            return particle;
          })
        : [];
      heat = heatmap && !!sample && width > 0 && height > 0;
      if (heat) {
        raster.width = Math.min(128, Math.ceil(width / 4));
        raster.height = Math.min(128, Math.ceil(height / 4));
        const image = rasterContext.createImageData(raster.width, raster.height);
        for (let y = 0; y < raster.height; y++) {
          for (let x = 0; x < raster.width; x++) {
            const speed = sample((x + .5) * width / raster.width, (y + .5) * height / raster.height);
            if (speed === null) continue;
            image.data.set([...color(speed), 162], (y * raster.width + x) * 4);
          }
        }
        rasterContext.putImageData(image, 0, 0);
      }
      paint();
    }

    function setActive(active) {
      if (!active) {
        if (frame !== null) stop();
      } else if (frame === null && (particles.length || currents.length)) {
        frame = requestAnimationFrame(animate);
      }
    }

    return { configure, setActive };
  }

  return { color, field, create, gradient, stops };
})();
