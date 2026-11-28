window.MarineRules = (() => {
  const fields = {
    minimum: 'Minimum size', maximum: 'Maximum size', bag: 'Daily bag limit',
    possession: 'Possession limit', season: 'Season', depth: 'Depth restrictions',
    methods: 'Permitted methods', permits: 'Licenses and permits', special: 'Special restrictions'
  };
  const bayPresets = new Set([0, 1, 3, 8, 9, 10]);
  const regionPreference = 'marinecastRulesRegion';

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

  function ruleCard(species, entries, region, tripDate, today, data) {
    const details = node('details', '', 'rule-card');
    details.append(node('summary', species.name));
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
    const dated = regional.filter(entry => tripDate >= entry.from && tripDate <= entry.through);
    const stale = dated.some(entry => today > entry.reviewBy);
    const current = dated.filter(entry => today >= entry.verified && today <= entry.reviewBy);
    if (!current.length) {
      const message = stale ? 'Outdated summary. Check the official rules before fishing.'
        : 'Rules unavailable for this date or region. Fishing status is unverified.';
      details.append(node('p', message, 'warn'));
    }
    const restrictions = Object.assign({}, ...current.map(entry => entry.rules));
    const values = node('dl');
    for (const [key, label] of Object.entries(fields)) {
      values.append(node('dt', label), node('dd', restrictions[key] || 'Unverified · see official rules'));
    }
    details.append(values);
    const dates = new Set((current.length ? current : regional).map(entry => [
        entry.effective && `Effective ${entry.effective}`,
        `Summary covers ${entry.from} to ${entry.through} (Pacific)`,
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
    const wrapper = node('section');
    wrapper.append(details);
    return wrapper;
  }

  function install({getTrip, today}) {
    const page = document.getElementById('page-rules');
    const select = document.getElementById('rules-region');
    const search = document.getElementById('rules-search');
    const cards = document.getElementById('rules-cards');
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
      const suggested = trip.predefined && bayPresets.has(trip.index) ? 'bay' : '';
      const region = select.value === 'trip' ? suggested : select.value;
      const query = search.value.trim().toLowerCase();
      const key = JSON.stringify([trip, date, region, select.value, query]);
      if (key === lastRender) return;
      lastRender = key;
      tripLabel.textContent = `${trip.name || 'No fishing location'} · ${trip.date || 'No forecast date'} (Pacific)`;
      context.textContent = select.value !== 'trip' ? 'Manual selection. Confirm the official boundary for your fishing spot.'
        : suggested ? 'Suggested region: San Francisco Bay District. Confirm the official boundary before fishing.'
        : 'Select a region manually for this location. A map pin alone does not establish jurisdiction.';
      const open = new Set([...cards.querySelectorAll('details[open] summary')].map(summary => summary.textContent));
      const rows = data.species.filter(species =>
        [species.name, species.scientific, ...species.aliases].filter(Boolean).some(name => name.toLowerCase().includes(query)));
      cards.replaceChildren(...rows.map(species => {
        const card = ruleCard(species, data.entries[species.id] || [], region, trip.date, date, data);
        if (open.has(species.name)) card.querySelector('details').open = true;
        return card;
      }));
      if (!rows.length) cards.append(node('p', 'No matching species. Check the official regional regulations.'));
    }

    function refresh() {
      if (page.hidden) return;
      if (data) { render(); return; }
      if (pending) return;
      cards.setAttribute('aria-busy', 'true');
      cards.textContent = 'Loading regulations…';
      pending = fetch('./fishing-rules.json?v=29').then(response => {
        if (!response.ok) throw Error('Rules download failed');
        return response.json();
      }).then(snapshot => {
        for (const [id, region] of Object.entries(snapshot.regions)) select.add(new Option(region.label, id));
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
