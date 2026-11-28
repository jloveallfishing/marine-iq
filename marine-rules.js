window.MarineRules = (() => {
  const release = '3.0.0';
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
        /sacramento.san joaquin delta|rio vista|sherman island|delta marina/i.test(trip.name)) return 'delta';
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

  function ruleCard(species, entries, region, tripDate, today, data, favorites) {
    const details = node('details', '', 'rule-card');
    const summary = node('summary', species.name);
    details.append(summary);
    if (species.scientific) details.append(node('p', species.scientific, 'muted'));
    if (species.image) {
      const image = node('img');
      image.src = species.image.url;
      image.alt = species.image.alt;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { image.hidden = true; });
      const credit = node('p', '', 'muted');
      credit.append(link(species.image.credit, species.image.source));
      details.append(image, credit);
    }
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
    for (const [values, historical] of [[restrictions, false], [published, true]]) {
      const rows = node('dl');
      for (const [key, label] of Object.entries(fields)) {
        if (values[key] && (!historical || !restrictions[key])) rows.append(node('dt', label), node('dd', values[key]));
      }
      if (rows.childElementCount) {
        if (historical) details.append(node('h3', 'Published reference · verify before use'));
        details.append(rows);
      }
    }
    if (current.length < regional.length || ['minimum','maximum','bag','possession','season'].some(key => !restrictions[key])) {
      details.append(node('p', 'Unlisted limits or conditions need official confirmation. Check local boundaries and closures.', 'muted'));
    }
    const dates = new Set([...current, ...reference].map(entry => [
        entry.effective && `Effective ${entry.effective}`,
        `Last verified ${entry.verified}`
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
    details.append(list);
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
      const key = JSON.stringify([trip, date, selectedDate, region, select.value, query, favoriteOnly.checked, [...favorites]]);
      if (key === lastRender) return;
      lastRender = key;
      tripLabel.textContent = `${trip.name || 'No fishing location'} · ${selectedDate} (Pacific)`;
      const mismatch = Boolean(suggested && region !== suggested);
      context.classList.toggle('warn', mismatch);
      context.classList.toggle('rule-mismatch', mismatch);
      context.textContent = mismatch
        ? `Region mismatch. Showing ${data.regions[region].label}. The trip location suggests ${data.regions[suggested].label}. Confirm the official boundary.`
        : region ? `${select.value === 'trip' ? 'Suggested' : 'Selected'} region: ${data.regions[region].label}. Confirm the official boundary before fishing.`
        : 'Select a region manually for this location. A map pin alone does not establish jurisdiction.';
      document.getElementById('rules-snapshot').textContent =
        `Snapshot verified ${data.verified} (Pacific). Check current official notices before fishing.`;
      const open = new Set([...cards.querySelectorAll('details[open]')].map(details => details.dataset.species));
      const rows = data.species.filter(species => (!favoriteOnly.checked || favorites.has(species.id)) &&
        [species.name, species.scientific, ...species.aliases].filter(Boolean).some(name => name.toLowerCase().includes(query)));
      cards.replaceChildren(...rows.map(species => {
        const card = ruleCard(species, data.entries[species.id] || [], region, selectedDate, date, data, favorites);
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
      pending = fetch('./fishing-rules.json?v=300').then(response => {
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
