/* CDFW ds582 geometry is rendered unchanged. Regulatory summaries are separate. */
window.MarineMPA = (() => {
  const catalog = 'https://publish.data.ca.gov/dataset/california-marine-protected-areas-ds582';
  const cdfw = 'https://wildlife.ca.gov/Conservation/Marine/MPAs';
  const bay = cdfw + '/San-Francisco-Bay';
  const regulations = 'https://wildlife.ca.gov/Fishing/Ocean';
  const section632 = 'https://wildlife.ca.gov/CCR-T14-MPAs';
  const snapshot = './mpa-boundaries.geojson?v=28';
  const snapshotCache = 'marinecast-mpa-v28';
  const federal = 'https://channelislands.noaa.gov/management/regulations.html';
  const feetPerMeter = 3.280839895;
  const metersPerDegree = Math.PI * 6371008.8 / 180;
  const margin = 10;
  const proximity = 500 / feetPerMeter;
  const maxAccuracy = 100;
  const maxAge = 30000;
  const styles = {
    red: ['#bf293b', 'No recreational take'],
    orange: ['#a24c10', 'Restricted fishing'],
    purple: ['#7445a4', 'Special closures or access restrictions'],
    gray: ['#576477', 'Restrictions not verified']
  };
  const summaries = [
    [/^robert w\.? crown|^crown\b/i, bay, 'Restricted recreational take.', 'Recreational take of finfish by hook and line only is allowed.'],
    [/^fagan marsh/i, bay, 'Only lightweight, hand-carried boats may be launched or operated.', 'Recreational hook-and-line take is allowed for species other than marine aquatic plants.'],
    [/^peytonia slough/i, bay, 'Only lightweight, hand-carried boats may be launched or operated.', 'Recreational hook-and-line take from shore is allowed for species other than marine aquatic plants.'],
    [/^corte madera marsh/i, bay, 'Only lightweight, hand-carried boats may be launched or operated. Swimming, wading and diving are prohibited.', 'Recreational hook-and-line take from shore is allowed for species other than marine aquatic plants.'],
    [/^marin islands/i, bay, 'Boating, swimming, wading and diving are prohibited.', 'Recreational hook-and-line take from shore is allowed for species other than marine aquatic plants.'],
    [/^albany mudflats/i, bay, 'Boating, swimming, wading and diving are prohibited.', 'Recreational hook-and-line take from shore is allowed for species other than marine aquatic plants.'],
    [/^redwood shores/i, bay, 'Only lightweight, hand-carried boats may be launched or operated.', 'Recreational hook-and-line take is allowed for species other than marine aquatic plants.'],
    [/^bair island/i, bay, 'Entry is restricted February 15 through May 20, subject to official exceptions. Boating, swimming, wading and diving are prohibited.', 'Recreational hook-and-line take from shore is allowed for species other than kelp, subject to access restrictions. Check the official waterfowl rules.'],
    [/^point reyes state marine conservation area$/i, cdfw + '/Point-Reyes', 'Area-specific take restrictions apply.', 'Recreational take of salmon by trolling and Dungeness crab by trap is allowed under the area rules.']
  ];

  function details(properties) {
    const name = properties.FULLNAME || properties.NAME || 'Unnamed protected area';
    const type = String(properties.Type || '').trim().toUpperCase();
    const summary = summaries.find(([match]) => match.test(name));
    const isFederal = ['FMR', 'FMCA'].includes(type);
    let category = 'gray';
    if (type.includes('CLOSURE') || /^bair island/i.test(name)) category = 'purple';
    else if (type === 'SMR' || type === 'SMCA (NO-TAKE)') category = 'red';
    else if (['SMCA', 'SMP', 'SMRMA'].includes(type)) category = 'orange';
    const restriction = summary?.[2] || {
      red: 'The state designation prohibits recreational take. Check the area rule for other restrictions.',
      orange: 'Fishing restrictions vary by species, gear and location. Consult the area rule before fishing.',
      purple: 'Access may be restricted by season, activity or location. Consult the area rule before entering.',
      gray: 'MarineCast has no verified restriction summary for this record.'
    }[category];
    return {name, type, category, restriction, isFederal, section: properties.CCR,
      permitted: summary?.[3] || 'Check the official area rule for permitted activities and exceptions.',
      url: summary?.[1] || (isFederal ? federal : /bay|^sf/i.test(properties.Study_Regi || '') ? bay : cdfw)};
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
      if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
    }
    return inside;
  }

  function buildIndex(collection) {
    if (collection.type !== 'FeatureCollection' || !collection.features?.length) {
      throw Error('No boundary features available');
    }
    return collection.features.map(feature => {
      const {type, coordinates} = feature.geometry;
      const polygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : null;
      if (!polygons?.length) throw Error('Unsupported boundary geometry');
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
      for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
        west = Math.min(west, x);
        south = Math.min(south, y);
        east = Math.max(east, x);
        north = Math.max(north, y);
      }
      return {polygons, west, south, east, north, feature,
        id: feature.properties.OBJECTID, ...details(feature.properties)};
    });
  }

  function nearestBoundaries(index, longitude, latitude, accuracy) {
    const lonScale = metersPerDegree * Math.cos(latitude * Math.PI / 180);
    const radius = accuracy + margin;
    const candidates = index.map(area => {
      const x = Math.max(area.west - longitude, longitude - area.east, 0) * lonScale;
      const y = Math.max(area.south - latitude, latitude - area.north, 0) * metersPerDegree;
      return {area, lower: Math.hypot(x, y)};
    }).sort((a, b) => a.lower - b.lower);
    const nearby = [], relevant = [];
    for (const {area, lower} of candidates) {
      // Never skip a possible inside, uncertain, or proximity result.
      if (nearby.length === 3 && lower > Math.max(nearby[2].distance, proximity + radius)) break;
      const inside = lower === 0 && area.polygons.some(([exterior, ...holes]) =>
        pointInRing(longitude, latitude, exterior) && !holes.some(ring => pointInRing(longitude, latitude, ring)));
      let square = Infinity;
      for (const polygon of area.polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
        const x = (ax - longitude) * lonScale, y = (ay - latitude) * metersPerDegree;
        const dx = (bx - ax) * lonScale, dy = (by - ay) * metersPerDegree;
        const length = dx * dx + dy * dy;
        const t = length ? Math.max(0, Math.min(1, -(x * dx + y * dy) / length)) : 0;
        square = Math.min(square, (x + dx * t) ** 2 + (y + dy * t) ** 2);
      }
      const distance = Math.sqrt(square);
      const relation = distance <= radius ? 'uncertain' : inside ? 'inside' : 'outside';
      const item = {area, distance, relation};
      nearby.push(item);
      nearby.sort((a, b) => a.distance - b.distance);
      if (nearby.length > 3) nearby.pop();
      if (relation !== 'outside' || distance <= proximity + radius) relevant.push(item);
    }
    return {nearby, relevant};
  }

  function readFix(position, now = Date.now()) {
    const {latitude, longitude, accuracy} = position.coords;
    const time = position.timestamp;
    if (![latitude, longitude, accuracy, time].every(Number.isFinite) || Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 || accuracy <= 0 || time < now - maxAge || time > now + 5000) return null;
    return {latitude, longitude, accuracy, time, reliable: accuracy <= maxAccuracy};
  }

  function warningText(result, entries, lastMessage = '') {
    if (entries.length) return 'Possible boundary entry · ' + entries.join(', ') + '. Verify the official rules.';
    if (result.relevant.some(r => r.relation === 'uncertain')) return 'GPS uncertainty could overlap a mapped boundary.';
    const nearest = result.nearby[0];
    if (nearest && nearest.relation === 'outside' && nearest.distance <= proximity + result.accuracy + margin) {
      return 'Near a mapped boundary · ' + nearest.area.name + '.';
    }
    return lastMessage.startsWith('Possible boundary entry') && result.relevant.some(r => r.relation === 'inside')
      ? lastMessage : 'Monitoring mapped boundaries while MarineCast is visible.';
  }

  function boundaryEntries(results, states, previouslyReliableOutside, time) {
    const entries = [], currentIds = new Set();
    for (const result of results) {
      const {id, name} = result.area;
      currentIds.add(id);
      const state = states.get(id) || {outside: previouslyReliableOutside, count: 0, time: 0};
      if (result.relation === 'outside') { state.outside = true; state.count = 0; }
      else if (result.relation === 'uncertain') { state.count = 0; }
      else if (state.outside && state.time < time) {
        if (++state.count >= 2) { entries.push(name); state.outside = false; state.count = 0; }
      }
      state.time = time;
      states.set(id, state);
    }
    // A previously nearby area that is absent from the relevant set is certainly outside.
    for (const id of states.keys()) if (!currentIds.has(id)) states.delete(id);
    return entries;
  }

  const el = id => document.getElementById(id);
  const element = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  function link(text, href) {
    const a = element('a', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function popup(properties) {
    const d = details(properties), node = element('div', '');
    node.append(element('strong', d.name), element('p', styles[d.category][1]),
      element('p', d.restriction), element('p', d.permitted));
    if (d.section) node.append(element('p', 'CDFW dataset reference · ' + d.section));
    node.append(link('Official area information', d.url), element('br', ''));
    if (!d.isFederal) node.append(link('California Title 14 §632', section632), element('br', ''));
    node.append(link('CDFW Ocean Sport Fishing regulations', regulations));
    return node;
  }

  function displayDistance(meters) {
    const feet = meters * feetPerMeter;
    return feet < 5280 ? Math.round(feet / 10) * 10 + ' ft' : (feet / 5280).toFixed(1) + ' mi';
  }

  function install({weatherMap, createBasemap, getSpots, searchPlaces}) {
    const page = el('page-mpa'), status = el('mpaStatus'), weatherToggle = el('weatherMPA');
    const visible = () => !document.hidden;
    const mpaVisible = () => !page.hidden && visible();
    const banner = el('mpaAppAlert'), bannerText = el('mpaAppAlertText');
    const positionStatus = el('mpaPosition'), warning = el('mpaWarning'), alerts = el('mpaAlerts');
    let map, layer, weatherLayer, data, index, loading, watch = null, lastFix = null, accuracyCircle, marker;
    let expiration, outsideSinceStart = false, lastProcessed = 0, centerOnFix = false, watchRevision = 0;
    const states = new Map();
    const featureLayers = new Map();

    function load() {
      if (!loading) loading = (async () => {
        const request = new Request(snapshot);
        const cache = await window.caches?.open(snapshotCache).catch(() => null);
        const saved = await cache?.match(request).catch(() => null);
        const response = saved || await fetch(request);
        if (!response.ok) throw Error('Boundary download failed');
        const offline = !saved && cache ? response.clone() : null;
        const collection = await response.json();
        if (collection.source?.dataset !== 'California Marine Protected Areas [ds582]' ||
            collection.features?.length !== collection.source.count) throw Error('Unrecognized CDFW snapshot');
        index = buildIndex(collection);
        if (offline) await cache.put(request, offline).catch(() => {});
        data = collection;
        const date = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',dateStyle:'medium'});
        el('mpaSourceDate').textContent = ' CDFW layer edit ' + date.format(new Date(data.source.lastEdit)) +
          ' PT · Snapshot retrieved ' + date.format(new Date(data.source.retrieved)) + ' PT.';
        return data;
      })().catch(error => { loading = null; throw error; });
      return loading;
    }

    function render(target, registry) {
      const order = ['gray', 'orange', 'red', 'purple'];
      const features = data.features.map(feature => ({feature, category: details(feature.properties).category}))
        .sort((a,b) => order.indexOf(a.category) - order.indexOf(b.category)).map(item => item.feature);
      return L.geoJSON({...data, features}, {
        smoothFactor: 0,
        style: feature => ({color: styles[details(feature.properties).category][0], weight: 2,
          opacity: 1, fillOpacity: .32}),
        onEachFeature(feature, path) {
          path.bindPopup(() => popup(feature.properties), {maxWidth: 275});
          if (registry) registry.set(feature.properties.OBJECTID, path);
        }
      }).addTo(target);
    }

    async function open() {
      if (!window.L) { status.textContent = 'Map unavailable. Official sources are linked below.'; return; }
      if (!map) {
        map = L.map('mpaMap', {preferCanvas: true, maxZoom: 19}).setView([36.8, -121.4], 6);
        createBasemap(L).addTo(map);
        L.control.scale({metric: false}).addTo(map);
      }
      requestAnimationFrame(() => { if (!page.hidden) map.invalidateSize({pan:false}); });
      if (!layer) {
        status.textContent = 'Loading CDFW boundaries…';
        try {
          await load();
          if (!layer) layer = render(map, featureLayers);
          status.textContent = index.length + ' mapped areas from the CDFW snapshot.';
          if (lastFix && mpaVisible()) displayFix(lastFix);
        } catch { status.textContent = 'Boundary data unavailable. Use the official CDFW map below.'; }
      }
    }

    weatherToggle.onchange = async () => {
      const message = el('weatherMPAStatus');
      if (!weatherToggle.checked) { weatherLayer?.remove(); message.textContent = ''; return; }
      if (!weatherMap) { message.textContent = 'Weather map unavailable.'; weatherToggle.checked = false; return; }
      message.textContent = 'Loading CDFW boundaries…';
      try {
        await load();
        if (!weatherToggle.checked) return;
        if (!weatherLayer) weatherLayer = render(weatherMap);
        else weatherLayer.addTo(weatherMap);
        message.replaceChildren(document.createTextNode('CDFW MPA overlay. Unshaded water can have other fishing restrictions. '),
          link('Boundary source', catalog), document.createTextNode(' · '), link('Official rules', cdfw));
      } catch { weatherToggle.checked = false; message.textContent = 'MPA boundaries unavailable.'; }
    };

    function chooseArea(area) {
      const path = featureLayers.get(area.id);
      if (!path) return;
      const bounds = path.getBounds();
      map.fitBounds(bounds, {padding: [20, 20], maxZoom: 14});
      path.openPopup(bounds.getCenter());
    }

    el('mpaBay').onclick = () => map?.setView([37.82, -122.36], 9);
    el('mpaCoast').onclick = () => {
      if (layer) map.fitBounds(layer.getBounds(), {padding:[12,12], maxZoom:6});
      else map?.setView([36.8, -121.4], 6);
    };
    el('mpaSearch').onsubmit = async event => {
      event.preventDefault();
      const input = el('mpaQuery'), results = el('mpaResults'), query = input.value.trim();
      results.replaceChildren();
      if (!map || query.length < 3) { results.textContent = 'Enter at least three characters.'; return; }
      const key = query.toLowerCase();
      const localAreas = (index || []).filter(area => area.name.toLowerCase().includes(key)).slice(0, 8);
      const localPlaces = getSpots().filter(([name]) => name.toLowerCase().includes(key)).slice(0, 4);
      const add = (name, action) => {
        const button = element('button', name);
        button.type = 'button';
        button.onclick = action;
        results.append(button);
      };
      for (const area of localAreas) add(area.name, () => chooseArea(area));
      for (const [name, lat, lon] of localPlaces) add(name, () => map.setView([lat, lon], 12));
      if (results.childElementCount) return;
      const button = el('mpaSearchButton');
      if (button.disabled) return;
      button.disabled = true;
      results.textContent = 'Searching California…';
      try {
        const rows = await searchPlaces(query);
        if (input.value.trim() !== query) return;
        results.textContent = rows.length ? '' : 'No matches. Try an MPA name, nearby town, or marina.';
        for (const [name, lat, lon] of rows) add(name, () => map.setView([lat, lon], 12));
      } catch { results.textContent = 'Online search unavailable. Saved places and loaded MPA names can still be searched.'; }
      finally { button.disabled = false; }
    };

    function syncBanner() {
      banner.hidden = !(alerts.checked && visible() && page.hidden && warning.textContent);
      if (bannerText.textContent !== warning.textContent) bannerText.textContent = warning.textContent;
    }

    function setWarning(text) {
      if (warning.textContent !== text) warning.textContent = text;
      syncBanner();
    }

    function resetWarning(text = '') {
      states.clear();
      outsideSinceStart = false;
      setWarning(text);
    }

    function clearFix(message) {
      clearTimeout(expiration);
      lastFix = null;
      centerOnFix = false;
      marker?.remove();
      accuracyCircle?.remove();
      marker = accuracyCircle = null;
      positionStatus.textContent = message;
      el('mpaNearby').replaceChildren();
      resetWarning(alerts.checked ? 'Alerts paused until a fresh location is available.' : '');
    }

    function displayFix(fix) {
      if (!map || !visible()) return;
      if (mpaVisible()) {
        const coordinates = [fix.latitude, fix.longitude];
        if (!marker) marker = L.circleMarker(coordinates,{radius:6,color:'#fff',weight:2,fillColor:'#00729b',fillOpacity:1}).addTo(map);
        else marker.setLatLng(coordinates);
        if (!accuracyCircle) accuracyCircle = L.circle(coordinates,{radius:fix.accuracy,color:'#00729b',fillOpacity:.1,interactive:false}).addTo(map);
        else accuracyCircle.setLatLng(coordinates).setRadius(fix.accuracy);
        marker.bringToFront();
        if (centerOnFix) { map.setView(coordinates, 13); centerOnFix = false; }
      }
      const uncertainty = ' · Reported GPS accuracy ±' + Math.ceil(fix.accuracy * feetPerMeter) + ' ft.';
      if (!index) { positionStatus.textContent = 'Location found. Boundary data unavailable' + uncertainty; return; }
      const result = nearestBoundaries(index, fix.longitude, fix.latitude, fix.accuracy);
      const inside = result.relevant.filter(r => r.relation === 'inside');
      const uncertain = result.relevant.some(r => r.relation === 'uncertain');
      positionStatus.textContent = (uncertain ? 'Boundary position uncertain' :
        inside.length ? 'Inside mapped area · ' + inside.map(r => r.area.name).join(', ') :
        'Outside the mapped areas at this fix') + uncertainty;
      el('mpaNearby').replaceChildren(...result.nearby.map(r => {
        const item = element('li', '');
        const button = element('button', r.area.name);
        button.type = 'button';
        button.onclick = () => chooseArea(r.area);
        const label = r.relation === 'inside' ? 'inside' : r.relation === 'uncertain' ? 'uncertain' : 'outside';
        item.append(button, element('span', 'Approx. ' + displayDistance(r.distance) + ' to boundary · ' + label));
        return item;
      }));
      if (!alerts.checked) return;
      if (!fix.reliable) { resetWarning('GPS accuracy is too low for reliable proximity or entry warnings.'); return; }
      const entries = boundaryEntries(result.relevant, states, outsideSinceStart, fix.time);
      outsideSinceStart = true;
      setWarning(warningText({...result, accuracy:fix.accuracy}, entries, warning.textContent));
    }

    function handleFix(position, revision, throttle) {
      if ((!mpaVisible() && !(visible() && alerts.checked)) || revision !== watchRevision) return;
      const fix = readFix(position);
      if (!fix) { clearFix('Location fix is stale or unavailable. Request a fresh position.'); return; }
      if (throttle && fix.time - lastProcessed < 2300 && !centerOnFix) return;
      lastProcessed = fix.time;
      lastFix = fix;
      clearTimeout(expiration);
      expiration = setTimeout(() => clearFix('Location is stale. Request a fresh position.'), maxAge - (Date.now() - fix.time));
      displayFix(fix);
    }

    function stopWatch() {
      watchRevision++;
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      watch = null;
      lastProcessed = 0;
      resetWarning();
    }

    function syncWatch() {
      if (!visible() || !alerts.checked || !navigator.geolocation) { stopWatch(); return; }
      if (watch !== null) return;
      const revision = ++watchRevision;
      setWarning('Waiting for a current GPS fix…');
      watch = navigator.geolocation.watchPosition(position => handleFix(position, revision, true), () => {
        if (revision === watchRevision) clearFix('GPS unavailable. Check location permissions.');
      }, {enableHighAccuracy:false, maximumAge:0, timeout:15000});
    }

    el('mpaLocate').onclick = () => {
      if (!navigator.geolocation) { positionStatus.textContent = 'GPS unavailable in this browser.'; return; }
      centerOnFix = true;
      positionStatus.textContent = 'Requesting your position…';
      const revision = watchRevision;
      navigator.geolocation.getCurrentPosition(position => handleFix(position, revision, false), () => {
        if (revision === watchRevision) { centerOnFix = false; clearFix('GPS unavailable. Check location permissions.'); }
      }, {enableHighAccuracy:true, maximumAge:0, timeout:15000});
    };

    alerts.onchange = () => { syncWatch(); syncBanner(); };
    el('mpaStopAlerts').onclick = () => { alerts.checked = false; alerts.onchange(); };
    const syncPage = () => {
      if (mpaVisible()) {
        open();
        if (lastFix) displayFix(lastFix);
      }
      if (visible() && (mpaVisible() || alerts.checked)) syncWatch();
      else { stopWatch(); clearFix('Use GPS to check your position against mapped areas.'); }
      syncBanner();
    };
    new MutationObserver(syncPage).observe(page,{attributes:true,attributeFilter:['hidden']});
    document.addEventListener('visibilitychange', syncPage);
    syncPage();
  }

  return {install, details, buildIndex, nearestBoundaries, readFix, boundaryEntries, catalog};
})();
