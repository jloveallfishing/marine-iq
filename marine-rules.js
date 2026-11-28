window.MarineRules = (() => {
  const release = '3.0.2';
  const fields = {
    minimum: 'Minimum size', maximum: 'Maximum size', bag: 'Daily bag limit',
    possession: 'Possession limit', season: 'Season', depth: 'Depth restrictions',
    methods: 'Permitted methods', permits: 'Licenses and permits', special: 'Special restrictions'
  };
  const bayPresets = new Set([0, 1, 3, 8, 9, 10]);
  const deltaPresets = new Set([6, 7, 11, 12]);
  const favoritesKey = 'marinecastFavoriteSpecies';
  const regionPreference = 'marinecastRulesRegion';

  function suggestRegion(trip) {
    if (trip.predefined) {
      if (bayPresets.has(trip.index)) return 'bay';
      if (deltaPresets.has(trip.index)) return 'delta';
      return '';
    }
    // Both place text and a broad sanity check are required. A map coordinate
    // alone cannot distinguish inland, tidal and ocean legal boundaries.
    if (trip.latitude >= 37.39 && trip.latitude <= 38.17 &&
        trip.longitude >= -122.48 && trip.longitude <= -122.13 &&
        /san francisco bay|san pablo bay|berkeley marina|richmond marina|angel island|alcatraz/i.test(trip.name)) return 'bay';
    if (trip.latitude >= 37.75 && trip.latitude <= 38.55 &&
        trip.longitude >= -122.1 && trip.longitude <= -121.25 &&
        /sacramento.san joaquin delta|rio vista|sherman island|delta marina|brannan island|three mile slough|seven mile slough/i.test(trip.name)) return 'delta';
    return '';
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function link(label, url) {
    const element = node('a', label);
    element.href = url;
    return element;
  }

  function dateLabel(date) {
    return date ? date.slice(5,7)+'/'+date.slice(8,10)+'/'+date.slice(0,4) : '';
  }

  function group(label, ...children) {
    const details = node('details', '', 'rule-group');
    details.append(node('summary',label),...children);
    return details;
  }

  function addPhoto(details, asset) {
    const image = node('img');
    image.alt = asset.alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { image.hidden = true; });
    details.addEventListener('toggle', () => {
      if (details.open && !image.hasAttribute('src')) image.src = asset.url;
    });
    const credit = node('p', '', 'muted');
    credit.append(link(asset.credit, asset.source));
    details.append(image, credit);
  }

  function groundfishContext(info, region, tripDate, today, method) {
    const current = info.regions.includes(region) && tripDate >= info.from && tripDate <= info.through &&
      today >= info.verified && today <= info.reviewBy;
    return {current, southernBoat:current && region === 'south' && method === 'boat'};
  }

  function addGroundfish(details, extra, info, data, region, method, context) {
    const {current,southernBoat} = context;
    const limits = node('dl');
    for (const fish of info.limits) {
      const limit = fish.limit ?? (region === 'north' ? fish.north : fish.other);
      const value = !current ? 'Current limit unverified' :
        southernBoat && fish.class.startsWith('Nearshore') ? 'No boat retention during the Southern closure' :
        limit ? limit + ' per person' + (fish.north ? (region === 'north' ? ' · Northern area' : ' · outside Northern area') : '') :
        'Counts toward the combined limit';
      limits.append(node('dt',fish.name));
      const detail = node('dd',value);
      if (fish.image) {
        const photo = group('Photo · '+fish.name);
        addPhoto(photo,fish.image);
        detail.append(photo);
      }
      limits.append(detail);
    }
    details.append(group('Individual species bag limits',limits));
    const prohibited = node('div','','rule-prohibited');
    prohibited.append(node('h3', current ? 'Prohibited retention' : '2026 reference · prohibited retention'));
    for (const fish of info.prohibited) {
      if (fish.image) {
        const photo = group(fish.name);
        addPhoto(photo,fish.image);
        prohibited.append(photo);
      } else prohibited.append(node('p',fish.name));
    }
    details.append(prohibited);
    if (current) {
      let season = 'Check local closures and the applicable depth boundary.';
      if (southernBoat) {
        season = 'October 1–December 31 · Nearshore rockfish, cabezon and greenlings: no boat retention. Shelf and slope rockfish: seaward of the 50-fathom boundary. Groundfish Exclusion Areas still apply.';
      } else if (method === 'shore') {
        season = 'Shore exemption · Year-round for otherwise eligible fish. A vessel cannot assist take, transport or possession.';
      } else if (method === 'dive') {
        season = 'Spearfishing exemption · Year-round for otherwise eligible fish. During boat closures, only spearfishing gear may be aboard under this exemption.';
      } else if (region === 'bay') {
        season = 'Bay waters refer to the San Francisco management table. Verify the applicable water and local boundary.';
      } else if (info.areas[region]) {
        season = 'April 1–December 31 · Published boat season at all depths, subject to local closures.';
      }
      details.append(node('p',season,'rule-retention'));
      if (method !== 'dive') details.append(node('p',method === 'boat'
        ? 'One line, two hooks maximum. Carry a descending device in ocean waters.'
        : 'One line, two hooks maximum when angling for these fish.','rule-retention'));
      else details.append(node('p','Have a descending device available when taking or possessing covered groundfish from a vessel in ocean waters.','rule-retention'));
    }
    extra.append(
      node('p','Example: one retained copper rockfish leaves at most nine slots for other eligible fish.'),
      node('p','Transit exceptions are limited. Possession remains prohibited where a species is prohibited throughout the management area or exceeds its bag limit. Keep gear undeployed unless a specific exception applies.'),
      node('p','The federal waypoints define the 50-fathom (300-foot) boundary. A depth sounder alone cannot determine which side applies.'),
      link(...data.sources.groundfishBoundaries),
      node('p','Groundfish details verified '+dateLabel(info.verified)+' (Pacific).'));
    for (const id of ['rockfishID','copperID','noaaRockfishID','noaaBocaccioID']) {
      const row = node('p');
      row.append(link(...data.sources[id]));
      extra.append(row);
    }
  }

  function ruleCard(species, entries, region, tripDate, today, data, favorites, method) {
    const details = node('details', '', 'rule-card');
    const summary = node('summary', species.name);
    details.append(summary);
    const extra = group('Additional Regulations');
    if (species.scientific) extra.append(node('p',species.scientific,'muted'));
    if (species.image) addPhoto(extra,species.image);
    const regional = entries.filter(entry => entry.regions.includes(region));
    const inDate = entry => tripDate >= entry.from && tripDate <= entry.through &&
      today >= entry.verified && today <= entry.reviewBy;
    const current = regional.filter(inDate);
    const reference = regional.filter(entry => entry.kind === 'reference' && !inDate(entry));
    const restrictions = Object.assign({}, ...current.map(entry => entry.rules));
    const published = Object.assign({}, ...reference.map(entry => entry.rules));
    const groundfish = data.groundfish.species.includes(species.id);
    const context = groundfishContext(data.groundfish,region,tripDate,today,method);
    const statuses = current.map(entry=>entry.status);
    let status = ['closed','retention','conditional','open'].find(key=>statuses.includes(key)) || 'unverified';
    if (groundfish) {
      status = !context.current ? 'unverified' :
        context.southernBoat && species.id !== 'rockfish' ? 'closed' : 'conditional';
    }
    const labels = {closed:'Closed',retention:'No retention',conditional:'Conditional',open:'Season open',unverified:'Unverified'};
    summary.append(node('span',labels[status], 'rule-status rule-status-'+status));
    const ordinaryCount = value => value?.match(/^(\d+) (?:fish|crabs)(?: combined)?(?: under the (?:ordinary|standard) limit)?$/)?.[1];
    const limits = {...restrictions};
    if (groundfish) {
      limits.bag = context.current ? (status === 'closed' ? '0 fish' : '10 fish combined') : null;
      limits.possession = null;
    }
    if (limits.bag === limits.possession || (ordinaryCount(limits.bag) && ordinaryCount(limits.bag) === ordinaryCount(limits.possession))) {
      limits.possession = null;
    }
    const metrics = node('span','','rule-quick-limits');
    for (const key of ['minimum','maximum','bag','possession']) {
      if (limits[key]) metrics.append(node('span',fields[key],'rule-quick-label'),node('strong',limits[key]));
    }
    if (metrics.childElementCount) summary.append(metrics);
    if (groundfish) {
      if (context.current && status !== 'closed') details.append(node('p','Each retained fish counts toward the 10-fish rockfish, cabezon and greenling limit.','rule-retention'));
      addGroundfish(details,extra,data.groundfish,data,region,method,context);
    } else {
      for (const key of ['season','depth','special','methods']) {
        if (restrictions[key] && (key === 'season' || restrictions[key] !== restrictions.season)) {
          details.append(node('p',restrictions[key],'rule-retention'));
        }
      }
    }
    if ((status === 'unverified' || regional.some(entry=>entry.kind !== 'reference'&&!inDate(entry))) && regional.length) {
      details.append(node('p',reference.length ? 'Published reference available below. Fishing status is unverified.'
        : 'Some rules are unverified for this date or region. Check current official notices.','warn'));
    }
    if (restrictions.permits) extra.append(node('p',restrictions.permits));
    const historical = node('dl');
    for (const [key,label] of Object.entries(fields)) {
      if (published[key] && !restrictions[key]) historical.append(node('dt',label),node('dd',published[key]));
    }
    if (historical.childElementCount) extra.append(node('h3','Published reference · verify before use'),historical);
    const dates = new Set([...current,...reference].map(entry=>[
      entry.effective && 'Effective '+dateLabel(entry.effective),
      'Last verified '+dateLabel(entry.verified)
    ].filter(Boolean).join(' · ')));
    for (const date of dates) extra.append(node('p',date,'muted'));
    const sources = new Set([data.regions[region]?.source,...species.sources,
      ...regional.flatMap(entry=>entry.sources)].filter(Boolean));
    const links = node('ul','','rules-links');
    for (const id of sources) {
      const item = node('li');
      item.append(link(...data.sources[id]));
      links.append(item);
    }
    extra.append(node('h3','Official regulatory sources'),links);
    details.append(extra);
    const wrapper = node('section', '', 'rule-section');
    const favorite = node('button', favorites.has(species.id) ? '★' : '☆', 'rule-star');
    favorite.type = 'button';
    favorite.dataset.species = species.id;
    favorite.setAttribute('aria-label', `Favorite ${species.name}`);
    favorite.setAttribute('aria-pressed', String(favorites.has(species.id)));
    wrapper.append(favorite, details);
    return wrapper;
  }

  function install({getTrip, today}) {
    const page = document.getElementById('page-rules');
    const select = document.getElementById('rules-region');
    const search = document.getElementById('rules-search');
    const cards = document.getElementById('rules-cards');
    const method = document.getElementById('rules-method');
    const favoriteOnly = document.getElementById('rules-favorites');
    const ruleDate = document.getElementById('rules-date');
    const useToday = document.getElementById('rules-today');
    const tripDate = document.getElementById('rules-trip-date');
    let favorites = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(favoritesKey) || '[]');
      if (Array.isArray(saved)) favorites = new Set(saved);
    } catch {}
    const context = document.getElementById('rules-context');
    const tripLabel = document.getElementById('rules-trip');
    let data;
    let pending;
    let lastRender;
    let reviewDay;

    function render() {
      if (page.hidden || !data) return;
      const trip = getTrip();
      const date = today();
      const suggested = suggestRegion(trip);
      const selectedDate = ruleDate.value || trip.date || date;
      const region = select.value === 'trip' ? suggested : select.value;
      const query = search.value.trim().toLowerCase();
      const key = JSON.stringify([trip, date, selectedDate, region, select.value, method.value, query, favoriteOnly.checked, [...favorites]]);
      if (key === lastRender) return;
      lastRender = key;
      tripLabel.textContent = `${trip.name || 'No fishing location'} · ${dateLabel(selectedDate)} (Pacific)`;
      const mismatch = Boolean(suggested && region !== suggested);
      context.classList.toggle('warn', mismatch);
      context.classList.toggle('rule-mismatch', mismatch);
      context.textContent = mismatch
        ? `Region mismatch. Showing ${data.regions[region].label}. The trip location suggests ${data.regions[suggested].label}. Confirm the official boundary.`
        : region ? `${select.value === 'trip' ? 'Suggested' : 'Selected'} region: ${data.regions[region].label}. Confirm the official boundary before fishing.`
        : 'Select a region manually for this location. A map pin alone does not establish jurisdiction.';
      document.getElementById('rules-snapshot').textContent =
        `Snapshot verified ${dateLabel(data.verified)} (Pacific). Check current official notices before fishing.`;
      const open = new Set([...cards.querySelectorAll('.rule-card[open]')].map(details => details.dataset.species));
      const rows = data.species.filter(species => (!favoriteOnly.checked || favorites.has(species.id)) &&
        [species.name, species.scientific, ...species.aliases].filter(Boolean).some(name => name.toLowerCase().includes(query)));
      cards.replaceChildren(...rows.map(species => {
        const card = ruleCard(species, data.entries[species.id] || [], region, selectedDate, date, data, favorites, method.value);
        const details = card.querySelector('details');
        details.dataset.species = species.id;
        details.open = open.has(species.id);
        return card;
      }));
      if (!rows.length) cards.append(node('p', favoriteOnly.checked ? 'No favorite species match.' : 'No matching species. Check the official regional regulations.'));
    }

    function refresh() {
      if (page.hidden) return;
      if (data) { render(); return; }
      if (pending) return;
      cards.setAttribute('aria-busy', 'true');
      cards.textContent = 'Loading regulations…';
      pending = fetch('./fishing-rules.json?v=302').then(response => {
        if (!response.ok) throw Error('Rules download failed');
        return response.json();
      }).then(snapshot => {
        if (snapshot.release !== release) throw Error('Rules are from a different release');
        for (const [label, ids] of [
          ['Bay and inland', ['bay','delta','inland']],
          ['Pacific coast', ['north','mendocino','sf','central','south']]
        ]) {
          const group = node('optgroup');
          group.label = label;
          for (const id of ids) group.append(new Option(snapshot.regions[id].label, id));
          select.append(group);
        }
        try {
          const saved = localStorage.getItem(regionPreference);
          if (Object.hasOwn(snapshot.regions, saved)) select.value = saved;
        } catch {}
        data = snapshot;
        render();
      }).catch(() => {
        cards.textContent = 'Regulations unavailable. Use the official links above.';
        const retry = node('button', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', refresh);
        cards.append(retry);
      }).finally(() => {
        pending = null;
        cards.setAttribute('aria-busy', 'false');
      });
    }

    select.addEventListener('change', () => {
      try { localStorage.setItem(regionPreference, select.value); } catch {}
      render();
    });
    search.addEventListener('input', render);
    method.addEventListener('change',render);
    ruleDate.addEventListener('change', render);
    useToday.addEventListener('click', () => { ruleDate.value = today(); render(); });
    tripDate.addEventListener('click', () => { ruleDate.value = ''; render(); });
    favoriteOnly.addEventListener('change', render);
    cards.addEventListener('click', event => {
      const button = event.target.closest('button[data-species]');
      if (!button) return;
      const id = button.dataset.species;
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      try { localStorage.setItem(favoritesKey, JSON.stringify([...favorites])); } catch {}
      if (favoriteOnly.checked && !favorites.has(id)) {
        render();
        favoriteOnly.focus();
      } else {
        button.textContent = favorites.has(id) ? '★' : '☆';
        button.setAttribute('aria-pressed', String(favorites.has(id)));
      }
    });
    new MutationObserver(refresh).observe(page, {attributes: true, attributeFilter: ['hidden']});
    new MutationObserver(render).observe(document.getElementById('pagecontext'), {childList: true});
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => {
      if (!page.hidden && data && reviewDay !== today()) {
        reviewDay = today();
        render();
      }
    }, 60000);
    refresh();
  }
  return {install};
})();
