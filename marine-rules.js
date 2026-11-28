window.MarineRules = (() => {
  const release = '3.0.1';
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

  function paragraphs(...text) {
    return text.map(value => node('p',value));
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

  function addGroundfish(details, info, data, region, tripDate, today, method) {
    const dated = tripDate >= info.from && tripDate <= info.through &&
      today >= info.verified && today <= info.reviewBy;
    const context = info.regions.includes(region);
    const holding = dated && context;
    const split = region === 'north' ? 'Northern area' : 'outside Northern area';
    const southernBoatClosure = holding && region === 'south' && method === 'boat';
    const pending = 'Status unavailable for the selected date or area. Use the current official rules.';
    details.append(group('Combined daily bag limit', ...paragraphs(holding
      ? 'Up to 10 rockfish, cabezon and eligible greenlings combined per person where retention is allowed. Each retained fish counts toward those 10. For example, one copper rockfish leaves up to nine spots for other eligible fish, subject to their own sublimits.'
      : 'Published reference: CDFW lists a 10-fish combined limit for the 2026 complex. ' + pending)));
    const limits = node('dl');
    for (const fish of info.limits) {
      const limit = fish.limit ?? (region === 'north' ? fish.north : fish.other);
      const value = southernBoatClosure && fish.class.startsWith('Nearshore')
        ? 'No boat retention during the Southern closure'
        : holding && limit ? limit + ' per person where retained' + (fish.north ? ' · ' + split : '') : '';
      limits.append(node('dt',fish.name),node('dd',[value,fish.class,fish.note].filter(Boolean).join(' · ')));
    }
    details.append(group('Individual species bag limits', ...(holding ? [] : paragraphs(pending)), limits));
    const banned = info.prohibited.map(fish => fish.name).join(' · ');
    details.append(group('Prohibited species and retention', ...paragraphs(
      (holding ? 'Zero retention: ' : '2026 published no-retention list: ') + banned + '. These fish do not belong in a retained bag.')));
    const coast = info.areas[region];
    let season = pending;
    if (holding && coast && method !== 'shore' && method !== 'dive') {
      season = region === 'south'
        ? 'Published June schedule for October 1–December 31: nearshore rockfish, cabezon and greenlings closed to boat-based take and possession throughout the area. Shelf and slope rockfish are restricted to seaward of the 50-fathom line. Check CDFW in-season notices and Groundfish Exclusion Areas for changes.'
        : 'Published April 1–December 31 boat season allows all depths in this management area. Local area closures, including Rockfish Conservation Areas and MPAs where applicable, still control.';
    } else if (holding && (method === 'shore' || method === 'dive')) {
      season = 'CDFW’s shore and spearfishing exemptions generally apply year-round. The retained species and method conditions below still apply.';
    } else if (holding && region === 'bay') {
      season = 'The Bay summary directs anglers to the San Francisco Management Area table. Confirm the exact Bay water and any local restrictions before fishing.';
    }
    const calendar = holding && coast && method === 'boat'
      ? region === 'south'
        ? '2026 published boat calendar: January–March closed; April–June all depths; July–September shoreward of the 50-fathom line. The October–December restrictions are above.'
        : '2026 published boat calendar: January 1–March 31 closed.'
      : '';
    details.append(group('Regional fishing seasons', ...paragraphs(season,
      ...[calendar].filter(Boolean),
      coast ? 'Management area: ' + coast + '.' : 'Choose an ocean management area to see its boundary.',
      'Summary verified ' + dateLabel(info.verified) + ' (Pacific).')));
    details.append(group('Boat versus shore fishing', ...paragraphs(
      holding ? 'Boat regulations depend on the management area. Shore-based anglers may use the shore exemption only without a vessel assisting take, transport or possession. When boat groundfish fishing is closed, a vessel used for the diving exemption may carry only spearfishing gear.' : pending)));
    details.append(group('Depth restrictions and regulatory boundary lines', ...paragraphs(
      'A 50-fathom Rockfish Conservation Area line means 300 feet in the regulation’s name. Its connected federal waypoints define the boundary, so a depth sounder reading alone does not establish which side you are on.'),
      link(...data.sources.groundfishBoundaries)));
    details.append(group('Fishing gear and hook restrictions', ...paragraphs(holding
      ? 'When angling for these fish, use one line with at most two hooks. In ocean waters a boat taking or possessing covered groundfish must have a descending device immediately available. Additional local gear restrictions can apply.' : pending)));
    details.append(group('Transit restrictions', ...paragraphs(holding
      ? 'Section 27.20 has a transit and possession exception for some area closures. It does not allow possession in a management area where that species is prohibited in all its waters or above that area’s bag limit. Gear generally must be undeployed, subject to the specified hoop net, crab trap and dip-net exceptions.' : pending)));
    const photos = [...info.prohibited,...info.limits].filter(fish=>fish.image).map(fish=>{
      const photo = group(fish.name);
      addPhoto(photo,fish.image);
      return photo;
    });
    details.append(group('Fish identification guide', ...paragraphs(
      'Check multiple identifying features in the official comparison guides. If identification is uncertain, avoid keeping the fish.'),
      ...['rockfishID','copperID','noaaRockfishID','noaaBocaccioID'].map(id=>{
        const item = node('p');
        item.append(link(...data.sources[id]));
        return item;
      }),...photos));
  }

  function ruleCard(species, entries, region, tripDate, today, data, favorites, method) {
    const details = node('details', '', 'rule-card');
    const summary = node('summary', species.name);
    details.append(summary);
    if (species.scientific) details.append(node('p', species.scientific, 'muted'));
    if (species.image) addPhoto(details,species.image);
    const regional = entries.filter(entry => entry.regions.includes(region));
    const inDate = entry => tripDate >= entry.from && tripDate <= entry.through &&
      today >= entry.verified && today <= entry.reviewBy;
    const current = regional.filter(inDate);
    if (current.length) summary.after(node('p', 'Verified summary for the selected date · check local exceptions', 'muted'));
    const reference = regional.filter(entry => entry.kind === 'reference' && !inDate(entry));
    const restrictions = Object.assign({}, ...current.map(entry => entry.rules));
    const published = Object.assign({}, ...reference.map(entry => entry.rules));
    const preview = [
      restrictions.minimum?.length <= 40 && 'Min ' + restrictions.minimum,
      restrictions.bag?.length <= 40 && 'Bag ' + restrictions.bag,
      restrictions.possession?.length <= 40 && 'Possession ' + restrictions.possession
    ].filter(Boolean).join(' · ');
    summary.append(node('span', preview || (current.length ? 'See restrictions' :
      reference.length ? 'Published reference only' : 'No verified rules for this region/date'), 'muted rule-preview'));
    if (!current.length || regional.some(entry => entry.kind !== 'reference' && !inDate(entry))) {
      details.append(node('p', reference.length
        ? 'Some information is published reference only. Fishing status for the selected date is unverified.'
        : 'Some rules are unverified for this date or region. Check current official notices.', 'warn'));
    }
    function ruleRows(values, keys, historical = false) {
      const rows = node('dl');
      for (const key of keys) {
        if (values[key] && (!historical || !restrictions[key])) rows.append(node('dt', fields[key]), node('dd', values[key]));
      }
      return rows;
    }
    if (species.groups) {
      for (const [label,keys] of [
        ['Size, bag and possession limits',['minimum','maximum','bag','possession']],
        ['Season and closure details',['season','depth','special']],
        ['Fishing methods and permits',['methods','permits']]
      ]) {
        const rows = ruleRows(restrictions,keys);
        if (rows.childElementCount) details.append(group(label,rows));
      }
      const rows = ruleRows(published,Object.keys(fields),true);
      if (rows.childElementCount) details.append(group('Published reference · verify before use',rows));
    } else {
      const rows = ruleRows(restrictions,Object.keys(fields));
      if (rows.childElementCount) details.append(rows);
      const historical = ruleRows(published,Object.keys(fields),true);
      if (historical.childElementCount) details.append(node('h3','Published reference · verify before use'),historical);
    }
    if (current.length < regional.length || ['minimum','maximum','bag','possession','season'].some(key => !restrictions[key])) {
      details.append(node('p', 'Unlisted limits or conditions need official confirmation. Check local boundaries and closures.', 'muted'));
    }
    const dates = new Set([...current, ...reference].map(entry => [
        entry.effective && `Effective ${dateLabel(entry.effective)}`,
        `Last verified ${dateLabel(entry.verified)}`
    ].filter(Boolean).join(' · ')));
    for (const date of dates) details.append(node('p', date, 'muted'));
    const sources = new Set([data.regions[region]?.source, ...species.sources,
      ...regional.flatMap(entry => entry.sources)].filter(Boolean));
    const list = node('ul', '', 'rules-links');
    for (const id of sources) {
      const item = node('li');
      item.append(link(...data.sources[id]));
      list.append(item);
    }
    if (data.groundfish.species.includes(species.id)) {
      addGroundfish(details,data.groundfish,data,region,tripDate,today,method);
    }
    details.append(species.groups ? group('Official regulatory sources',list) : list);
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
      pending = fetch('./fishing-rules.json?v=301').then(response => {
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
